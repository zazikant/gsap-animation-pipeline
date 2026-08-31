/**
 * LangGraph StateGraph for the GSAP generation pipeline.
 *
 * Real StateGraph with conditional retry edges, not just a sequential for-loop
 * with cosmetic `lg1-lg5` labels.
 *
 * Flow:
 *
 *   entryNode
 *     ↓
 *   generateNode          ← single LLM call (Nvidia 120B / OpenCode GLM 5.1)
 *     ↓
 *   parseGsapNode         ← strip fences, normalize, locate entry point
 *     ↓
 *   validateNode          ← regex + structural sandbox check
 *     ↓                  ↘ retry?  ↓
 *   [conditional edge] ───→ retryGuardNode → generateNode (with feedback)
 *     ↓                  ↗
 *   outputNode            ← terminal; emits GenerateResponse
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
import { stripCodeFences, normalizeGsapCode, validateGsapCode } from './gsap-utils';
import type { GenerateResponse, ElementorContainer } from './generate-pipeline';

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
  /** Normalized code (stripped fences, IIFE wrappers unwrapped) */
  gsapCode: string;
  /** Issues found by validateNode, fed back to retryGuardNode */
  validationIssues: string[];
  /** Validation pass/fail */
  isValid: boolean;
  /** Total LLM calls so far (translate retry → generate cycles) */
  attempts: number;
  /** Max retries before forcing output with current best */
  maxAttempts: number;
  /** Conversation history for the LangGraph "thinking" trace */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Append-only log lines for the UI */
  stageTrace: string[];
  /** Final container metadata (filled by entryNode) */
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
  gsapCode: Annotation<string>({
    reducer: (_x, y) => y,
    default: () => '',
  }),
  validationIssues: Annotation<string[]>({
    reducer: (_x, y) => y,
    default: () => [],
  }),
  isValid: Annotation<boolean>({
    reducer: (_x, y) => y,
    default: () => false,
  }),
  attempts: Annotation<number>({
    reducer: (x, y) => y,
    default: () => 0,
  }),
  maxAttempts: Annotation<number>({
    reducer: (_x, y) => y,
    default: () => 3,
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

// ─── System prompt (shared) ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert GSAP animator writing code for Elementor-built WordPress sites.

OUTPUT FORMAT — strictly follow:
1. Output ONLY executable JavaScript. No prose, no markdown code fences (\`\`\`), no explanations.
2. Wrap your code in: (function init(){ <your code here> })();
   OR define a top-level \`function initAnimation(){ ... }\` and call it at the bottom.
3. Load GSAP + ScrollTrigger dynamically if not already on the page:
     if (!window.gsap) { loadScript("https://cdn.jsdelivr.net/npm/gsap@3.13/dist/gsap.min.js", next); }
     else next();
   Use ONE CDN (jsdelivr). Don't load from multiple sources.
4. Handle the dynamic script load with an onerror callback that logs to console.
5. The selectors must match the widget profile provided in the user message EXACTLY.
6. Use \`gsap.context(() => { ... })\` so animations can be reverted via the context's \`.revert()\` API.
7. Handle window resize with ScrollTrigger.refresh() or kill+rebuild triggers.
8. Match the user's described behavior — if they ask for a CAROUSEL, implement slide navigation (prev/next, autoplay, transition between slides), NOT just a one-time reveal.`;

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
  totalSec: number,
  reason: string,
  multiplier: number,
): Promise<void> {
  const decision = decideCooldown({
    attempts: 1,
    succeeded: true,
    cooldownMultiplier: multiplier,
  });
  const sec = decision.delaySec > 0 ? decision.delaySec : totalSec;
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
    name: 'Code Generation',
    description: `Calling LLM (attempt ${state.attempts + 1}/${state.maxAttempts})`,
  });

  const profile = state.widgetProfile!;
  const isRetry = state.attempts > 0 && state.validationIssues.length > 0;
  ctx.log(
    `[generate] attempt ${state.attempts + 1}/${state.maxAttempts}${isRetry ? ' (retry with feedback)' : ''}`,
  );

  const userPrompt = isRetry
    ? buildRetryPrompt(state.intent, profile, state.rawCode, state.validationIssues)
    : buildInitialPrompt(state.intent, profile);

  // Always bump the attempt counter — even on error — so shouldRetry can terminate.
  const nextAttempt = state.attempts + 1;

  let code = '';
  try {
    code = await callUnifiedLLM(
      SYSTEM_PROMPT,
      userPrompt,
      state.modelId,
      state.apiKey,
      undefined,
      0.3,
      (line) => ctx.emit({ type: 'log', ts: Date.now(), line: `[generate] ${line}` }),
      (chunk) => ctx.emit({ type: 'chunk', ts: Date.now(), text: chunk }),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log(`[generate] LLM call failed: ${msg.slice(0, 200)}`);
    ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'generate', ok: false, error: msg });
    // Increment attempts even on error so shouldRetry terminates after maxAttempts.
    return { error: msg, attempts: nextAttempt, rawCode: state.rawCode };
  }

  ctx.log(`[generate] received ${code.length} chars`);
  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'generate', ok: true });

  return {
    rawCode: code,
    attempts: nextAttempt,
    messages: [
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: code },
    ],
    stageTrace: [`generate → ${code.length} chars (attempt ${nextAttempt})`],
  };
}

