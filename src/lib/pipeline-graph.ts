/**
 * LangGraph StateGraph for the GSAP generation pipeline.
 *
 * Real StateGraph with conditional retry edges, not just a sequential for-loop
 * with cosmetic `lg1-lg5` labels.
 *
 * Flow (single direct pass — validate stage removed, as in ax-translator):
 *
 *   entryNode
 *     ↓
 *   generateNode          ← single LLM call (Nvidia 20B / OpenCode GLM 5.3), temp 0.3
 *     ↓
 *   parseGsapNode         ← strip fences, normalize IIFE; extract tree JSON
 *     ↓                    (parseLLMJson + truncation recovery from the Bible)
 *   outputNode            ← terminal; static sanity checks (code rules +
 *                           signature assertions + code↔tree cross-validation)
 *                           populate the GenerateResponse validation field
 *
 * Each node emits SSE events (stage-start / log / stage-end) so the UI shows
 * live progress. Between LLM nodes we insert the adaptive cooldown from
 * lib/rate-limit.ts so NVIDIA's 429 window has time to recover.
 */

import { StateGraph, END, Annotation } from '@langchain/langgraph';
import { callUnifiedLLM } from './llm-client';
import { type ModelId, getModelConfig } from './models';
import { decideCooldown, cooldownWithCountdown } from './rate-limit';
import {
  selectWidgetProfile,
  type WidgetProfile,
} from './widget-profiles';
import { stripCodeFences, normalizeGsapCode, validateGsapCode, validateCodeAgainstTree } from './gsap-utils';
import { newOpencodeSessionId } from './opencode-client';
import type { GenerateResponse, ElementorContainer } from './generate-pipeline';
import type { ElementorWidgetValidated } from './elementor-widget';
import {
  buildUserPrompt,
  parsePrediction,
  extractCodeAndTree,
  AnimationSignatureError,
  ANIMATION_SYSTEM_PROMPT,
  type AnimationPrediction,
} from './dspy-signature';
import {
  getStageTemperature,
  parseLLMJson,
  recoverTruncatedJSON,
  callWithRetryAwareness,
  VALIDATION_THRESHOLD,
  type ErrorEntry,
} from './ax-quality';

// ─── State shape ─────────────────────────────────────────────────────────────

export interface PipelineState {
  intent: string;
  presetId?: string;
  modelId: ModelId;
  apiKey: string;
  /** Active widget profile selected from intent keywords */
  widgetProfile: WidgetProfile | null;
  /** Raw code from the LLM (un-normalized) */
  rawCode: string;
  /** Raw tree JSON string from the LLM (un-validated) */
  rawTreeJson: string;
  /** Normalized code (stripped fences, IIFE wrappers unwrapped) */
  gsapCode: string;
  /** Validated tree (Zod-parsed + shape-asserted) */
  containerTree: ElementorWidgetValidated | null;
  /** Issues found by the static sanity checks (see outputNode) */
  validationIssues: string[];
  /** Validation pass/fail */
  isValid: boolean;
  /** Legacy channel from the removed AX validate stage — never set now */
  llmScore: number;
  /** Final 0-100 quality score attached to GenerateResponse (Bible score × 100) */
  qualityScore: number;
  /** DSPy error history — every failed LLM call (Bible callWithRetryAwareness) */
  errorHistory: ErrorEntry[];
  /** Legacy channel from the removed retry stage — never set now */
  refineContext: string;
  /** Total LLM calls so far (translate retry → generate cycles) */
  attempts: number;
  /** Max retries before forcing output with current best */
  maxAttempts: number;
  /**
   * Stable per-run OpenCode session ID. Minted once when the run starts and
   * reused for every LLM call so retries hit the same gateway prompt-cache
   * slot. Only meaningful for the OpenCode provider; NVIDIA ignores it.
   */
  sessionId: string;
  /** Conversation history for the LangGraph "thinking" trace */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Append-only log lines for the UI */
  stageTrace: string[];
  /** Final container metadata (filled by entryNode + outputNode) */
  container: ElementorContainer | null;
  /** Final result (filled by outputNode) */
  result: GenerateResponse | null;
  /** Error message if pipeline failed */
  error: string | null;
}

export interface PipelineEvent {
  type:
    | 'stage-start'
    | 'stage-end'
    | 'log'
    | 'countdown'
    | 'pipeline-end'
    | 'error'
    | 'chunk'
    | 'progress';
  ts: number;
  [key: string]: unknown;
}

