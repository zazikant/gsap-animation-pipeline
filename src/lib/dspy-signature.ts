/**
 * AX/DSPy-style declarative signature for the GSAP animation generator.
 *
 * DSPy and AX (the Axolotl/Pydantic-adjacent framework from the same
 * ecosystem) frame LM calls as **Signatures** — typed input → output
 * contracts — wrapped by a `Predict` module that bundles a prompt template,
 * an adapter (output parser), and assertions (hard constraints that
 * trigger retries with structured feedback).
 *
 * This file implements that pattern without taking on the full framework:
 *
 *   - `AnimationSignature`    — the input/output contract (interfaces).
 *   - `ANIMATION_SYSTEM_PROMPT` — the *compiled* system prompt refined
 *     across the 5 recovery iterations recorded in RECOVERY.md. This is
 *     the artifact a DSPy `BootstrapFewShot` compile step would produce.
 *   - `parsePrediction`        — the adapter. Handles three response
 *     shapes the LLM tends to produce:
 *       1. JSON-only` — `{"gsapCode": "...", "containerTree": {...}}`
 *       2. `Code block + JSON block` — ```js ... ``` followed by ```json {...} ```
 *       3. `Free prose + code + JSON` — narrative wrapping, with the
 *          code and JSON block somewhere inside.
 *   - `predictAnimation`       — the Predict module. Calls the LM, parses
 *     the response, runs assertions, and either returns a clean prediction
 *     or throws `AnimationSignatureError` with feedback the retry node can
 *     feed back into the next prompt.
 *
 * Why this lives in its own module:
 *   - Keeps `pipeline-graph.ts` focused on flow control.
 *   - Makes the signature easy to unit-test (`parsePrediction` is pure).
 *   - Future work: replace the hard-coded prompt with a programmatic
 *     compiler (BootstrapFewShot, MIPRO) that reads from a labelled
 *     examples store. The signature + adapter boundary is already in
 *     place for that swap.
 */

import type { ElementorWidget, ElementorWidgetValidated } from './elementor-widget';
import { validateTree, maxDepth, countByKind } from './elementor-schema';
import type { WidgetProfile } from './widget-profiles';

// ─── Signature contract ──────────────────────────────────────────────────────

export interface AnimationSignatureInput {
  intent: string;
  widgetProfile: WidgetProfile;
  /** Previous code from a failed attempt — included when retrying. */
  previousCode?: string;
  /** Previous tree JSON (string) from a failed attempt — included when retrying. */
  previousTreeJson?: string;
  /** Issues from the previous validateNode — included when retrying. */
  validationIssues?: string[];
}

export interface AnimationSignatureOutput {
  gsapCode: string;
  containerTree: ElementorWidgetValidated;
}

export interface AnimationPrediction extends AnimationSignatureOutput {
  rawResponse: string;
  parseWarnings: string[];
  tokenEstimate: number;
}

// ─── Hard assertions ─────────────────────────────────────────────────────────

export class AnimationSignatureError extends Error {
  readonly issues: string[];
  readonly recoverable: boolean;
  constructor(issues: string[], recoverable: boolean) {
    super(`AnimationSignature assertion failed: ${issues.join('; ')}`);
    this.name = 'AnimationSignatureError';
    this.issues = issues;
    this.recoverable = recoverable;
  }
}

// ─── Compiled system prompt (refined over 5 iterations) ──────────────────────

