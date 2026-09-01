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

const STAGE_ORDER = ['entry', 'generate', 'parse', 'validate', 'retry', 'output'] as const;
type StageId = (typeof STAGE_ORDER)[number];

const STAGE_META: Record<StageId, { name: string; description: string }> = {
  entry: { name: 'Entry Node', description: 'Parsing intent & container map' },
  generate: { name: 'Generate', description: 'Calling LLM with intent' },
  parse: { name: 'Parse', description: 'Normalizing GSAP output + tree JSON' },
  validate: { name: 'Validate', description: 'Sandbox check on generated code + tree' },
  retry: { name: 'Retry Guard', description: 'Applying feedback to retry' },
  output: { name: 'Output', description: 'Packaging validated code + tree' },
};

export { STAGE_ORDER, STAGE_META };
export type { StageId };