export interface RunOptions {
  intent: string;
  presetId?: string;
  apiKey: string;
  modelId: ModelId;
  emit: (e: PipelineEvent) => void;
}

// ─── Annotation for the StateGraph ────────────────────────────────────────────

const PipelineAnnotation = Annotation.Root({
  intent: Annotation<string>(),
  presetId: Annotation<string | undefined>(),
  modelId: Annotation<ModelId>(),
  apiKey: Annotation<string>(),
  widgetProfile: Annotation<WidgetProfile | null>(),
  rawCode: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  rawTreeJson: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  gsapCode: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  containerTree: Annotation<ElementorWidgetValidated | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  validationIssues: Annotation<string[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  isValid: Annotation<boolean>({
    reducer: (_x, y) => y,
    default: () => false,
  }),
  llmScore: Annotation<number>({
    reducer: (_x, y) => y,
    default: () => 0,
  }),
  qualityScore: Annotation<number>({
    reducer: (_x, y) => y,
    default: () => 0,
  }),
  errorHistory: Annotation<ErrorEntry[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  refineContext: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  attempts: Annotation<number>({
    reducer: (x, y) => y,
    default: () => 0,
  }),
  maxAttempts: Annotation<number>({
    reducer: (_x, y) => y,
    default: () => 3,
  }),
  sessionId: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  messages: Annotation<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  stageTrace: Annotation<string[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  container: Annotation<ElementorContainer | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  result: Annotation<GenerateResponse | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
  error: Annotation<string | null>({
    reducer: (_x, y) => y,
    default: () => null,
  }),
});

// ─── Node helpers ────────────────────────────────────────────────────────────

interface NodeCtx {
  emit: (e: PipelineEvent) => void;
  log: (line: string) => void;
}

function makeNodeHelpers(emit: (e: PipelineEvent) => void): NodeCtx {
  return {
    emit,
    log: (line) => {
      emit({ type: 'log', ts: Date.now(), line });
    },
  };
}

async function runCooldown(
  ctx: NodeCtx,
  _totalSec: number,
  reason: string,
  multiplier: number,
): Promise<void> {
  // decideCooldown returns delaySec=0 to mean "skip cooldown entirely"
  // (used for fast providers like OpenCode). Treat 0 as a meaningful
  // sentinel — DON'T fall back to totalSec on 0, only on undefined.
  // The earlier `delaySec > 0 ? delaySec : totalSec` swallowed 0 and
  // gave OpenCode a 30s cooldown instead of skipping.
  const decision = decideCooldown({
    attempts: 1,
    succeeded: true,
    cooldownMultiplier: multiplier,
  });
  const sec = typeof decision.delaySec === 'number' ? decision.delaySec : 0;
  if (sec <= 0) return;
  ctx.log(`[pipeline] cooldown ${sec}s — ${reason}`);
  await cooldownWithCountdown(sec, (remaining) => {
    ctx.emit({
      type: 'countdown',
      ts: Date.now(),
      remainingSec: remaining,
      totalSec: sec,
      reason: 'rate-limit',
    });
  });
  ctx.log(`[pipeline] cooldown complete`);
}

// ─── Node 1: entryNode ────────────────────────────────────────────────────────

async function entryNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'entry',
    name: 'Entry Node',
    description: 'Parsing intent & container map',
  });
  const profile = selectWidgetProfile(state.intent);
  const container: ElementorContainer = {
    selector: profile.selectors[0],
    width: profile.width,
    breakpoint: profile.breakpoint,
    notes: profile.notes,
  };
  ctx.log(`[entry] widget=${profile.widgetType} width=${profile.width} @ ${profile.breakpoint}`);
  ctx.log(`[entry] selectors: ${profile.selectors.length} prepared`);
  ctx.log(
    `[entry] tree template: root=${profile.treeTemplate.id} ${(profile.repeats ?? []).length} repeat group(s)`,
  );
  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'entry', ok: true });
  return { widgetProfile: profile, container, stageTrace: [`entry → widget=${profile.widgetType}`] };
}

// ─── Node 2: generateNode ─────────────────────────────────────────────────────

