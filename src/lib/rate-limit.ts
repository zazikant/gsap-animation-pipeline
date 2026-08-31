/**
 * Rate-limit handling with per-model cooldown multipliers.
 *
 * Adaptive cooldown rules (NVIDIA gpt-oss-120b is slow + flaky on free tier):
 *   - Succeeded on first attempt:  10s  (× cooldownMultiplier)
 *   - Succeeded after retries:     30s  (× cooldownMultiplier)
 *   - Failed all attempts:         60s  (× cooldownMultiplier)
 *   - Rate-limit error detected:   60s  (× cooldownMultiplier)
 *   - Capped at MAX_COOLDOWN_S × multiplier
 *
 * Per-model multipliers (see lib/models.ts):
 *   - NVIDIA: 1.0 → standard cooldowns (the gsap pipeline's default)
 *   - OpenCode: 0.0 → skip cooldowns entirely (fast & reliable)
 *
 * Pattern lifted from `ax-translator/src/app/page.tsx:727-786` and
 * `google-ads-subagent-vercel/lib/models.ts` (cooldownMultiplier field).
 */

export const MAX_COOLDOWN_S = 60;
export const QUICK_COOLDOWN_S = 10;
export const FLAKY_COOLDOWN_S = 30;
export const RATE_LIMIT_COOLDOWN_S = 60;

export interface CooldownDecision {
  delaySec: number;
  reason: 'success-fast' | 'success-after-retries' | 'failed' | 'rate-limit';
  message: string;
}

export function decideCooldown(opts: {
  attempts: number;
  succeeded: boolean;
  error?: string;
  cooldownMultiplier?: number;
}): CooldownDecision {
  const mul = opts.cooldownMultiplier ?? 1;
  const errorText = (opts.error ?? '').toLowerCase();
  const isRateLimitError = /rate.?limit|429|too many requests/i.test(errorText);

  // Multiplier of 0 means "skip cooldowns entirely" — used for fast providers.
  if (mul === 0) {
    return {
      delaySec: 0,
      reason: 'success-fast',
      message: 'Fast provider — skipping cooldown',
    };
  }

  if (!opts.succeeded) {
    if (isRateLimitError) {
      return {
        delaySec: Math.max(1, Math.round(RATE_LIMIT_COOLDOWN_S * mul)),
        reason: 'rate-limit',
        message: 'Rate-limit error detected — waiting for window reset',
      };
    }
    return {
      delaySec: Math.max(1, Math.round(FLAKY_COOLDOWN_S * mul)),
      reason: 'failed',
      message: 'Previous call failed — waiting before retry',
    };
  }

  if (opts.attempts > 1) {
    return {
      delaySec: Math.max(1, Math.round(FLAKY_COOLDOWN_S * mul)),
      reason: 'success-after-retries',
      message: `Succeeded after ${opts.attempts} retries — waiting for safety`,
    };
  }

  return {
    delaySec: Math.max(1, Math.round(QUICK_COOLDOWN_S * mul)),
    reason: 'success-fast',
    message: 'Success on first try — quick breather',
  };
}

export async function cooldownWithCountdown(
  totalSec: number,
  onTick?: (remainingSec: number) => void,
  tickIntervalMs = 1000,
): Promise<void> {
  if (totalSec <= 0) {
    onTick?.(0);
    return;
  }
  const start = Date.now();
  const totalMs = totalSec * 1000;

  while (true) {
    const elapsed = Date.now() - start;
    const remainingMs = totalMs - elapsed;
    if (remainingMs <= 0) break;

    const remainingSec = Math.ceil(remainingMs / 1000);
    onTick?.(remainingSec);

    if (remainingMs <= tickIntervalMs) break;
    await sleep(Math.min(tickIntervalMs, remainingMs));
  }
  onTick?.(0);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
