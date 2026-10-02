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
  /** Number of continuation rounds that were triggered (0 if the model finished in one call). */
  continuations: number;
  /** True if the model exhausted all continuations and is STILL truncated. */
  truncated: boolean;
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
): Promise<{
  content: string;
  reasoning: string;
  ttfbMs: number | null;
  /**
   * finish_reason from the model:
   *   'stop'       — model finished naturally (clean stop)
   *   'length'     — model hit max_tokens mid-generation (output truncated)
   *   'content_filter' / 'tool_calls' / undefined — other terminal states
   *
   * We use 'length' to trigger an auto-continue call so the user sees the
   * full output instead of a truncated response.
   */
  finishReason: string | null;
}> {
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
    const err: any = new Error(`OpenCode API error (${response.status}): ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  if (!response.body) throw new Error('OpenCode API returned no response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let ttfbMs: number | null = null;
  let finishReason: string | null = null;

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
      if (data === '[DONE]') {
        // Reasoning-as-content fallback: if the model returned only
        // reasoning_content (no content), surface it as content instead
        // of returning empty.
        if (!content && reasoning) {
          content = reasoning;
          onChunk?.(content);
        }
        return { content, reasoning, ttfbMs, finishReason };
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            onChunk?.(delta.content);
          }
          if (typeof delta.reasoning_content === 'string') {
            reasoning += delta.reasoning_content;
          }
        }
        // Capture finish_reason as soon as it appears. The SSE stream emits
        // it on the final chunk BEFORE [DONE]. We need it to decide whether
        // to auto-continue (see opencodeChatCompletion below).
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Partial JSON across chunks.
      }
    }
  }
  // Stream ended without an explicit [DONE]. Apply the same reasoning
  // fallback in case the model finished on a reasoning-only flush.
  if (!content && reasoning) {
    content = reasoning;
    onChunk?.(content);
  }
  return { content, reasoning, ttfbMs, finishReason };
}

// Generic continuation prompt used when the model returns finish_reason:'length'.
// This does NOT modify the caller's system/user prompts — it's a fixed
// instruction appended only when a continuation round is needed. Works for
// both free-form text AND JSON output: the model sees its partial output
// in the assistant message and continues from exactly where it left off.
const CONTINUE_USER_PROMPT =
  'Continue your previous response from exactly where you left off. Do not repeat any text you have already produced. Do not add any preamble, acknowledgements, or summary — output only the continuation.';

// Max auto-continue rounds when the model returns finish_reason === 'length'.
// Each round re-calls the model with the partial output appended as an
// assistant message, asking it to continue. 3 rounds gives up to 4 total
// calls × max_tokens each of effective output capacity.
const DEFAULT_MAX_CONTINUATIONS = 3;

/**
 * Determines if an error is retryable (timeout, rate limit, or server error).
 */
function isRetryableError(err: any): boolean {
  const status = err?.status || err?.statusCode || 0;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.code)) return true;
  const errName: string = err?.constructor?.name || '';
  if (['APIConnectionError', 'APITimeoutError', 'ConnectionError'].includes(errName)) return true;
  const msg: string = (err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('econnreset')) return true;
  return false;
}

export async function opencodeChatCompletion(
  opts: OpencodeCallOptions,
): Promise<OpencodeCallResult> {
  const model = opts.model || DEFAULT_OPENCODE_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const reasoningEffort = opts.reasoningEffort ?? 'low';
  const sessionId = opts.sessionId ?? newOpencodeSessionId();
  const maxContinuations = DEFAULT_MAX_CONTINUATIONS;
  const callStart = Date.now();

  log(
    opts,
    `start  model=${model} max_tokens=${opts.maxTokens ?? 4096} temp=${opts.temperature ?? 0.3} timeout=${timeoutMs}ms reasoning_effort=${reasoningEffort} session=${sessionId} max_continuations=${maxContinuations}`,
  );

  // Accumulate across the original call + any continuation rounds.
  let fullContent = '';
  let fullReasoning = '';
  let attemptsUsed = 0;
  let continuations = 0;
  let stillTruncated = false;
  let lastErr: Error | null = null;

  // The messages array may grow across continuation rounds: each round
  // appends the assistant's partial output + the generic continue prompt.
  let roundMessages = opts.messages;

  // Loop: original call (round 0) + up to maxContinuations continuation rounds.
  for (let round = 0; round <= maxContinuations; round++) {
    let roundResult: { content: string; reasoning: string; ttfbMs: number | null; finishReason: string | null } | null = null;

    // ─── Per-round retry loop (handles transient errors) ───────────
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const result = await streamOnce(
          {
            model,
            messages: roundMessages,
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
        attemptsUsed++;
        roundResult = result;

        const elapsed = Date.now() - callStart;
        log(
          opts,
          `round=${round} ttfb=${result.ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${result.content.length} (total=${fullContent.length + result.content.length}) reasoning_chars=${result.reasoning.length} finish_reason=${result.finishReason ?? 'n/a'} session=${sessionId}`,
        );
        break; // success — exit retry loop, move to continuation check
      } catch (err: unknown) {
        clearTimeout(timeout);
        const e = err as Error;
        lastErr = e;
        if (e.name === 'AbortError') {
          log(opts, `TIMEOUT round=${round} attempt=${attempt} after ${timeoutMs}ms session=${sessionId}`);
        } else {
          log(opts, `ERROR round=${round} attempt=${attempt}: ${e.name}: ${e.message.slice(0, 200)} session=${sessionId}`);
        }
        // Non-retryable errors surface immediately.
        if (!isRetryableError(e) && e.name !== 'AbortError') break;
        if (attempt < maxRetries) {
          const backoff = 500 * attempt;
          log(opts, `retry  backing off ${backoff}ms before attempt ${attempt + 1} session=${sessionId}`);
          await sleep(backoff);
        }
      }
    }

    if (!roundResult) {
      // Round failed — if this is round 0, throw the error (no content at all).
      // If we already have partial content from earlier rounds, return it
      // with truncated=true so the caller knows the output is incomplete.
      if (round === 0) {
        throw new Error(
          `OpenCode call failed after ${maxRetries} attempts (session=${sessionId}): ${lastErr?.name}: ${lastErr?.message}`,
        );
      }
      stillTruncated = true;
      log(opts, `TRUNCATED at round ${round} — upstream error after ${continuations} continuation(s) session=${sessionId}`);
      break;
    }

    // Accumulate across rounds.
    fullContent += roundResult.content;
    fullReasoning += roundResult.reasoning;

    if (roundResult.finishReason !== 'length') {
      // Model finished naturally — no continuation needed.
      stillTruncated = false;
      break;
    }

    // finish_reason === 'length' → output was truncated.
    // If we have continuation budget left, append the partial output as
    // an assistant message + the generic continue prompt, and loop again.
    if (round >= maxContinuations || !roundResult.content) {
      stillTruncated = true;
      log(opts, `TRUNCATED after ${round + 1} round(s) — exhausted maxContinuations=${maxContinuations}. Output ends mid-structure. session=${sessionId}`);
      break;
    }

    continuations++;
    log(opts, `continue  round=${round + 1}/${maxContinuations} — model hit max_tokens, resuming from char ${fullContent.length} session=${sessionId}`);

    // Build the next round's messages: original + assistant's partial + continue prompt.
    roundMessages = [
      ...opts.messages,
      { role: 'assistant' as const, content: roundResult.content },
      { role: 'user' as const, content: CONTINUE_USER_PROMPT },
    ];
  }

  if (!fullContent) {
    throw new Error(
      `OpenCode produced no content after ${attemptsUsed} attempt(s) (session=${sessionId}): ${lastErr?.name}: ${lastErr?.message}`,
    );
  }

  const elapsed = Date.now() - callStart;
  log(
    opts,
    `done   elapsed=${elapsed}ms content_chars=${fullContent.length} reasoning_chars=${fullReasoning.length} attempts=${attemptsUsed} continuations=${continuations} truncated=${stillTruncated} session=${sessionId}`,
  );

  return {
    content: fullContent,
    reasoning: fullReasoning,
    model,
    elapsedMs: elapsed,
    attempts: attemptsUsed,
    continuations,
    truncated: stillTruncated,
  };
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
