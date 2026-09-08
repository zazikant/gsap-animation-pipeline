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
      'OpenAI GPT-OSS-20B served via NVIDIA NIM. Reasoning model. Runs on Vercel Edge runtime (ax-translator pattern) — Node serverless silently hangs on gpt-oss-20b, but Edge uses a different egress that works. Reasoning effort is intentionally left unset (the default); max_tokens=4096 leaves room for code + JSON tree without letting the model burn tokens on excessive reasoning.',
    baseUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'openai/gpt-oss-20b',
    apiKeyPrefix: 'nvapi-',
    docsUrl: 'https://build.nvidia.com/openai/gpt-oss-20b',
    // 50s per-call timeout. Combined with Edge runtime (route.ts), this
    // is what ax-translator uses to make gpt-oss-20b reliable on Vercel.
    // The KEY fix is Edge runtime — Vercel Node serverless silently hangs
    // on gpt-oss-20b (confirmed by ax-translator's debug endpoint). Edge
    // uses a different egress that completes the same call in 8-30s.
    // We give the model 50s of room; on Vercel Hobby Edge runtime the
    // function is capped at 30s, so Vercel kills long calls at 30s and
    // our 50s timeout is the upper bound on Pro/local-dev.
    timeoutMs: 50_000,
    // 4096 is plenty for our structured output (~2k tokens of GSAP code +
    // ~500 tokens of tree JSON + a small reasoning buffer). ax-translator
    // uses 2048 minimum; we go a bit higher because our prompt asks for
    // structured code + JSON tree, not just a translation. 8192 (the old
    // value) gave the reasoning model permission to burn 4-6k tokens on
    // internal reasoning before any content appeared — that's what was
    // pushing TTFB past 50s on Node serverless.
    defaultMaxTokens: 4096,
    // NOTE: reasoning_effort is intentionally NOT sent. ax-translator
    // doesn't send it, and our local tests showed gpt-oss-20b produces
    // good output without it. Sending 'low' was making the model spend
    // more tokens on reasoning_content, not less.
    reasoningEffort: 'low', // kept in config for type-compat; nvidia-client ignores it now
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
