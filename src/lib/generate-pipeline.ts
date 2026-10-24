/**
 * Static type definitions for the GSAP generation pipeline.
 *
 * The actual logic lives in:
 *   - src/lib/pipeline-graph.ts   ← LangGraph StateGraph runner
 *   - src/lib/gsap-utils.ts        ← parser + validator
 *   - src/lib/widget-profiles.ts  ← per-widget Elementor selector profiles
 *   - src/lib/llm-client.ts       ← unified NVIDIA + OpenCode dispatcher
 *   - src/lib/dspy-signature.ts   ← AX-style declarative signature for the
 *                                    structured { gsapCode, containerTree } output
 *
 * This file only defines the public-facing types.
 */

import { z } from 'zod';
import type { ElementorWidget, ElementorWidgetValidated } from './elementor-widget';

export interface GenerateRequest {
  intent: string;
  presetId?: string;
  apiKey?: string;
  model?: string;
}

/**
 * Container metadata for the Elementor widget the animation targets.
 *
 * `tree` is the recursive Elementor widget hierarchy — what the preview pane
 * renders as a tree and what the GTM guide references in its troubleshooting
 * notes. When `tree` is absent (older pipeline revisions, parse failures), the
 * preview pane falls back to the flat selector/width/breakpoint/notes display.
 */
export interface ElementorContainer {
  selector: string;
  width: string;
  breakpoint: string;
  notes: string;
  tree?: ElementorWidgetValidated;
}

export interface GenerateResponse {
  gsapCode: string;
  containerStructure: ElementorContainer;
  cssSelectors: string[];
  scalabilityStrategy: string;
  validation: {
    isValid: boolean;
    qualityScore: number;
    issues: string[];
  };
  attempts: number;
  model: string;
  pipeline: string[];
  /**
   * Set when the pipeline produced a degraded/placeholder result because the
   * LLM call failed (timeout, network error, rate-limit). The UI surfaces this
   * on the preview pane so the user understands the empty code is a symptom,
   * not a real (low-quality) generation.
   */
  error?: string;
}

export const GenerateRequestSchema = z.object({
  intent: z.string().min(10).max(2000),
  presetId: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

// Re-export from the LangGraph-backed pipeline so old import paths keep working.
export { runGenerationPipelineStream } from './pipeline-graph';
export type { PipelineEvent } from './pipeline-graph';
// Re-export the Elementor widget type for component code that wants the shape.
export type { ElementorWidget, ElementorWidgetValidated } from './elementor-widget';

// Single direct pass — every stage the graph traverses (validate/retry
// stages removed, as in ax-translator).
const STAGE_ORDER = ['entry', 'generate', 'parse', 'output'] as const;
type StageId = (typeof STAGE_ORDER)[number];

const STAGE_META: Record<StageId, { name: string; description: string }> = {
  entry: { name: 'Entry Node', description: 'Parsing intent & container map' },
  generate: { name: 'Generate', description: 'Single LLM call with intent (temp 0.3)' },
  parse: { name: 'Parse', description: 'Normalizing GSAP output + tree JSON' },
  output: { name: 'Output', description: 'Static checks + packaging code + tree for preview' },
};

export { STAGE_ORDER, STAGE_META };
export type { StageId };