export const ANIMATION_SYSTEM_PROMPT = `You are an expert GSAP animator writing code for Elementor-built WordPress sites.

OUTPUT CONTRACT (this is a structured-output task — adhere strictly):
1. Produce TWO things in ONE response: (a) executable JavaScript code for the animation, and (b) a JSON document describing the recursive Elementor widget tree the code targets.
2. The code and the tree JSON must be wrapped in their own markdown fences:

   \`\`\`js
   // your gsap code here, wrapped in (function initAnimation(){ ... })();
   \`\`\`

   \`\`\`json
   {"containerTree": { "id": "...", "kind": "Container", "label": "...", "children": [ ... ] }}
   \`\`\`

   Or — if the model supports it — a single JSON envelope:
   \`\`\`json
   {"gsapCode": "...", "containerTree": { ... }}
   \`\`\`

   Either shape is accepted. Do not output prose outside the fences.

CODE REQUIREMENTS:
- Wrap your code in: (function initAnimation(){ <your code here> })();
- Load GSAP + ScrollTrigger dynamically from https://cdn.jsdelivr.net/npm/gsap@3.13/dist/ if not already on the page. ONE CDN (jsdelivr). No multi-CDN.
- Handle the dynamic script load with an onerror callback that logs to console.
- Use \`gsap.context(() => { ... })\` so animations can be reverted via the context's \`.revert()\` API.
- Handle window resize with ScrollTrigger.refresh() or kill+rebuild triggers.
- The selectors you target must match the widget profile's selectors EXACTLY (provided in the user message).
- Match the user's described behavior — if they ask for a CAROUSEL, implement slide navigation (prev/next, autoplay, transition between slides), NOT just a one-time reveal.

TREE JSON REQUIREMENTS:
- The tree root MUST be a Container whose \`id\` matches the widget profile's primary selector (e.g. \`testimonial-swiper\`, \`hero-section\`, \`cards-grid\`).
- Use the widget profile's \`treeTemplate\` as the structural skeleton — same parent/child shape, same leaf kinds, same field names.
- For repeating containers (slides, cards, pricing columns, dots), emit one entry per repeat with a numeric suffix on the id: \`testimonial-slide-1\`, \`testimonial-slide-2\`, etc. Use \`inferRepeatCount\` (intent) for how many; falls back to the profile's default.
- Every leaf node MUST have a \`props\` object with placeholder values. Image nodes need \`props.src\`. Text/Heading need \`props.text\`. Button needs \`props.label\` (and \`props.href\` when relevant).
- All ids MUST be unique within the tree. Use kebab-case (lowercase letters, digits, hyphens) only.
- Layout hints (in \`layout\` field) when obvious: "flex row", "flex column", "absolute scrim", "relative". Optional but encouraged.
- State flags (in \`state\` field) when obvious: carousel dots need \`{ "active": false }\` (one of them gets \`{ "active": true }\`), a progress label needs \`{ "current": 1, "total": 4 }\`.

ANTI-PATTERNS (these will fail validation):
- Loading GSAP from multiple CDNs in the same code block.
- Missing onerror handler on a dynamic <script> injection.
- Tree nodes whose \`kind\` is "Container" but have zero children.
- Tree nodes whose \`kind\` is "Image"/"Heading"/"Text"/"Button"/"Icon"/"Divider" but have children.
- Tree ids that aren't kebab-case.
- Tree ids that duplicate another id in the same tree.
- Selectors in the code that don't match the widget profile.`;

// ─── User-prompt builder ─────────────────────────────────────────────────────