async function generateNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'generate',
    name: 'Code + Tree Generation',
    description: `Calling LLM (attempt ${state.attempts + 1}/${state.maxAttempts})`,
  });

  const profile = state.widgetProfile!;
  ctx.log(`[generate] attempt ${state.attempts + 1}/${state.maxAttempts}`);

  const userPrompt = buildUserPrompt({
    intent: state.intent,
    widgetProfile: profile,
  });

  // Single-pass generation — no refine/retry stage (validate machinery
  // removed, as in ax-translator).
  const systemPrompt = ANIMATION_SYSTEM_PROMPT;
  const temperature = getStageTemperature('generate');

  // Always bump the attempt counter — even on error — for the attempt log.
  const nextAttempt = state.attempts + 1;

  // Surface the session ID in the log so retries in the UI confirm they're
  // hitting the same gateway cache slot.
  if (state.sessionId) {
    ctx.log(`[generate] session=${state.sessionId}`);
  }

  let code = '';
  // Working copy of the error history — callWithRetryAwareness mutates it
  // (Bible pattern); returned in the state update below.
  const errorHistory = [...state.errorHistory];
  try {
    code = await callWithRetryAwareness(
      () =>
        callUnifiedLLM(
          systemPrompt,
          userPrompt,
          state.modelId,
          state.apiKey,
          undefined,
          temperature,
          (line) => ctx.emit({ type: 'log', ts: Date.now(), line: `[generate] ${line}` }),
          (chunk) => ctx.emit({ type: 'chunk', ts: Date.now(), text: chunk }),
          state.sessionId,
        ),
      errorHistory,
      nextAttempt,
      'Generate',
      'generate',
      (line) => ctx.log(line),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[generate] LLM call failed: ${msg.slice(0, 200)}`);
    ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'generate', ok: false, error: msg });
    // Increment attempts even on error so the attempt count stays accurate.
    return { error: msg, attempts: nextAttempt, rawCode: state.rawCode, rawTreeJson: state.rawTreeJson, errorHistory };
  }

  ctx.log(`[generate] received ${code.length} chars (temperature=${temperature})`);
  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'generate', ok: true });

  return {
    rawCode: code,
    rawTreeJson: code, // mirror; parseGsapNode re-extracts both pieces
    attempts: nextAttempt,
    errorHistory,
    messages: [
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: code },
    ],
    stageTrace: [`generate → ${code.length} chars (attempt ${nextAttempt})`],
  };
}

// ─── Node 3: parseGsapNode ───────────────────────────────────────────────────

async function parseGsapNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'parse',
    name: 'GSAP + Tree Parser',
    description: 'Stripping fences + normalizing IIFE + extracting tree JSON',
  });

  // Adapter from dspy-signature.ts handles the code-fence + JSON-fence extraction.
  const extracted = extractCodeAndTree(state.rawCode);
  const stripped = extracted.code ? stripCodeFences(extracted.code) : '';
  const normalized = normalizeGsapCode(stripped);
  ctx.log(`[parse] raw response: ${state.rawCode.length} chars`);
  ctx.log(`[parse] extracted code: ${extracted.code?.length ?? 0} chars, tree JSON: ${extracted.treeJsonText?.length ?? 0} chars`);
  ctx.log(`[parse] normalized code: ${normalized.length} chars`);

  // Best-effort tree parse here. Static sanity checks run in outputNode to
  // populate the validation field. Parsing uses the Bible's robust
  // chain: JSON.parse → parseLLMJson (fences/balanced-bracket) →
  // recoverTruncatedJSON (closes open brackets / salvage fields).
  let containerTree: ElementorWidgetValidated | null = null;
  if (extracted.treeJsonText) {
    try {
      let candidate: unknown = null;
      let parseStrategy = 'direct';
      try {
        candidate = JSON.parse(extracted.treeJsonText);
      } catch {
        try {
          candidate = parseLLMJson<unknown>(extracted.treeJsonText);
          parseStrategy = 'parseLLMJson';
        } catch {
          const recovered = recoverTruncatedJSON<Record<string, unknown>>(extracted.treeJsonText);
          if (recovered) {
            candidate = recovered;
            parseStrategy = 'recoverTruncatedJSON';
          }
        }
      }
      if (candidate && typeof candidate === 'object') {
        const root = 'containerTree' in (candidate as object)
          ? (candidate as { containerTree: unknown }).containerTree
          : candidate;
        ctx.log(`[parse] tree JSON parsed via ${parseStrategy}`);
        // Lazy import to avoid a circular dependency in tests.
        const { validateTree } = await import('./elementor-schema');
        const v = validateTree(root);
        if (v.ok) containerTree = v.tree;
      }
    } catch {
      // Swallow — outputNode static checks will produce a clear issue.
    }
  }

  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'parse', ok: true });
  return {
    gsapCode: normalized,
    containerTree,
    rawTreeJson: extracted.treeJsonText ?? '',
    stageTrace: [`parse → ${normalized.length} chars, tree=${containerTree ? 'ok' : 'pending'}`],
  };
}

// ─── Node 6: outputNode ───────────────────────────────────────────────────────

async function outputNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'output',
    name: 'Output',
    description: 'Packaging validated code + tree into GenerateResponse',
  });

  // Static sanity checks — no LLM validation stage (validate machinery
  // removed, as in ax-translator): code rules + signature assertions +
  // code↔tree cross-validation populate the GenerateResponse validation
  // field. The 0.75 threshold is the Bible's, applied to the static score.
  const staticResult = validateGsapCode(state.gsapCode, state.widgetProfile);
  const signatureIssues: string[] = [];
  if (!state.containerTree) {
    signatureIssues.push('Tree JSON is missing or failed Zod validation');
  }
  try {
    parsePrediction(state.rawCode, state.widgetProfile!, {
      strictTree: false,
      strictCode: false,
    });
  } catch (err) {
    if (err instanceof AnimationSignatureError) {
      signatureIssues.push(...err.issues);
    } else if (err instanceof Error) {
      signatureIssues.push(err.message);
    }
  }
  const cross = validateCodeAgainstTree(state.gsapCode, state.containerTree, state.widgetProfile);
  const allIssues = [...staticResult.issues, ...signatureIssues, ...cross.issues];
  const deduction = Math.min(100, allIssues.length * 12);
  const finalScore = Math.max(0, 100 - deduction) / 100;
  const qualityScore = Math.round(finalScore * 100);
  const isValid = finalScore >= VALIDATION_THRESHOLD && signatureIssues.length === 0 && cross.isValid;
  ctx.log(
    `[output] static checks: code=${staticResult.qualityScore} sig=${signatureIssues.length} cross=${cross.issues.length} → ${isValid ? 'PASS' : 'ISSUES'} (score=${qualityScore})`,
  );
  const container: ElementorContainer = state.container
    ? { ...state.container }
    : {
        selector: state.widgetProfile!.selectors[0],
        width: state.widgetProfile!.width,
        breakpoint: state.widgetProfile!.breakpoint,
        notes: state.widgetProfile!.notes,
      };

  if (state.containerTree) {
    container.tree = state.containerTree;
  }

  const config = getModelConfig(state.modelId);
  // Detect LLM-failure-induced placeholder: when the LLM call errored,
  // parseNode produces a tiny normalized wrapper (~46 chars) with no
  // `gsap.` calls. In that case, attach the LLM error to the result so
  // the UI's preview pane can show the user that the empty code is a
  // symptom of the LLM failure, not a real generation.
  const isLlmFailurePlaceholder =
    !!state.error && (!state.gsapCode || !state.gsapCode.includes('gsap.'));
  const result: GenerateResponse = {
    gsapCode: state.gsapCode,
    containerStructure: container,
    cssSelectors: state.widgetProfile!.selectors,
    scalabilityStrategy: deriveScalabilityStrategy(state.intent, state.containerTree),
    validation: {
      isValid,
      qualityScore,
      issues: allIssues,
    },
    attempts: state.attempts,
    model: `${config.id} (${config.model})`,
    pipeline: state.stageTrace,
    ...(isLlmFailurePlaceholder && state.error ? { error: state.error } : {}),
  };

  ctx.log(
    `[output] packaged ${state.gsapCode.length} chars, ${state.attempts} attempt(s), tree=${state.containerTree ? 'present' : 'missing'}${isLlmFailurePlaceholder ? ' [LLM failure placeholder — error attached]' : ''}`,
  );
  ctx.emit({
    type: 'stage-end',
    ts: Date.now(),
    stage: 'output',
    ok: true,
  });
  return { result, isValid, qualityScore, validationIssues: allIssues, stageTrace: ['output → finalized'] };
}

function deriveScalabilityStrategy(intent: string, tree: ElementorWidgetValidated | null): string {
  const lc = intent.toLowerCase();
  // Tree-aware hints first.
  if (tree) {
    const counts: Record<string, number> = {};
    const walk = (n: ElementorWidgetValidated): void => {
      counts[n.kind] = (counts[n.kind] ?? 0) + 1;
      n.children?.forEach(walk);
    };
    walk(tree);
    const slideCount = counts['Container'] ?? 0;
    if (slideCount >= 2) {
      return `Carousel: stagger entrance with stagger: 0.1 across ${slideCount} containers; gsap.context() for cleanup; revertible matchMedia if needed.`;
    }
  }
  if (lc.includes('scroll')) return 'ScrollTrigger with batched stagger; data-scroll attribute for performance.';
  if (lc.includes('hover')) return 'gsap.quickTo() for hover; cache timeline references.';
  if (lc.includes('count') || lc.includes('counter') || lc.includes('number')) return 'gsap.to with onUpdate driving textContent; transform+opacity only.';
  if (lc.includes('carousel')) return 'Swiper API for slide transitions; gsap for entry animations; revert on context cleanup.';
  return 'Single gsap.timeline() per component; staggered reveals with stagger: 0.1; gsap.context() for cleanup.';
}

// ─── Build the graph ──────────────────────────────────────────────────────────

function buildGraph() {
  // Single direct pass (validate/retry stages removed, as in ax-translator):
  // entry → generate → parse → output. No conditional edges, no loop.
  const workflow = new StateGraph(PipelineAnnotation)
    .addNode('entry', (s: PipelineState) => entryNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('generate', (s: PipelineState) => generateNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('parse', (s: PipelineState) => parseGsapNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('output', (s: PipelineState) => outputNode(s, makeNodeHelpers(_globalEmit)));

  workflow.addEdge('entry', 'generate');
  workflow.addEdge('generate', 'parse');
  workflow.addEdge('parse', 'output');
  workflow.addEdge('output', END);
  workflow.setEntryPoint('entry');

  return workflow.compile();
}

// Global emit (set per-run). LangGraph nodes can't carry extra context easily,
// so we use a module-level reference and set it inside `runGenerationPipelineStream`.
let _globalEmit: (e: PipelineEvent) => void = () => {};

// ─── Runner ──────────────────────────────────────────────────────────────────

export async function runGenerationPipelineStream(opts: RunOptions): Promise<GenerateResponse> {
  _globalEmit = opts.emit;
  const graph = buildGraph();

  // Single attempt — no validate/retry loop (validate machinery removed,
  // as in ax-translator). The generation call itself is wrapped by
  // callWithRetryAwareness for rate-limit-aware error reporting.
  const maxAttempts = 1;

  const initial: PipelineState = {
    intent: opts.intent,
    presetId: opts.presetId,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    widgetProfile: null,
    rawCode: '',
    rawTreeJson: '',
    gsapCode: '',
    containerTree: null,
    validationIssues: [],
    isValid: false,
    llmScore: 0,
    qualityScore: 0,
    errorHistory: [],
    refineContext: '',
    attempts: 0,
    maxAttempts,
    // Stable per-run session ID. OpenCode uses it for prompt-cache routing;
    // NVIDIA ignores it. Lives only for the duration of this run — a fresh
    // UUID is minted for each /api/generate request.
    sessionId: newOpencodeSessionId(),
    messages: [],
    stageTrace: [],
    container: null,
    result: null,
    error: null,
  };

  try {
    const final = await graph.invoke(initial);
    const result: GenerateResponse = final.result ?? {
      gsapCode: '',
      containerStructure: { selector: '', width: '', breakpoint: '', notes: '' },
      cssSelectors: [],
      scalabilityStrategy: '',
      validation: { isValid: false, qualityScore: 0, issues: ['Pipeline produced no result'] },
      attempts: final.attempts,
      model: `${opts.modelId}`,
      pipeline: final.stageTrace,
    };
    if (final.error) {
      // ALWAYS emit the error event when the LLM call failed — even if a
      // placeholder gsapCode was packaged by outputNode. Without this, the
      // UI transitions to the preview pane showing the empty code as if
      // it were a real (low-quality) generation, and the user can't tell
      // that the underlying cause was a 50s LLM timeout on Vercel Hobby.
      // The error message is actionable (see nvidia-client.ts): it tells
      // the user to try a simpler intent, switch to GLM 5.3, or run
      // locally.
      opts.emit({ type: 'error', ts: Date.now(), message: final.error });
    }
    // Emit pipeline-end so the frontend transitions to Preview pane
    opts.emit({ type: 'pipeline-end', ts: Date.now(), result });
    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.emit({ type: 'error', ts: Date.now(), message: msg });
    throw err;
  }
}

// Re-export the adapter functions so unit tests and downstream tools can
// import them without reaching into the dspy-signature module directly.
export { extractCodeAndTree, parsePrediction } from './dspy-signature';
export type { AnimationPrediction } from './dspy-signature';