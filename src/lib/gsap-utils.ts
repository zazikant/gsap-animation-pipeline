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
 *   - Checks for common bugs:
 *       * missing onerror on dynamic script loads
 *       * onerror callback that just re-calls the success path (no-op fix)
 *       * unrevertable matchMedia contexts
 *       * wrong selectors
 *       * `document.createElement` for element kinds already in the widget tree
 *         (this was the root cause of the 4/10 rating — script built duplicate
 *         dots/buttons instead of querying the ones Elementor/Swiper already
 *         rendered)
 *       * unconditional `ScrollTrigger.refresh()` outside a typeof-guard
 *       * carousel `goTo` without an `isAnimating` re-entry guard
 *       * toggle of `position: relative/absolute` on slides (causes layout
 *         jumps after the first transition)
 *   - Scores overall quality 0-100
 */

import type { WidgetProfile } from './widget-profiles';
import type { ElementorWidgetValidated } from './elementor-widget';

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
    // Check if it ends with `());` (IIFE invocation)
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

  // ─── Script-load anti-patterns ────────────────────────────────────────────
  if (/document\.createElement\s*\(\s*['"]script['"]/.test(code)) {
    if (!/onerror/i.test(code)) {
      issues.push('Dynamic <script> load has no onerror handler — CDN failures fail silently');
    } else {
      // Detect the "onerror = success path" bug. We look for a loadScript helper
      // whose onerror callback is literally the same identifier as the onload
      // callback (e.g. `loadScript(url, start, start)` or `loadScript(url, cb, cb)`).
      const suspectPattern = /loadScript\s*\(\s*[^,]+,\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)/;
      if (suspectPattern.test(code)) {
        issues.push(
          'loadScript onerror callback is the same function as onload — a failed CDN load will still call the success path and throw on gsap.* (was: 4/10 bug)',
        );
      }
    }
  }

  // Detect multi-CDN load (anti-pattern from previous output)
  const cdnMatches = code.match(/https?:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)/g);
  if (cdnMatches && new Set(cdnMatches).size > 1) {
    issues.push(`Loads GSAP from multiple CDNs (${Array.from(new Set(cdnMatches)).join(', ')}) — causes version conflicts`);
  }

  // ─── ScrollTrigger.refresh() guard (NEW — 4/10 bug) ───────────────────────
  if (/ScrollTrigger\s*\.\s*refresh\s*\(\s*\)/.test(code)) {
    const hasGuard =
      /typeof\s+ScrollTrigger\s*[!=]==?\s*['"]undefined['"]/.test(code) ||
      /typeof\s+ScrollTrigger\s*[!=]==?\s*['"]undefined['"]/.test(code) ||
      /ScrollTrigger\s*[!=]===\s*undefined/.test(code) ||
      /window\.ScrollTrigger\b/.test(code) ||
      /gsap\s*\.\s*registerPlugin\s*\(\s*ScrollTrigger\s*\)/.test(code) ||
      /gsap\s*\.\s*core\s*\.\s*globals\s*\(\s*\)\s*\.\s*ScrollTrigger/.test(code);
    if (!hasGuard) {
      issues.push(
        'ScrollTrigger.refresh() called without a typeof-guard or registerPlugin — will throw on resize if the page has GSAP but not ScrollTrigger',
      );
    }
  }

  // ─── matchMedia revert ────────────────────────────────────────────────────
  if (/matchMedia\s*\(/.test(code) && !/\.revert\s*\(\s*\)/.test(code)) {
    issues.push('matchMedia() context is never .revert()ed — leaks listeners on SPA route changes');
  }

  // ─── Detect too-short output (likely truncated) ───────────────────────────
  if (code.length < 80) {
    issues.push('Code is suspiciously short (<80 chars)');
  }

  // Compute score
  const deduction = Math.min(100, issues.length * ISSUES_PENALTY);
  const qualityScore = Math.max(0, 100 - deduction);
  const isValid = qualityScore >= STRONG_SCORE_THRESHOLD;

  return { isValid, qualityScore, issues };
}

// ─── Cross-cutting code ↔ tree validation ────────────────────────────────────

/**
 * Elementor widget kind → typical HTML tag name. Used to flag
 * `document.createElement` calls for elements that the tree already provides.
 */
const KIND_TO_TAG: Record<ElementorWidgetValidated['kind'], string[]> = {
  Container: ['div', 'section'],
  Image: ['img'],
  Heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  Text: ['p', 'span'],
  Button: ['button', 'a'],
  Icon: ['i', 'span'],
  Divider: ['hr', 'div'],
};

export interface CrossValidationResult {
  isValid: boolean;
  issues: string[];
}

/**
 * Code-vs-tree cross validation. Catches structural mismatches that
 * either side alone wouldn't surface:
 *   - `document.createElement` for an element kind that's already in the tree
 *     (this was the 4/10 root cause — script built duplicate controls)
 *   - carousel re-entry: a `goTo`/`advance` function with no re-entry guard
 *   - position toggle: `position: relative` and `position: absolute` both
 *     assigned to the same slide identifier (the "layout jump" bug)
 */
export function validateCodeAgainstTree(
  code: string,
  tree: ElementorWidgetValidated | null,
  profile: WidgetProfile | null,
): CrossValidationResult {
  const issues: string[] = [];

  // Tree-present kinds: collect every kind reachable in the tree.
  const presentKinds = new Set<ElementorWidgetValidated['kind']>();
  if (tree) {
    const walk = (n: ElementorWidgetValidated): void => {
      presentKinds.add(n.kind);
      n.children?.forEach(walk);
    };
    walk(tree);
  }

  // Profile repeats imply the kind exists even if the tree LLM-response was
  // missing it (rare but possible).
  if (profile) {
    const walk = (n: ElementorWidgetValidated): void => {
      presentKinds.add(n.kind);
      n.children?.forEach(walk);
    };
    walk(profile.treeTemplate);
  }

  // ─── document.createElement for tree-present kinds ─────────────────────────
  // For each kind present in the tree, look for createElement of the
  // matching HTML tag. Exempt the `script` tag (which is required for GSAP
  // CDN loading) and the `style` tag (which is sometimes injected too).
  for (const [kind, tags] of Object.entries(KIND_TO_TAG) as Array<
    [ElementorWidgetValidated['kind'], string[]]
  >) {
    if (!presentKinds.has(kind)) continue;
    for (const tag of tags) {
      const re = new RegExp(`document\\.createElement\\(\\s*['"]${tag}['"]\\s*\\)`, 'g');
      const matches = code.match(re);
      if (matches && matches.length > 0) {
        issues.push(
          `document.createElement('${tag}') found ${matches.length} time(s) but the tree already provides a ${kind} node — querySelector it instead (was: 4/10 root cause)`,
        );
      }
    }
  }

  // ─── Carousel re-entry guard (NEW — 4/10 bug) ─────────────────────────────
  // Heuristic: profile is a carousel (testimonial OR code references
  // slide/bullet patterns) AND a goTo/advance/nextSlide function exists AND
  // there's no boolean flag set/cleared inside it.
  const isCarousel =
    profile?.widgetType === 'slides' ||
    /querySelectorAll\s*\(\s*['"]\.swiper-slide/.test(code) ||
    /querySelectorAll\s*\(\s*['"]\.swiper-pagination-bullet/.test(code) ||
    /querySelectorAll\s*\(\s*['"]\.[\w-]*slide/.test(code) ||
    /querySelectorAll\s*\(\s*['"]\.[\w-]*dot/.test(code);

  if (isCarousel) {
    const hasGoTo =
      /\bfunction\s+goTo\s*\(/.test(code) ||
      /\bfunction\s+advance\s*\(/.test(code) ||
      /\bfunction\s+nextSlide\s*\(/.test(code);
    if (hasGoTo) {
      const hasGuard =
        /\bisAnimating\s*=\s*true\b/.test(code) ||
        /\binTransition\s*=\s*true\b/.test(code) ||
        /\bif\s*\(\s*isAnimating\s*\)/.test(code) ||
        /\bif\s*\(\s*inTransition\s*\)/.test(code) ||
        /\bif\s*\(\s*animating\s*\)/.test(code);
      if (!hasGuard) {
        issues.push(
          'Carousel goTo/advance/nextSlide has no isAnimating re-entry guard — rapid clicks stack overlapping GSAP timelines',
        );
      }
    }

    // ─── Swiper conflict (NEW — architectural bug) ─────────────────────────
    // The Elementor Slides widget ships a live Swiper instance that already owns:
    //   - click handlers on .swiper-button-prev / .swiper-button-next
    //   - click handlers on .swiper-pagination-bullet
    //   - autoplay timer
    //   - the active bullet class (.swiper-pagination-bullet-active)
    //   - slide transitions (via translate3d)
    //
    // If the script attaches ITS OWN click listener to those elements, preventDefault()
    // only stops anchor navigation — it does NOT stop Swiper's native listener.
    // Both listeners fire; the script's state diverges from Swiper's activeIndex.
    //
    // The right architecture: get the live Swiper instance (root.swiper, or poll briefly)
    // and hook swiper.on('slideChangeTransitionEnd', ...) for entrance animations only.
    // Don't fight Swiper.
    const fightsSwiper =
      /\.swiper-button-(?:prev|next)['"][^)]*\)/.test(code) &&
      /addEventListener\s*\(\s*['"]click/.test(code);

    const fightsSwiperBullets =
      /\.swiper-pagination-bullet['"][^)]*\)/.test(code) &&
      /addEventListener\s*\(\s*['"]click/.test(code);

    if (fightsSwiper) {
      issues.push(
        "Script attaches its own click listener to .swiper-button-prev/next — Swiper already has native listeners there. preventDefault() doesn't stop other listeners on the same element. Get the live Swiper instance (root.swiper) and hook swiper.on('slideChangeTransitionEnd', ...) instead.",
      );
    }
    if (fightsSwiperBullets) {
      issues.push(
        "Script attaches its own click listener to .swiper-pagination-bullet — Swiper already has native listeners. Either let Swiper handle navigation OR call swiper.destroy() first to take over completely.",
      );
    }
  }

  // ─── Position toggle (NEW — 4/10 layout-jump bug) ─────────────────────────
  // Detect the "toggle position: absolute/relative" hack. If both are
  // assigned to slide-like identifiers in close proximity, that's the bug.
  // We look for the pattern:
  //   `slide.style.position = 'absolute'` AND
  //   `slide.style.position = 'relative'` (or s.style.position)
  // anywhere in the same code.
  const absPattern = /\.style\.position\s*=\s*['"]absolute['"]/g;
  const relPattern = /\.style\.position\s*=\s*['"]relative['"]/g;
  if ((code.match(absPattern) ?? []).length > 0 && (code.match(relPattern) ?? []).length > 0) {
    issues.push(
      "Code toggles 'position: absolute' and 'position: relative' on the same elements — set all slides to absolute at init and leave them there to avoid layout jumps mid-transition",
    );
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}