function buildInitialPrompt(intent: string, profile: WidgetProfile): string {
  return `Intent: ${intent}

Target widget: ${profile.widgetType}
Container selector: ${profile.selectors[0]}
Inner selectors available:
${profile.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}

Requirements:
- Animation must match the described behavior (carousel = slide nav + autoplay, not just reveal)
- Use the container selector exactly as given
- Wrap your code in: (function init() { /* code */ })();   OR   function initAnimation() { /* code */ } initAnimation();
- Load GSAP from https://cdn.jsdelivr.net/npm/gsap@3.13/dist/gsap.min.js if not present
- Load ScrollTrigger from the same CDN if you use it
- Handle window resize: ScrollTrigger.refresh()
- Use gsap.context() for cleanup

Output ONLY JavaScript. No markdown fences. No prose.`;
}

function buildRetryPrompt(
  intent: string,
  profile: WidgetProfile,
  previousCode: string,
  issues: string[],
): string {
  return `Intent: ${intent}

Target widget: ${profile.widgetType}
Container selector: ${profile.selectors[0]}

PREVIOUS ATTEMPT:
\`\`\`
${previousCode}
\`\`\`

ISSUES TO FIX:
${issues.map((i) => `• ${i}`).join('\n')}

Rewrite the code addressing ALL listed issues. Output ONLY the corrected JavaScript — no markdown fences, no prose.`;
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
    name: 'GSAP Parser',
    description: 'Stripping fences + normalizing IIFE wrappers',
  });
  const stripped = stripCodeFences(state.rawCode);
  const normalized = normalizeGsapCode(stripped);
  ctx.log(`[parse] stripped fences (${state.rawCode.length} → ${stripped.length})`);
  ctx.log(`[parse] normalized (${stripped.length} → ${normalized.length})`);
  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'parse', ok: true });
  return {
    gsapCode: normalized,
    stageTrace: [`parse → ${normalized.length} chars normalized`],
  };
}

// ─── Node 4: validateNode (sandbox check) ────────────────────────────────────

async function validateNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'validate',
    name: 'Sandbox Validation',
    description: 'Checking for selectors, primitives, onerror, multi-CDN, etc.',
  });
  const result = validateGsapCode(state.gsapCode, state.widgetProfile);
  ctx.log(
    `[validate] quality=${result.qualityScore}${result.isValid ? ' ✓ pass' : ` ✗ ${result.issues.length} issue(s)`}`,
  );
  if (result.issues.length > 0) {
    result.issues.forEach((issue) => ctx.log(`[validate]   - ${issue}`));
  }
  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'validate', ok: result.isValid });
  return {
    isValid: result.isValid,
    validationIssues: result.issues,
    stageTrace: [
      `validate → ${result.isValid ? 'pass' : 'fail'} (score=${result.qualityScore})`,
    ],
  };
}

// ─── Node 5: retryGuardNode (build corrective context) ───────────────────────

