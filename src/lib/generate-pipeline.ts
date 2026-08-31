/**
 * Static type definitions for the GSAP generation pipeline.
 *
 * The actual logic lives in:
 *   - src/lib/pipeline-graph.ts   ← LangGraph StateGraph runner
 *   - src/lib/gsap-utils.ts        ← parser + validator
 *   - src/lib/widget-profiles.ts  ← per-widget Elementor selector profiles
 *   - src/lib/llm-client.ts       ← unified NVIDIA + OpenCode dispatcher
 *
 * This file only defines the public-facing types.
 */

import { z } from 'zod';

export interface GenerateRequest {
  intent: string;
  presetId?: string;
  apiKey?: string;
  model?: string;
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

export interface ElementorContainer {
  selector: string;
  width: string;
  breakpoint: string;
  notes: string;
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

const STAGE_ORDER = ['entry', 'generate', 'parse', 'validate', 'retry', 'output'] as const;
type StageId = (typeof STAGE_ORDER)[number];

const STAGE_META: Record<StageId, { name: string; description: string }> = {
  entry: { name: 'Entry Node', description: 'Parsing intent & container map' },
  generate: { name: 'Generate', description: 'Calling LLM with intent' },
  parse: { name: 'Parse', description: 'Normalizing GSAP output' },
  validate: { name: 'Validate', description: 'Sandbox check on generated code' },
  retry: { name: 'Retry Guard', description: 'Applying feedback to retry' },
  output: { name: 'Output', description: 'Packaging validated code' },
};

export { STAGE_ORDER, STAGE_META };
export type { StageId };
