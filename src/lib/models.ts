/**
 * Provider configs — mirrors `google-ads-subagent-vercel/lib/models.ts`.
 *
 * Both providers expose an OpenAI-compatible /v1/chat/completions endpoint.
 * The default model is NVIDIA NIM gpt-oss-120b (matches the original
 * gsap-animation-pipeline). OpenCode Zen with GLM 5.1 is the fast/cheap
 * alternative.
 */

export type ModelId = 'nvidia-gpt-oss-120b' | 'opencode-glm-5.1';

export interface ModelConfig {
  readonly id: ModelId;
  readonly name: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyPrefix: string; // 'nvapi-' or 'sk-' — surfaced as a UI hint
  readonly docsUrl: string;
  readonly timeoutMs: number;
  readonly defaultMaxTokens: number;
  readonly reasoningEffort: 'low' | 'medium' | 'high';
  /**
   * Multiplier applied to the standard 10/30/60s cooldowns:
   *   1   = full NVIDIA-style cooldowns (3/10/20/30s based on prior stage)
   *   0   = skip cooldowns entirely (fast/reliable providers)
   */
  readonly cooldownMultiplier: number;
  /**
   * Retry backoff multiplier. < 1 = recover faster.
   */
  readonly retryBackoffMultiplier: number;
}

export const MODELS: Record<ModelId, ModelConfig> = {
  'nvidia-gpt-oss-120b': {
    id: 'nvidia-gpt-oss-120b',
    name: 'NVIDIA GPT-OSS-120B',
    description:
      'OpenAI GPT-OSS-120B served via NVIDIA NIM. Reasoning model — needs max_tokens>=8192 because the reasoning_content stream alone can burn 2-4k tokens before content begins. Slow (40-50s TTFB) but high quality.',
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-120b',
    apiKeyPrefix: 'nvapi-',
    docsUrl: 'https://build.nvidia.com/openai/gpt-oss-120b',
    timeoutMs: 120_000,
    // Reasoning models: 2048 leaves zero room after reasoning. 8192 covers
    // ~6k reasoning + ~2k content, which fits our prompt + structured output.
    defaultMaxTokens: 8192,
    reasoningEffort: 'low',
    cooldownMultiplier: 1,
    retryBackoffMultiplier: 1,
  },
  'opencode-glm-5.1': {
    id: 'opencode-glm-5.1',
    name: 'OpenCode Zen — GLM 5.1',
    description:
      'GLM 5.1 via opencode.ai/zen/go. The gateway now serves GLM 5.3 behind the glm-5.1 alias — thinking-only, so we use reasoning_effort "low". Fast and reliable.',
    baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
    model: 'glm-5.1',
    apiKeyPrefix: 'sk-',
    docsUrl: 'https://opencode.ai/docs/zen',
    timeoutMs: 50_000,
    defaultMaxTokens: 4096,
    reasoningEffort: 'low',
    // Fast + reliable → skip cooldowns entirely.
    cooldownMultiplier: 0,
    retryBackoffMultiplier: 0.2,
  },
};

export const DEFAULT_MODEL: ModelId = 'nvidia-gpt-oss-120b';

export function getModelConfig(id: ModelId): ModelConfig {
  const cfg = MODELS[id];
  if (!cfg) throw new Error(`Unknown model: ${id}`);
  return cfg;
}
