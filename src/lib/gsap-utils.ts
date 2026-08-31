/**
 * GSAP code parsing & validation utilities — used by the LangGraph pipeline.
 *
 * The parser:
 *   - Strips markdown code fences (\`\`\`...\`\`\`)
 *   - Detects IIFE wrapping vs named-entry-point patterns
 *   - Normalizes whitespace + extracts the canonical `initAnimation()` shape
 *
 * The validator:
 *   - Verifies presence of `gsap.*` calls
 *   - Verifies the code references selectors from the active widget profile
 *   - Checks for common bugs (missing onerror on dynamic script loads,
 *     unrevertable matchMedia contexts, wrong selectors, etc.)
 *   - Scores overall quality 0-100
 */

import type { WidgetProfile } from './widget-profiles';

export interface ValidationResult {
  isValid: boolean;
  qualityScore: number;
  issues: string[];
}

// ─── Stripping & normalization ────────────────────────────────────────────────

/**
 * Remove leading/trailing markdown code fences and language tags.
 */
export function stripCodeFences(code: string): string {
  return code
    .replace(/^```(?:javascript|js|typescript|ts|jsx|tsx)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

/**
 * Detect whether the code is an IIFE (self-invoking) or a named function
 * that the user must call manually.
 */
export function detectEntryPoint(code: string): 'iife' | 'named' | 'plain' {
  // IIFE: starts with `(function...` or `(async function...` or `(()=>`
  const trimmed = code.trim();
  if (/^\s*\(?\s*(?:async\s+)?function\b/.test(trimmed) || /^\s*\(?\s*\(\s*\)\s*=>/.test(trimmed)) {
    // Check if it ends with `();` (IIFE invocation)
    if (/\)\s*\(\s*\)\s*;?\s*$/.test(trimmed)) return 'iife';
    return 'named';
  }
  // `function initAnimation() { ... }` defined at top level
  if (/^\s*function\s+\w+\s*\(/.test(trimmed)) return 'named';
  return 'plain';
}

/**
 * Normalize the code into a canonical `initAnimation()` form so the GTM guide
 * can wrap it consistently. This is what we ship as `gsapCode` in the final
 * response.
 *
 * - IIFE  → unwrap into a function declaration, return that
 * - Named → leave as-is (assume the user calls it correctly)
 * - Plain → wrap in `function initAnimation(){ ... }`
 */
export function normalizeGsapCode(code: string): string {
  const stripped = stripCodeFences(code);
  const form = detectEntryPoint(stripped);

  if (form === 'iife') {
    // Try to extract the inner code so we can wrap it
    // e.g. `(function(){ ... })()` → `function initAnimation(){ ... }`
    // Simple heuristic: if it starts with `(function()...` end with `})()`
    const match = stripped.match(/^\s*\(?\s*(?:async\s+)?function\s*\w*\s*\(\s*\)\s*\{([\s\S]*?)\}\s*\)\s*\(\s*\)\s*;?\s*$/i);
    if (match) {
      return `function initAnimation() {${match[1]}\n}\ninitAnimation();`;
    }
    return stripped;
  }

  if (form === 'named') {
    return stripped;
  }

  // Plain — wrap
  return `function initAnimation() {\n${stripped}\n}\ninitAnimation();`;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const STRONG_SCORE_THRESHOLD = 80;
const ISSUES_PENALTY = 12;

/**
 * Sandbox check on generated GSAP code.
 */
export function validateGsapCode(code: string, profile: WidgetProfile | null): ValidationResult {
  const issues: string[] = [];

  if (!code || code.trim().length < 20) {
    return { isValid: false, qualityScore: 0, issues: ['Generated code is empty or too short'] };
  }

  if (!/gsap\./.test(code)) {
    issues.push('No gsap.* call detected');
  }

  // Check that the code references the container selector (or at least one of
  // the widget-inner selectors). Otherwise it will silently select nothing.
  if (profile) {
    const allSelectors = profile.selectors;
    const fragmentSelectors = allSelectors.map((s) => {
      const parts = s.split(' ');
      return parts[parts.length - 1].replace(/[.#]/g, '');
    });
    const foundSelector = fragmentSelectors.some((frag) =>
      code.toLowerCase().includes(frag.toLowerCase()),
    );
    if (!foundSelector) {
      issues.push(
        `Code doesn't reference any selector from the widget profile (expected one of: ${allSelectors.slice(0, 3).join(', ')})`,
      );
    }
  }

  if (!/ScrollTrigger|gsap\.timeline|gsap\.to\(|gsap\.fromTo\(/.test(code)) {
    issues.push('No animation primitive (ScrollTrigger, timeline, or to/fromTo) found');
  }

  // Detect two known anti-patterns
  if (/matchMedia\s*\(/.test(code) && !/\.revert\s*\(\s*\)/.test(code)) {
    issues.push('matchMedia() context is never .revert()ed — leaks listeners on SPA route changes');
  }

  if (/document\.createElement\s*\(\s*['"]script['"]/.test(code) && !/onerror/i.test(code)) {
    issues.push('Dynamic <script> load has no onerror handler — CDN failures fail silently');
  }

  // Detect multi-CDN load (anti-pattern from previous output)
  const cdnMatches = code.match(/https?:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)/g);
  if (cdnMatches && new Set(cdnMatches).size > 1) {
    issues.push(`Loads GSAP from multiple CDNs (${Array.from(new Set(cdnMatches)).join(', ')}) — causes version conflicts`);
  }

  // Detect too-short output (likely truncated)
  if (code.length < 80) {
    issues.push('Code is suspiciously short (<80 chars)');
  }

  // Compute score
  const deduction = Math.min(100, issues.length * ISSUES_PENALTY);
  const qualityScore = Math.max(0, 100 - deduction);
  const isValid = qualityScore >= STRONG_SCORE_THRESHOLD;

  return { isValid, qualityScore, issues };
}