async function retryGuardNode(
  state: PipelineState,
  ctx: NodeCtx,
): Promise<Partial<PipelineState>> {
  ctx.emit({
    type: 'stage-start',
    ts: Date.now(),
    stage: 'retry',
    name: 'Retry Guard',
    description: `Cooldown + corrective feedback for next attempt`,
  });
  ctx.log(
    `[retry] quality below threshold — preparing corrective context (attempt ${state.attempts}/${state.maxAttempts})`,
  );

  // Apply adaptive cooldown before the next LLM call (NVIDIA rate-limit)
  const config = getModelConfig(state.modelId);
  await runCooldown(ctx, 30, 'before retry', config.cooldownMultiplier);

  ctx.emit({ type: 'stage-end', ts: Date.now(), stage: 'retry', ok: true });
  return {
    stageTrace: [
      `retry → armed with ${state.validationIssues.length} issue(s) to address`,
    ],
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
    description: 'Packaging validated code into GenerateResponse',
  });

  // If we've exhausted retries with a still-failing code, force a "best effort" result
  const finalValidation = validateGsapCode(state.gsapCode, state.widgetProfile);
  const container = state.container ?? state.widgetProfile!.selectors[0]
    ? {
        selector: state.widgetProfile!.selectors[0],
        width: state.widgetProfile!.width,
        breakpoint: state.widgetProfile!.breakpoint,
        notes: state.widgetProfile!.notes,
      }
    : { selector: '.elementor-element', width: 'w100', breakpoint: 'lg-1', notes: '' };

  const config = getModelConfig(state.modelId);
  const result: GenerateResponse = {
    gsapCode: state.gsapCode,
    containerStructure: container,
    cssSelectors: state.widgetProfile!.selectors,
    scalabilityStrategy: deriveScalabilityStrategy(state.intent),
    validation: finalValidation,
    attempts: state.attempts,
    model: `${config.id} (${config.model})`,
    pipeline: state.stageTrace,
  };

  ctx.log(`[output] packaged ${state.gsapCode.length} chars, ${state.attempts} attempt(s)`);
  ctx.emit({
    type: 'stage-end',
    ts: Date.now(),
    stage: 'output',
    ok: true,
  });
  return { result, stageTrace: ['output → finalized'] };
}

function deriveScalabilityStrategy(intent: string): string {
  const lc = intent.toLowerCase();
  if (lc.includes('scroll')) return 'ScrollTrigger with batched stagger; data-scroll attribute for performance.';
  if (lc.includes('hover')) return 'gsap.quickTo() for hover; cache timeline references.';
  if (lc.includes('count') || lc.includes('counter') || lc.includes('number')) return 'gsap.to with onUpdate driving textContent; transform+opacity only.';
  if (lc.includes('carousel')) return 'Swiper API for slide transitions; gsap for entry animations; revert on context cleanup.';
  return 'Single gsap.timeline() per component; staggered reveals with stagger: 0.1; gsap.context() for cleanup.';
}

// ─── Conditional edges ───────────────────────────────────────────────────────

function shouldRetry(state: PipelineState): 'retry' | 'output' {
  if (state.isValid) return 'output';
  if (state.attempts >= state.maxAttempts) return 'output';
  // Retry on both validation failures AND LLM failures (transient timeouts,
  // rate-limits, network issues). Only give up when we've exhausted attempts.
  return 'retry';
}

// ─── Build the graph ──────────────────────────────────────────────────────────

function buildGraph() {
  const workflow = new StateGraph(PipelineAnnotation)
    .addNode('entry', (s: PipelineState) => entryNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('generate', (s: PipelineState) => generateNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('parse', (s: PipelineState) => parseGsapNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('validate', (s: PipelineState) => validateNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('retry', (s: PipelineState) => retryGuardNode(s, makeNodeHelpers(_globalEmit)))
    .addNode('output', (s: PipelineState) => outputNode(s, makeNodeHelpers(_globalEmit)));

  workflow.addEdge('entry', 'generate');
  workflow.addEdge('generate', 'parse');
  workflow.addEdge('parse', 'validate');
  workflow.addConditionalEdges('validate', shouldRetry, {
    retry: 'retry',
    output: 'output',
  });
  workflow.addEdge('retry', 'generate');
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
  const initial: PipelineState = {
    intent: opts.intent,
    presetId: opts.presetId,
    modelId: opts.modelId,
    apiKey: opts.apiKey,
    widgetProfile: null,
    rawCode: '',
    gsapCode: '',
    validationIssues: [],
    isValid: false,
    attempts: 0,
    maxAttempts: 3,
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
    if (final.error && !result.gsapCode) {
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