export function buildUserPrompt(input: AnimationSignatureInput): string {
  const { intent, widgetProfile, previousCode, previousTreeJson, validationIssues } = input;
  const repeatSection = (widgetProfile.repeats ?? [])
    .map((r) => {
      const count = inferRepeatCountFromIntent(intent, r.defaultCount);
      return `Repeat ${r.childIdPrefix} × ${count} inside ${r.parentId}. Each instance has structure:
${JSON.stringify(r.child, null, 2)}`;
    })
    .join('\n\n');

  const profileJson = JSON.stringify(widgetProfile.treeTemplate, null, 2);

  const basePrompt = `Intent: ${intent}

Target widget: ${widgetProfile.widgetType}
Container selector: ${widgetProfile.selectors[0]}
All widget selectors (priority order):
${widgetProfile.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

Canonical tree template (instance of this structure — fill in props + repeats):
${profileJson}

${repeatSection ? `\nRepeats to emit:\n${repeatSection}\n` : ''}
Requirements:
- Animation must match the described behavior (carousel = slide nav + autoplay, not just reveal).
- Use the container selector exactly as given.
- Wrap code in: (function initAnimation() { /* code */ })();
- Load GSAP from https://cdn.jsdelivr.net/npm/gsap@3.13/dist/gsap.min.js if not present.
- Load ScrollTrigger from the same CDN if you use it.
- Handle window resize: ScrollTrigger.refresh().
- Use gsap.context() for cleanup.
- Emit the containerTree as JSON in a \`\`\`json fence after the code fence.

Output ONLY the two fences (code then JSON). No prose outside the fences.`;

  if (previousCode && validationIssues && validationIssues.length > 0) {
    return `${basePrompt}

PREVIOUS ATTEMPT — code:
\`\`\`js
${previousCode}
\`\`\`

${previousTreeJson ? `PREVIOUS ATTEMPT — tree JSON:
\`\`\`json
${previousTreeJson}
\`\`\`
` : ''}ISSUES TO FIX:
${validationIssues.map((i) => `• ${i}`).join('\n')}

Address ALL listed issues. Re-emit BOTH the code fence and the JSON fence.`;
  }
  return basePrompt;
}

// Local copy of the intent-word-to-number mapper (kept private so we don't
// change the widget-profiles.ts public surface).
function inferRepeatCountFromIntent(intent: string, defaultCount: number): number {
  const lc = intent.toLowerCase();
  const digit = lc.match(/\b(\d{1,2})\b/);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (n >= 1 && n <= 24) return n;
  }
  const wordToN: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10,
  };
  for (const [w, n] of Object.entries(wordToN)) {
    if (lc.includes(`${w} `) || lc.includes(`${w}-`) || lc.endsWith(w)) return n;
  }
  return defaultCount;
}

// ─── Adapter (output parser) ─────────────────────────────────────────────────

interface Extracted {
  code: string | null;
  treeJsonText: string | null;
}

function extractFences(text: string): Array<{ lang: string; body: string }> {
  const out: Array<{ lang: string; body: string }> = [];
  const re = /```([a-zA-Z0-9_+\-#]*)?[ \t]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ lang: (m[1] ?? '').toLowerCase().trim(), body: m[2] });
  }
  return out;
}

function findBareJsonObject(text: string): string | null {
  // Find first balanced top-level {...} candidate.
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return text.substring(start, i + 1);
      }
    }
  }
  return null;
}

