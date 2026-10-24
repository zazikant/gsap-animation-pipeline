/**
 * AI intent mapping — makes the "AI maps w0" stage an actual LLM call.
 *
 * WHY THIS EXISTS (the "same message every time" bug):
 *   The entry stage previously picked the container structure with a static
 *   keyword matcher (selectWidgetProfile in widget-profiles.ts). ANY intent
 *   containing the word "image" routed to the canned gallery profile, so the
 *   preview pane showed the SAME width/breakpoint/notes ("w33 / lg-4 /
 *   Three-column image gallery") regardless of what the user asked for.
 *
 * WHAT THIS MODULE DOES:
 *   Maps the free-form intent onto an Elementor container structure with a
 *   real LLM call, using the ax-translator meta prompt family (semantic
 *   reasoning engine identity → CRITICAL OUTPUT RULES → output contract).
 *   The LLM returns a full WidgetProfile-shaped mapping (widgetType, width,
 *   breakpoint, notes, selectors, treeTemplate, repeats) tailored to the
 *   intent. selectWidgetProfile() remains as the deterministic fallback when
 *   the mapping call or its parse fails — the pipeline never hard-fails on
 *   mapping.
 */

import { z } from 'zod';
import { parseLLMJson } from './ax-quality';
import { validateTree } from './elementor-schema';
import type { WidgetProfile } from './widget-profiles';

// ─── Mapping budget ──────────────────────────────────────────────────────────
// The mapping response is small structured JSON (~300-600 tokens). A tight
// max_tokens keeps the reasoning model from burning the budget on long
// reasoning_content before the JSON starts — keeps the map stage fast so
// the generate stage still fits the route budget.

export const MAPPING_MAX_TOKENS = 1024;
export const MAPPING_TEMPERATURE = 0.1;

// ─── System prompts (ax-translator meta prompt family) ──────────────────────
// Same structure as TRANSLATE_SYSTEM_PROMPT: semantic reasoning engine
// identity → what we do NOT do → what we surface / infer → faithful-intent
// quality bar → CRITICAL OUTPUT RULES (+ domain output contract).

export const MAPPING_SYSTEM_PROMPT = `You are a semantic reasoning engine specialized in mapping free-form animation intents onto Elementor widget structures.
You do NOT merely match keywords — you REASON through the layout space of the user's intent.
You surface implicit structure the requester already knows but didn't articulate.
You infer missing containers, bridge gaps, and make hidden hierarchy relationships explicit.
You follow the layout described in the intent faithfully.

CRITICAL OUTPUT RULES:
- Output ONLY the JSON mapping in one fenced json block. No prose outside the fence, no explanation, no meta-commentary.
- Match the described layout exactly — two side-by-side panels means a flex-row root with two children, not a grid of images.
- Do NOT default to a familiar widget when the intent describes a different structure.
- One-off elements (root container, single panels) use id; repeating siblings (slides, cards, items) share ONE className and appear ONCE in the tree. Never both id and className on the same node.
- All ids and classNames are kebab-case and unique (ids) within the tree.
- Be CONCISE in notes — one or two sentences describing the mapped structure.

OUTPUT CONTRACT — produce ONE fenced json block:

\`\`\`json
{
  "widgetType": "kebab-case-name",
  "width": "w100",
  "breakpoint": "lg-1",
  "notes": "One or two sentences describing the mapped container structure.",
  "selectors": ["#root-id", "#root-id .child-class"],
  "treeTemplate": {"id": "root-id", "kind": "Container", "label": "Root", "layout": "flex row", "children": []},
  "repeats": []
}
\`\`\`

FIELD REQUIREMENTS:
- widgetType: short kebab-case name for the mapped structure (e.g. "split-showcase", "testimonial", "hero-slider").
- width: container width class (w25 / w33 / w50 / w66 / w100 as used by the site grid).
- breakpoint: column breakpoint token (lg-1 … lg-5) consistent with the width.
- notes: describes the ACTUAL mapped layout, not a generic widget blurb.
- selectors: 3-6 CSS selectors the GSAP code will query, root container first, derived from the tree's ids/classNames.
- treeTemplate: the recursive Elementor widget tree for THIS intent. Kinds: Container, Image, Heading, Text, Button, Icon, Divider. Root must be a Container with at least one child; every leaf carries a props object (Image → src, Text/Heading → text, Button → label). Depth ≤ 6.
- repeats: ONLY when the layout has repeating siblings — [{"parentKey": "<parent id or className>", "parentIsId": true, "childClassName": "<shared class>", "defaultCount": <1-24>, "label": "<singular noun>"}]. Empty array otherwise.

That's it. Map the user's intent into the container structure it describes.`;

