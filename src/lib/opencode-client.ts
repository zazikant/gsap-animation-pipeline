/**
 * OpenCode Zen (GLM 5.1) API client — OpenAI Chat Completions interface.
 *
 * Lifted from `ax-opencode-translator/src/lib/llm-client.ts` (post-fix) and
 * shaped to match the streaming-control pattern from
 * `ax-translator/src/lib/nvidia-client.ts`.
 *
 * Base URL: https://opencode.ai/zen/go
 * Model:    glm-5.1 (alias — gateway currently serves GLM 5.3 thinking-only)
 *
 * GLM 5.3 rejects `reasoning_effort: "none"` with HTTP 400 (error 1210).
 * We use `reasoning_effort: "low"` to keep reasoning overhead minimal while
 * still returning the final answer in `content`.
 *
 * ─── Session header (OpenCode Go requirement) ───────────────────────────────
 * Per the OpenCode Go docs (https://opencode.ai/docs/go/), clients MUST:
 *   1. Identify themselves with a custom `User-Agent` (not a generic SDK UA)
 *   2. Send a stable session ID in `x-opencode-session` per conversation so
 *      the gateway can optimize routing + reuse prompt-cache slots across
 *      retries within the same logical conversation.
 *
 * Without the session header the gateway returns HTTP 400 MissingSessionID
 * (enforcement tightened 2026-09-06). Within a single pipeline run (which
 * may retry generate→retry→generate) we use ONE stable UUID; across runs we
 * generate a fresh one. Pattern lifted from
 * `rag-document-assistant-opencode/src/lib/opencode.ts:9-47`.
 */

import { sleep } from './rate-limit';

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go';
export const DEFAULT_OPENCODE_MODEL = 'glm-5.1';

export const DEFAULT_CALL_TIMEOUT_MS = 50_000;
export const DEFAULT_MAX_RETRIES = 1;

/**
 * Custom User-Agent per OpenCode Go docs: "Identify itself with its own user
 * agent, such as `my-coding-agent/1.0`, rather than a generic SDK or
 * HTTP-library name."
 */
const OPENCODE_USER_AGENT = 'gsap-animation-pipeline/0.1.0 (opencode-go)';

/**
 * Generate a stable per-conversation UUID using the Web Crypto API.
 * Edge Runtime (Vercel serverless) can't import `node:crypto`, but
 * `crypto.randomUUID()` is available in Node 19+ and all browsers.
 */
export function newOpencodeSessionId(): string {
  return crypto.randomUUID();
}

export interface OpencodeChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpencodeCallOptions {
  model?: string;
  messages: OpencodeChatMessage[];
  temperature?: number;
  maxTokens?: number;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Stable per-conversation session ID sent in the `x-opencode-session`
   * header. Required by the OpenCode Go gateway. The pipeline should pass
   * the SAME id across generate → retry → generate so retries hit the
   * gateway's prompt-cache slot. If omitted, a fresh UUID is generated
   * per call (no cache affinity).
   */
  sessionId?: string;
  onLog?: (line: string) => void;
  onChunk?: (text: string) => void;
}

export interface OpencodeCallResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
}

function log(opts: OpencodeCallOptions, msg: string) {
  const line = `[opencode] ${msg}`;
  console.log(line);
  opts.onLog?.(line);
}

async function streamOnce(
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
  sessionId?: string,
): Promise<{ content: string; reasoning: string; ttfbMs: number | null }> {
  const callStart = Date.now();
  const sid = sessionId ?? newOpencodeSessionId();
  const response = await fetch(`${OPENCODE_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
      // Required by OpenCode Go gateway — see file header.
      'x-opencode-session': sid,
      'User-Agent': OPENCODE_USER_AGENT,
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenCode API error (${response.status}): ${errText.slice(0, 300)}`);
  }
  if (!response.body) throw new Error('OpenCode API returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let ttfbMs: number | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - callStart;

    buffer += decoder.decode(value, { stream: true });
    let nlIdx;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { content, reasoning, ttfbMs };
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onChunk?.(delta.content);
          }
          if (typeof delta.reasoning_content === 'string') {
            reasoning += delta.reasoning_content;
          }
        }
      } catch {
        // Partial JSON across chunks.
      }
    }
  }
  return { content, reasoning, ttfbMs };
}

export async function opencodeChatCompletion(
  opts: OpencodeCallOptions,
): Promise<OpencodeCallResult> {
  const model = opts.model || DEFAULT_OPENCODE_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const reasoningEffort = opts.reasoningEffort ?? 'low';
  const sessionId = opts.sessionId ?? newOpencodeSessionId();
  const callStart = Date.now();

  log(
    opts,
    `start  model=${model} max_tokens=${opts.maxTokens ?? 4096} temp=${opts.temperature ?? 0.3} timeout=${timeoutMs}ms reasoning_effort=${reasoningEffort} session=${sessionId}`,
  );

  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { content, reasoning, ttfbMs } = await streamOnce(
        {
          model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature ?? 0.3,
          reasoning_effort: reasoningEffort,
        },
        opts.apiKey,
        controller.signal,
        opts.onChunk,
        sessionId,
      );
      clearTimeout(timeout);
      const elapsed = Date.now() - callStart;
      log(
        opts,
        `ttfb=${ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${content.length} reasoning_chars=${reasoning.length} session=${sessionId}`,
      );
      if (!content) {
        throw new Error(
          `empty content (reasoning_chars=${reasoning.length}, finish_reason may be "length" — increase max_tokens)`,
        );
      }
      return { content, reasoning, model, elapsedMs: elapsed, attempts: attempt };
    } catch (err: unknown) {
      clearTimeout(timeout);
      const e = err as Error;
      lastErr = e;
      if (e.name === 'AbortError') {
        log(opts, `TIMEOUT attempt=${attempt} after ${timeoutMs}ms session=${sessionId}`);
      } else {
        log(opts, `ERROR attempt=${attempt}: ${e.name}: ${e.message.slice(0, 200)} session=${sessionId}`);
      }
      if (attempt < maxRetries) {
        const backoff = 500 * attempt;
        log(opts, `retry  backing off ${backoff}ms before attempt ${attempt + 1} session=${sessionId}`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(
    `OpenCode call failed after ${maxRetries} attempts (session=${sessionId}): ${lastErr?.name}: ${lastErr?.message}`,
  );
}

export async function callOpencodeLLM(
  systemPrompt: string,
  userContent: string,
  apiKey: string,
  model?: string,
  maxTokens: number = 4096,
  temperature: number = 0.3,
  onLog?: (line: string) => void,
  onChunk?: (text: string) => void,
  sessionId?: string,
): Promise<string> {
  const result = await opencodeChatCompletion({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maxTokens,
    temperature,
    apiKey,
    onLog,
    onChunk,
    sessionId,
  });
  return result.content;
}

export { OPENCODE_BASE_URL };