export function extractCodeAndTree(raw: string): Extracted {
  if (!raw) return { code: null, treeJsonText: null };
  const fences = extractFences(raw);

  let code: string | null = null;
  let treeJsonText: string | null = null;

  for (const f of fences) {
    if (!code && (f.lang === 'js' || f.lang === 'javascript' || f.lang === 'ts' || f.lang === 'typescript' || f.lang === '')) {
      code = f.body.trim();
      continue;
    }
    if (!treeJsonText && (f.lang === 'json' || f.lang === '')) {
      treeJsonText = f.body.trim();
    }
  }

  // Fallback: single JSON envelope { "gsapCode": "...", "containerTree": ... }
  if (!code || !treeJsonText) {
    const bare = findBareJsonObject(raw);
    if (bare) {
      try {
        const parsed = JSON.parse(bare);
        if (parsed && typeof parsed === 'object') {
          if (!code && typeof parsed.gsapCode === 'string') code = parsed.gsapCode;
          if (!treeJsonText && parsed.containerTree) {
            treeJsonText = JSON.stringify(parsed.containerTree);
          }
        }
      } catch {
        // Ignore — fall through to warnings.
      }
    }
  }

  return { code, treeJsonText };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

interface AssertionResult {
  ok: boolean;
  issues: string[];
}

function assertTreeShape(tree: ElementorWidgetValidated, profile: WidgetProfile): AssertionResult {
  const issues: string[] = [];
  if (tree.kind !== 'Container') {
    issues.push(`Tree root must be a Container, got "${tree.kind}"`);
  }
  if (!tree.children || tree.children.length === 0) {
    issues.push('Tree root must have at least one child');
  }
  // The root id should be the profile's primary id.
  const expectedRoot = profile.treeTemplate.id;
  if (tree.id !== expectedRoot) {
    issues.push(`Tree root id should be "${expectedRoot}", got "${tree.id}"`);
  }
  // Depth check — no tree should exceed 6 levels.
  const depth = maxDepth(tree);
  if (depth > 6) {
    issues.push(`Tree is too deep (${depth} levels) — max 6`);
  }
  // Container count sanity: at least 1 container, at least one leaf.
  const counts = countByKind(tree);
  if (!counts.Container) issues.push('Tree must contain at least one Container node');
  if (!counts.Image && !counts.Heading && !counts.Text) {
    issues.push('Tree must contain at least one Image/Heading/Text leaf');
  }
  return { ok: issues.length === 0, issues };
}

function assertCodeShape(code: string | null): AssertionResult {
  const issues: string[] = [];
  if (!code) {
    issues.push('No JavaScript code found in the response');
    return { ok: false, issues };
  }
  if (!/gsap\./.test(code)) issues.push('Code does not contain any gsap.* call');
  if (code.length < 80) issues.push(`Code is suspiciously short (${code.length} chars)`);
  return { ok: issues.length === 0, issues };
}

// ─── Predict module ──────────────────────────────────────────────────────────

export interface ParseOptions {
  /** When true, tree-shape issues throw AnimationSignatureError (caller decides). */
  strictTree?: boolean;
  /** When true, code-shape issues throw AnimationSignatureError. */
  strictCode?: boolean;
}

export function parsePrediction(
  raw: string,
  profile: WidgetProfile,
  options: ParseOptions = { strictTree: true, strictCode: true },
): { prediction: AnimationPrediction; treeIssues: string[]; codeIssues: string[] } {
  const warnings: string[] = [];
  const { code, treeJsonText } = extractCodeAndTree(raw);

  let tree: ElementorWidgetValidated | null = null;
  let treeIssues: string[] = [];
  if (treeJsonText) {
    let parsedJson: unknown = null;
    try {
      parsedJson = JSON.parse(treeJsonText);
    } catch (e) {
      treeIssues.push(`Tree JSON could not be parsed: ${(e as Error).message}`);
    }
    if (parsedJson) {
      // Allow { containerTree: {...} } or a bare widget object.
      const candidate =
        parsedJson && typeof parsedJson === 'object' && 'containerTree' in (parsedJson as object)
          ? (parsedJson as { containerTree: unknown }).containerTree
          : parsedJson;
      const result = validateTree(candidate);
      if (result.ok) {
        tree = result.tree;
        const shape = assertTreeShape(tree, profile);
        if (!shape.ok) treeIssues.push(...shape.issues);
      } else {
        treeIssues.push(...result.issues);
      }
    }
  } else {
    treeIssues.push('No tree JSON block found in the response');
  }

  const codeCheck = assertCodeShape(code);

  if (!code) warnings.push('No code block extracted');
  if (!tree) warnings.push('No valid tree extracted');

  const allIssues = [...treeIssues, ...codeCheck.issues];
  const shouldThrow =
    (options.strictTree && treeIssues.length > 0) ||
    (options.strictCode && !codeCheck.ok);

  const prediction: AnimationPrediction = {
    gsapCode: code ?? '',
    containerTree: tree ?? profile.treeTemplate as ElementorWidgetValidated,
    rawResponse: raw,
    parseWarnings: warnings,
    tokenEstimate: Math.ceil(raw.length / 4),
  };

  if (shouldThrow) {
    throw new AnimationSignatureError(allIssues, /* recoverable */ true);
  }
  return { prediction, treeIssues, codeIssues: codeCheck.issues };
}

export async function predictAnimation(
  input: AnimationSignatureInput,
  llmCall: (system: string, user: string) => Promise<string>,
): Promise<AnimationPrediction> {
  const system = ANIMATION_SYSTEM_PROMPT;
  const user = buildUserPrompt(input);
  const raw = await llmCall(system, user);
  const { prediction } = parsePrediction(raw, input.widgetProfile);
  return prediction;
}

// ─── Telemetry-friendly exports ──────────────────────────────────────────────

export function summarisePrediction(pred: AnimationPrediction): string {
  const counts = countByKind(pred.containerTree);
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  return `code=${pred.gsapCode.length}c tree=${parts.join(',')} (${maxDepth(pred.containerTree)} deep)`;
}