// ax-translator retry meta prompt structure (TRANSLATE_RETRY_SYSTEM_PROMPT):
// same identity + "previous attempt did not … properly" → CRITICAL must-do →
// tightened rules.

export const MAPPING_RETRY_SYSTEM_PROMPT = `You are a semantic reasoning engine specialized in mapping animation intents onto Elementor widget structures. The previous attempt did not produce a valid mapping.

CRITICAL: You MUST output the complete JSON mapping — do NOT echo the previous attempt unchanged.

CRITICAL OUTPUT RULES:
- Output ONLY the JSON mapping in one fenced json block. No prose outside the fence, no meta-commentary.
- The object MUST contain: widgetType, width, breakpoint, notes, selectors (non-empty array), treeTemplate, repeats.
- treeTemplate root must be a Container with at least one child; every node has id or className (kebab-case, never both); leaves carry props (Image → src, Text/Heading → text, Button → label).
- That's it. Map the user's intent into the container structure it describes.`;

// ─── User prompt builder ─────────────────────────────────────────────────────

export function buildMappingUserPrompt(intent: string): string {
  const trimmed = intent.trim().length > 4000 ? `${intent.trim().slice(0, 4000)}… (intent truncated)` : intent.trim();
  return `Intent: ${trimmed}

Map this intent onto the Elementor container structure it describes. Output ONLY the JSON mapping per the output contract.`;
}

// ─── Response schema + parser ────────────────────────────────────────────────

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;

const RepeatSchema = z.object({
  parentKey: z.string().min(2).max(64),
  parentIsId: z.boolean().default(true),
  childClassName: z.string().min(2).max(64).regex(KEBAB_RE, 'childClassName must be kebab-case'),
  defaultCount: z.number().int().min(1).max(24),
  label: z.string().min(1).max(40),
});

const RawMappingSchema = z.object({
  widgetType: z.string().min(2).max(64).default('custom-layout'),
  width: z.string().min(1).max(16).default('w100'),
  breakpoint: z.string().min(1).max(16).default('lg-1'),
  notes: z.string().min(1).max(400),
  // Optional — derived from the tree root when the model omits it.
  selectors: z.array(z.string().min(1).max(200)).max(8).default([]),
  treeTemplate: z.unknown(),
  repeats: z.array(RepeatSchema).max(4).default([]),
  strategy: z.string().max(400).optional(),
});

export interface IntentMappingResult {
  profile: WidgetProfile;
  /** One-line strategy derived from the intent (used for the preview pane). */
  strategy: string | null;
}

/**
 * Parse + validate a mapping LLM response into a WidgetProfile.
 * Throws Error with a short reason when the response is unusable — the
 * caller decides whether to retry (isRetry pattern) or fall back to the
 * keyword matcher.
 */
export function parseMappingResponse(raw: string): IntentMappingResult {
  const json = parseLLMJson<Record<string, unknown>>(raw);

  const parsed = RawMappingSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${(i.path as Array<string | number>).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Mapping schema invalid — ${issues}`);
  }
  const m = parsed.data;

  // The tree must pass the full Elementor widget validation (zod + shape).
  const treeCheck = validateTree(m.treeTemplate);
  if (!treeCheck.ok) {
    throw new Error(`Mapping tree invalid — ${treeCheck.issues.slice(0, 3).join('; ')}`);
  }

  const root = treeCheck.tree;
  // Root selector from the tree, in case selectors came back empty/garbage.
  const rootSelector = root.id ? `#${root.id}` : root.className ? `.${root.className}` : '';
  const selectors = m.selectors.length > 0 ? m.selectors : rootSelector ? [rootSelector] : [];
  if (selectors.length === 0) {
    throw new Error('Mapping has no usable selectors');
  }

  const profile: WidgetProfile = {
    widgetType: m.widgetType.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64) || 'custom-layout',
    width: m.width.trim().slice(0, 16),
    breakpoint: m.breakpoint.trim().slice(0, 16),
    notes: m.notes.trim(),
    selectors,
    treeTemplate: root,
    ...(m.repeats.length > 0 ? { repeats: m.repeats.map((r) => ({ ...r })) } : {}),
  };

  return { profile, strategy: m.strategy?.trim() || null };
}
