/**
 * NVIDIA Chat Completions client — streaming edition with controlled calls.
 *
 * Pattern lifted from `ax-translator/src/lib/nvidia-client.ts`. Each call:
 *   - Streams the response (chunk-by-chunk) from gpt-oss-20b
 *   - Has a hard per-call timeout (DEFAULT_CALL_TIMEOUT_MS)
 *   - Retries once with backoff on transient failures
 *   - Emits structured log lines via onLog so the UI can show progress
 *
 * Base URL: https://integrate.api.nvidia.com/v1
 * Default model: openai/gpt-oss-20b
 */

import { sleep } from './rate-limit';

const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

export const DEFAULT_CALL_TIMEOUT_MS = 180_000;
// Single attempt per nvidiaChatCompletion call. Pipeline-level retry
// (retryGuardNode → generateNode) handles resiliency with a cooldown, which
// is more appropriate than an immediate same-prompt retry — particularly on
// timeouts, where retrying the same oversized prompt is doomed to time out
// again and burns the entire Vercel maxDuration budget.
export const DEFAULT_MAX_RETRIES = 1;

export interface NvidiaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NvidiaCallOptions {
  model?: string;
  messages: NvidiaChatMessage[];
  temperature?: number;
  maxTokens?: number;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Reasoning effort for reasoning models (e.g. gpt-oss-20b). 'low'/'medium'/'high'. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  onLog?: (line: string) => void;
  onChunk?: (text: string) => void;
}

export interface NvidiaCallResult {
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

function log(opts: NvidiaCallOptions, msg: string) {
  const line = `[nvidia] ${msg}`;
  console.log(line);
  opts.onLog?.(line);
}

async function streamOnce(
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
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
  const response = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    const err: any = new Error(`NVIDIA API error (${response.status}): ${errText.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  if (!response.body) throw new Error('NVIDIA API returned no response body');

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
        // to auto-continue (see nvidiaChatCompletion below).
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch {
        // Partial JSON across chunks — wait for more bytes.
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
// calls × max_tokens each of effective output capacity — enough for large
// GSAP animation code + elementor tree JSON that would otherwise truncate.
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

export async function nvidiaChatCompletion(
  opts: NvidiaCallOptions,
): Promise<NvidiaCallResult> {
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxContinuations = DEFAULT_MAX_CONTINUATIONS;
  const callStart = Date.now();

  log(
    opts,
    `start  model=${model} max_tokens=${opts.maxTokens ?? 2048} temp=${opts.temperature ?? 0.7} timeout=${timeoutMs}ms max_continuations=${maxContinuations}`,
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
            max_tokens: opts.maxTokens ?? 2048,
            temperature: opts.temperature ?? 0.7,
            // CRITICAL: gpt-oss-20b is a reasoning model. Without
            // reasoning_effort:'low', it spends 40s+ on internal reasoning
            // for complex prompts (vs 0-2s with 'low'). Measured:
            //   - no reasoning_effort: 61.8s total, 4268 reasoning chars
            //   - reasoning_effort:'low': 37.9s total, 164 reasoning chars
            // The 'low' setting is what ax-translator relies on implicitly
            // for fast translations — gpt-oss-20b defaults to high reasoning
            // when the parameter is absent, despite documentation suggesting
            // otherwise.
            ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : { reasoning_effort: 'low' }),
          },
          opts.apiKey,
          controller.signal,
          opts.onChunk,
        );
        clearTimeout(timeout);
        attemptsUsed++;
        roundResult = result;

        const elapsed = Date.now() - callStart;
        log(
          opts,
          `round=${round} ttfb=${result.ttfbMs ?? 'n/a'}ms  done attempt=${attempt} elapsed=${elapsed}ms content_chars=${result.content.length} (total=${fullContent.length + result.content.length}) reasoning_chars=${result.reasoning.length} finish_reason=${result.finishReason ?? 'n/a'}`,
        );
        break; // success — exit retry loop, move to continuation check
      } catch (err: unknown) {
        clearTimeout(timeout);
        const e = err as Error;
        lastErr = e;
        if (e.name === 'AbortError') {
          log(opts, `TIMEOUT round=${round} attempt=${attempt} after ${timeoutMs}ms`);
          // Replace generic AbortError with an actionable message — without
          // this, users see "NVIDIA call failed after 1 attempts: AbortError:
          // The user aborted a request" which gives no clue what to do.
          lastErr = new Error(
            `LLM timed out after ${Math.round(timeoutMs / 1000)}s. The reasoning model ` +
            `gpt-oss-20b is unpredictable — try a shorter/simpler intent, switch to ` +
            `the faster GLM 5.1 model in the dropdown, or run locally with ` +
            `\`npm run dev\` (no 60s Vercel cap).`,
          );
        } else {
          log(opts, `ERROR round=${round} attempt=${attempt}: ${e.name}: ${e.message.slice(0, 200)}`);
        }
        // Non-retryable errors surface immediately.
        if (!isRetryableError(e) && e.name !== 'AbortError') break;
        if (attempt < maxRetries) {
          const backoff = 500 * attempt;
          log(opts, `retry  backing off ${backoff}ms before attempt ${attempt + 1}`);
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
          `NVIDIA call failed after ${maxRetries} attempts: ${lastErr?.name}: ${lastErr?.message}`,
        );
      }
      stillTruncated = true;
      log(opts, `TRUNCATED at round ${round} — upstream error after ${continuations} continuation(s)`);
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
      log(opts, `TRUNCATED after ${round + 1} round(s) — exhausted maxContinuations=${maxContinuations}. Output ends mid-structure.`);
      break;
    }

    continuations++;
    log(opts, `continue  round=${round + 1}/${maxContinuations} — model hit max_tokens, resuming from char ${fullContent.length}`);

    // Build the next round's messages: original + assistant's partial + continue prompt.
    roundMessages = [
      ...opts.messages,
      { role: 'assistant' as const, content: roundResult.content },
      { role: 'user' as const, content: CONTINUE_USER_PROMPT },
    ];
  }

  if (!fullContent) {
    throw new Error(
      `NVIDIA produced no content after ${attemptsUsed} attempt(s): ${lastErr?.name}: ${lastErr?.message}`,
    );
  }

  const elapsed = Date.now() - callStart;
  log(
    opts,
    `done   elapsed=${elapsed}ms content_chars=${fullContent.length} reasoning_chars=${fullReasoning.length} attempts=${attemptsUsed} continuations=${continuations} truncated=${stillTruncated}`,
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

export async function callNvidiaLLM(
  systemPrompt: string,
  userContent: string,
  apiKey: string,
  model?: string,
  maxTokens: number = 2048,
  temperature: number = 0.3,
  onLog?: (line: string) => void,
  onChunk?: (text: string) => void,
): Promise<string> {
  const result = await nvidiaChatCompletion({
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
  });
  return result.content;
}
