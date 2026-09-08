/**
 * Provider configs — mirrors `google-ads-subagent-vercel/lib/models.ts`.
 *
 * Both providers expose an OpenAI-compatible /v1/chat/completions endpoint.
 * The default model is NVIDIA NIM gpt-oss-20b (the 120b variant was sunset,
 * so the pipeline was migrated to the smaller, faster 20b model). OpenCode
 * Zen with GLM 5.1 is the alternative fast/cheap provider.
 */

export type ModelId = 'nvidia-gpt-oss-20b' | 'opencode-glm-5.1';

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
  'nvidia-gpt-oss-20b': {
    id: 'nvidia-gpt-oss-20b',
    name: 'NVIDIA GPT-OSS-20B',
    description:
      'OpenAI GPT-OSS-20B served via NVIDIA NIM. Reasoning model — needs max_tokens>=8192 because the reasoning_content stream alone can burn 2-4k tokens before content begins. WARNING on Vercel Hobby: per-call timeout is 50s (Vercel 60s cap), so ~10-20% of complex intents will time out. Switch to GLM 5.1 below or run locally for full retry support.',
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-20b',
    apiKeyPrefix: 'nvapi-',
    docsUrl: 'https://build.nvidia.com/openai/gpt-oss-20b',
    // Vercel Hobby caps serverless functions at 60s. gpt-oss-20b's reasoning
    // step is unpredictable — first-attempt prompts usually finish in 25-45s
    // but ~10-20% of intents take 50-70s. Setting per-call timeout to 50s:
    //   - Lets the nvidia-client throw a clean TIMEOUT error after 50s
    //   - Leaves 10s buffer for parse/validate/output stages to run + emit
    //     the pipeline-end event before Vercel's 60s hard cap
    //   - Without this, Vercel silently kills the function at 60s with no
    //     error event, leaving the UI stuck on "Generating…"
    //
    // On local dev (no Vercel cap) or Vercel Pro/Enterprise, bump this to
    // 180_000 to give reasoning models the full room they want.
    timeoutMs: 50_000,
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
      'GLM 5.1 via opencode.ai/zen/go. The gateway now serves GLM 5.3 behind the glm-5.1 alias — thinking-only, so we use reasoning_effort "low". Fast and reliable. The OpenCode Go gateway REQUIRES a stable `x-opencode-session` header per conversation (we mint one UUID per run and reuse it across retries for prompt-cache affinity) plus a custom `User-Agent`.',
    baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
    model: 'glm-5.1',
    apiKeyPrefix: 'sk-',
    docsUrl: 'https://opencode.ai/docs/go',
    timeoutMs: 50_000,
    defaultMaxTokens: 4096,
    reasoningEffort: 'low',
    // Fast + reliable → skip cooldowns entirely.
    cooldownMultiplier: 0,
    retryBackoffMultiplier: 0.2,
  },
};

export const DEFAULT_MODEL: ModelId = 'nvidia-gpt-oss-20b';

export function getModelConfig(id: ModelId): ModelConfig {
  const cfg = MODELS[id];
  if (!cfg) throw new Error(`Unknown model: ${id}`);
  return cfg;
}
