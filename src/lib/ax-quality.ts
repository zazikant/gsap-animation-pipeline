/**
 * AX DSPy quality gate — ported word-to-word from atomic-graph-opencode
 * (the "Bible" AX DSPy reference implementation), serving this repo's
 * output (GenerateResponse with gsapCode + containerTree).
 *
 * The Bible pipeline is: EXTRACT → LINK → VALIDATE → REFINE with a
 * validate→refine loop gated by a 0.75 threshold. This module provides the
 * VALIDATE / REFINE layer for the GSAP generation graph:
 *
 * - AX_VALIDATE_SYSTEM_PROMPT — the Bible's VALIDATE rubric (weighted axes,
 *   exact JSON format, scoring bands, "Be FAIR") adapted to GSAP code + tree
 * - AX_REFINE_SYSTEM_PROMPT  — the Bible's REFINE prompt ("fix the identified
 *   issues while preserving what already works") as the retry system prompt
 * - compileRefinePrompt()    — DSPy-style Module.compile(): surgical fix
 *   context compiled from the full error history, word-to-word
 * - getStageTemperature()    — generate=0.3, validate=0.1, refine=0.2
 * - parseLLMJson() + recoverTruncatedJSON() — robust JSON parsing chain for
 *   the validate response AND the tree JSON extraction
 * - callWithRetryAwareness() — rate-limit / transient error detection with
 *   ErrorEntry history (feeds compileRefinePrompt on the next attempt)
 * - VALIDATION_THRESHOLD 0.75, MAX_ITERATIONS 3 — Bible defaults
 *
 * Echo detection (isEcho) is intentionally NOT ported: for code generation
 * the output domain (JS + JSON) never echoes the input domain (natural-
 * language intent), and degenerate outputs are already caught by the
 * static `gsap.` presence check in validateNode.
 */

// ─── Constants (from atomic-graph-opencode) ──────────────────────────────────

/** Minimum validation score (0.0-1.0) required to accept the output.
 *  Ported from atomic-graph-opencode's default threshold (0.75). */
export const VALIDATION_THRESHOLD = 0.75;

/** Maximum pipeline iterations (validate → refine loops).
 *  Ported from atomic-graph-opencode's default (3). */
export const MAX_ITERATIONS = 3;

// ─── DSPy-style Error Tracking (from atomic-graph-opencode) ─────────────────

export interface ErrorEntry {
  attempt: number;
  stage: 'generate' | 'validate' | 'refine';
  error: string;
  issues?: string[];
}

/** Validation result shape — ported word-to-word from atomic-graph-opencode's
 *  validate step: score is 0.0-1.0 with issues + suggestions lists. */
export interface AxValidationResult {
  score: number;
  issues: string[];
  suggestions: string[];
}

// ─── VALIDATE — quality-aware self-critique (ported from atomic-graph) ───────
// Same structure word-to-word: weighted axes, exact JSON format, scoring
// bands, and the "Be FAIR" instruction. Axes adapted from the Bible's
// semantic-fidelity rubric to GSAP code + Elementor tree generation.

export const AX_VALIDATE_SYSTEM_PROMPT = `You are a GSAP animation quality reviewer. Evaluate the provided generated output and respond in JSON format.

Evaluate on these criteria (weight: intent fidelity > code correctness > structural integrity > GSAP best practices > selector accuracy):
1. INTENT FIDELITY: Does the code implement the behavior the user described? Minor style differences don't lower score.
2. CODE CORRECTNESS: Valid GSAP API usage, IIFE wrapper, gsap.context() cleanup, CDN loading with onerror guard.
3. STRUCTURAL INTEGRITY: Does the containerTree JSON match the code's selectors and the tree contract (Container root, kebab-case ids, leaf props)?
4. GSAP BEST PRACTICES: timelines/stagger where appropriate; ScrollTrigger guarded; no memory leaks.
5. SELECTOR ACCURACY: The container selector used exactly as provided.

Respond in this exact JSON format:
{
  "score": 0.85,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"]
}

Scoring:
- 0.90-1.00: Faithful implementation, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear intent + good output = high score. Don't invent reasons to lower it.
Only list issues affecting BEHAVIOR or STRUCTURE.`;

// ─── REFINE — targeted fixes (ported from atomic-graph) ──────────────────────
// Used as the retry system prompt: the model fixes the previous attempt's
// issues instead of generating from scratch.

export const AX_REFINE_SYSTEM_PROMPT = `You are a GSAP animation refinement engine. Fix the identified issues while preserving what already works.
Output ONLY the corrected output in the same TWO fenced blocks (code then JSON tree), nothing else.

CRITICAL OUTPUT RULES:
- Output ONLY the two fenced blocks. No prose outside the fences.
- Preserve the previous code where it is correct — only fix BEHAVIORAL or STRUCTURAL problems.
- Missing animation behavior? INFER it from the intent and add it.
- Wrong selector or tree shape? Replace it with the contract-correct version.
- Non-atomic or rambling timeline? TIGHTEN it.
- No speculative additions — never invent widget kinds outside the tree contract.
- Keep everything that already works — return the FULL corrected code fence AND JSON fence with unchanged parts as-is.`;

// ─── VALIDATE user prompt builder ────────────────────────────────────────────
// Ported word-to-word from atomic-graph-opencode's validate step user prompt,
// with long inputs truncated at 3000 chars (the Bible's note truncation).

export function buildValidateUserPrompt(input: {
  intent: string;
  code: string;
  treeJson: string;
}): string {
  const intentForValidation = input.intent.length > 3000
    ? input.intent.slice(0, 3000) + '\n… (intent truncated)'
    : input.intent;
  const codeForValidation = input.code.length > 3000
    ? input.code.slice(0, 3000) + '\n… (code truncated)'
    : input.code;
  const treeForValidation = input.treeJson.length > 1500
    ? input.treeJson.slice(0, 1500) + '\n… (tree truncated)'
    : input.treeJson;

  return `Evaluate this GSAP animation generation for quality and intent fidelity.

Axes (weight: intent fidelity > code correctness > structural integrity > GSAP best practices > selector accuracy):
1. INTENT FIDELITY: Does the code implement the behavior the user described? Minor style differences don't lower score.
2. CODE CORRECTNESS: Valid GSAP API usage, IIFE wrapper, gsap.context() cleanup, CDN loading with onerror guard.
3. STRUCTURAL INTEGRITY: Does the containerTree JSON match the code's selectors and the tree contract?
4. GSAP BEST PRACTICES: timelines/stagger where appropriate; ScrollTrigger guarded; no memory leaks.
5. SELECTOR ACCURACY: The container selector used exactly as provided.

Scoring:
- 0.90-1.00: Faithful implementation, minor wording differences only
- 0.75-0.89: Minor gaps
- 0.50-0.74: Significant gaps
- 0.00-0.49: Major problems

Be FAIR — clear intent + good output = high score. Don't invent reasons to lower it.

USER INTENT:
${intentForValidation}

GENERATED OUTPUT (code + tree JSON):
"""
${codeForValidation}

${treeForValidation}
"""

Return JSON: { "score": 0.85, "issues": ["..."], "suggestions": ["..."] }
Only list issues affecting BEHAVIOR or STRUCTURE.`;
}

// ─── compileRefinePrompt — pure function (DSPy-like) ─────────────────────────
// Like DSPy's Module.compile() — produces focused prompts based on error history.
// This is the ONLY place refinement context construction happens.
// Ported word-to-word from atomic-graph-opencode's compileRefinePrompt().

export function compileRefinePrompt(
  issues: string[],
  errorHistory: ErrorEntry[],
  stage: 'generate' | 'validate' | 'refine'
): string {
  // No errors yet — this is initial context
  if (errorHistory.length === 0 && issues.length === 0) {
    return `Initial ${stage} request for animation generation`;
  }

  // Build surgical context from error history (Mode B: surgical fix)
  const latestError = errorHistory.length > 0
    ? errorHistory[errorHistory.length - 1]
    : null;
  const previousErrors = errorHistory.slice(0, -1).map(e =>
    `  Attempt ${e.attempt} | ${e.stage}: ${e.error.substring(0, 200)}`
  ).join('\n');

  const issueContext = issues.length > 0
    ? `\nValidation issues to fix:\n${issues.map(i => `  - ${i}`).join('\n')}`
    : '';

  const errorContext = latestError
    ? `\nLatest error (attempt ${latestError.attempt}, stage ${latestError.stage}): ${latestError.error.substring(0, 300)}\n${latestError.issues ? `Issues: ${latestError.issues.join(', ')}` : ''}`
    : '';

  const previousContext = previousErrors.length > 0
    ? `\nPrevious errors — do NOT repeat these patterns:\n${previousErrors}`
    : '';

  return `Refinement context for stage "${stage}":${issueContext}${errorContext}${previousContext}`;
}

// ─── Stage-Specific Temperatures (from atomic-graph-opencode's axPipeline) ───
// Lower temperature = more deterministic/focused output.

export function getStageTemperature(stage: 'generate' | 'validate' | 'refine'): number {
  switch (stage) {
    case 'generate': return 0.3;  // Focused, deterministic generation
    case 'validate': return 0.1;  // Very deterministic — objective quality assessment
    case 'refine': return 0.2;    // Slightly creative — targeted fixes
    default: return 0.3;
  }
}

// ─── callWithRetryAwareness (ported from atomic-graph-opencode) ──────────────

/**
 * Wrap an async API call with rate-limit / transient error detection.
 * Records errors to the passed errorHistory array (mutated in place — pass a
 * working copy of the state array and return it in the node's state update)
 * for DSPy-style compileRefinePrompt().
 * Ported word-to-word from atomic-graph-opencode's callWithRetryAwareness().
 */
export async function callWithRetryAwareness<T>(
  fn: () => Promise<T>,
  errorHistory: ErrorEntry[],
  attempt: number,
  phaseLabel: string,
  stage: ErrorEntry['stage'],
  log?: (line: string) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Track error in history for DSPy-style compiled prompts
    errorHistory.push({
      attempt,
      stage,
      error: msg,
    });

    const isRateLimit =
      msg.includes('rate limit') ||
      msg.includes('Rate limit') ||
      msg.includes('429') ||
      msg.includes('retry attempt') ||
      msg.includes('too many requests');

    const isTransient =
      msg.includes('server error') ||
      msg.includes('Server Error') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('504') ||
      msg.includes('temporary');

    if (isRateLimit) {
      log?.(
        `[AX Pipeline] retrying | iteration=${attempt} — Rate limited during ${phaseLabel} — all proxy retries exhausted. Please wait and try again.`
      );
    } else if (isTransient) {
      log?.(
        `[AX Pipeline] retrying | iteration=${attempt} — Transient server error during ${phaseLabel} — all proxy retries exhausted. Try again shortly.`
      );
    }

    throw error;
  }
}

// ─── Robust JSON Parser (ported word-to-word from atomic-graph-opencode) ────

/**
 * Robust JSON parser for LLM outputs.
 * Strips markdown code fences, extracts JSON objects,
 * and handles reasoning model outputs that may contain
 * chain-of-thought text before/after the JSON.
 */
export function parseLLMJson<T>(raw: string): T {
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Strategy 1: Try direct parse of the full text
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Continue to more sophisticated parsing
  }

  // Strategy 2: Extract balanced JSON using bracket matching.
  const jsonStr = extractBalancedJSON(cleaned);
  if (jsonStr) {
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      // Continue to fixes
    }
  }

  // Strategy 3: Fix common issues like trailing commas
  if (jsonStr) {
    const fixed = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed) as T;
    } catch {
      // Continue
    }
  }

  // Strategy 4: Try the greedy regex as a last resort before failing
  const greedyMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (greedyMatch) {
    try {
      return JSON.parse(greedyMatch[1]) as T;
    } catch {
      // Greedy match didn't work either
    }
  }

  throw new Error(
    `Failed to parse LLM JSON response. Output length: ${raw.length} chars.\nFirst 300 chars: ${raw.slice(0, 300)}\nLast 300 chars: ${raw.slice(-300)}`
  );
}

/**
 * Extract a balanced JSON object or array from text that may contain
 * extra content before or after the JSON.
 */
function extractBalancedJSON(text: string): string | null {
  const startCurly = text.indexOf('{');
  const startSquare = text.indexOf('[');

  let startIdx: number;
  let openCh: string;
  let closeCh: string;

  if (startCurly === -1 && startSquare === -1) return null;
  if (startCurly === -1) {
    startIdx = startSquare;
    openCh = '[';
    closeCh = ']';
  } else if (startSquare === -1) {
    startIdx = startCurly;
    openCh = '{';
    closeCh = '}';
  } else {
    startIdx = Math.min(startCurly, startSquare);
    openCh = startIdx === startCurly ? '{' : '[';
    closeCh = startIdx === startCurly ? '}' : ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openCh || ch === '{' || ch === '[') {
      if (ch === openCh && depth === 0) {
        depth = 1;
      } else if (depth > 0) {
        depth++;
      }
    } else if (ch === closeCh || ch === '}' || ch === ']') {
      if (depth > 0) {
        depth--;
        if (depth === 0) {
          return text.slice(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Attempt to recover useful data from a truncated JSON response.
 * (Used as a fallback when parseLLMJson throws — e.g. a tree JSON block
 * truncated at max_tokens.)
 */
export function recoverTruncatedJSON<T>(raw: string): T | null {
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.search(/\{/);
  if (jsonStart === -1) return null;
  cleaned = cleaned.slice(jsonStart);

  const attempt1 = closeOpenBrackets(cleaned);
  if (attempt1 !== null) {
    return attempt1 as T;
  }

  const attempt2 = truncateToLastCompleteElement(cleaned);
  if (attempt2 !== null) {
    return attempt2 as T;
  }

  const attempt3 = recoverFieldsIndividually(cleaned);
  if (attempt3 !== null) {
    return attempt3 as T;
  }

  return null;
}

function closeOpenBrackets(cleaned: string): Record<string, unknown> | null {
  let curlyDepth = 0, squareDepth = 0;
  let inString = false, escape = false;

  for (const ch of cleaned) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') curlyDepth++;
    else if (ch === '}') curlyDepth--;
    else if (ch === '[') squareDepth++;
    else if (ch === ']') squareDepth--;
  }

  if (curlyDepth === 0 && squareDepth === 0) return null;

  let attempt = findLastSafeTruncation(cleaned);
  if (attempt === null) return null;

  let newCurly = 0, newSquare = 0;
  let inStr = false, esc = false;
  for (const ch of attempt) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') newCurly++;
    else if (ch === '}') newCurly--;
    else if (ch === '[') newSquare++;
    else if (ch === ']') newSquare--;
  }

  for (let i = 0; i < newSquare; i++) attempt += ']';
  for (let i = 0; i < newCurly; i++) attempt += '}';

  attempt = attempt.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(attempt) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function findLastSafeTruncation(text: string): string | null {
  const stringState: boolean[] = new Array(text.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < text.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (text[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (text[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  const endsInString = stringState[text.length - 1];

  if (endsInString) {
    let stringStartQuote = -1;
    for (let j = text.length - 1; j >= 0; j--) {
      if (text[j] === '"') {
        const stateBefore = j > 0 ? stringState[j - 1] : false;
        const stateAfter = stringState[j];
        if (!stateBefore && stateAfter) {
          stringStartQuote = j;
          break;
        }
      }
    }

    if (stringStartQuote >= 0) {
      let beforeQuote = stringStartQuote - 1;
      while (beforeQuote >= 0 && /\s/.test(text[beforeQuote])) beforeQuote--;

      if (beforeQuote >= 0) {
        const prevChar = text[beforeQuote];
        if (prevChar === ':') {
          let objOpenIdx = -1;
          let depth = 0;
          for (let k = beforeQuote; k >= 0; k--) {
            if (text[k] === '}' && !stringState[k]) depth++;
            else if (text[k] === '{' && !stringState[k]) {
              if (depth === 0) { objOpenIdx = k; break; }
              depth--;
            }
          }
          if (objOpenIdx >= 0) {
            let beforeObj = objOpenIdx - 1;
            while (beforeObj >= 0 && /\s/.test(text[beforeObj])) beforeObj--;
            if (beforeObj >= 0 && text[beforeObj] === ',') {
              return text.slice(0, beforeObj).replace(/,\s*$/, '');
            }
            if (beforeObj >= 0 && text[beforeObj] === '[') {
              return text.slice(0, beforeObj + 1);
            }
            if (beforeObj >= 0 && text[beforeObj] === '{') {
              return text.slice(0, beforeObj + 1);
            }
            return text.slice(0, objOpenIdx).replace(/,\s*$/, '');
          }
          return text.slice(0, beforeQuote).replace(/,\s*$/, '');
        }
        if (prevChar === ',' || prevChar === '[') {
          return text.slice(0, beforeQuote + (prevChar === '[' ? 1 : 0)).replace(/,\s*$/, '');
        }
      }
      return text.slice(0, stringStartQuote).replace(/,\s*$/, '');
    }
  }

  let i = text.length - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  const ch = text[i];

  if ((ch === '}' || ch === ']') && !stringState[i]) {
    let end = i;
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k >= 0 && text[k] === ',') end = k;
    return text.slice(0, end + 1).replace(/,\s*$/, '');
  }

  if (ch === '"' && !stringState[i]) {
    let result = text.slice(0, i + 1);
    result = result.replace(/,\s*$/, '');
    return result;
  }

  if (/\d/.test(ch)) {
    let numEnd = i;
    let j = i;
    while (j >= 0 && /[0-9.eE+\-]/.test(text[j])) j--;
    let beforeNum = j;
    while (beforeNum >= 0 && /\s/.test(text[beforeNum])) beforeNum--;
    if (beforeNum >= 0 && (text[beforeNum] === ':' || text[beforeNum] === ',' || text[beforeNum] === '[')) {
      let result = text.slice(0, numEnd + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  for (let j = text.length - 1; j >= 0; j--) {
    if ((text[j] === '}' || text[j] === ']') && !stringState[j]) {
      let result = text.slice(0, j + 1);
      result = result.replace(/,\s*$/, '');
      return result;
    }
  }

  return null;
}

function truncateToLastCompleteElement(cleaned: string): Record<string, unknown> | null {
  const stringState: boolean[] = new Array(cleaned.length).fill(false);
  let isStr = false, isEsc = false;
  for (let j = 0; j < cleaned.length; j++) {
    if (isEsc) { isEsc = false; stringState[j] = isStr; continue; }
    if (cleaned[j] === '\\' && isStr) { isEsc = true; stringState[j] = isStr; continue; }
    if (cleaned[j] === '"') isStr = !isStr;
    stringState[j] = isStr;
  }

  let lastCompleteObjEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === '}' && !stringState[j]) { lastCompleteObjEnd = j; break; }
  }

  let lastCompleteArrEnd = -1;
  for (let j = cleaned.length - 1; j >= 0; j--) {
    if (cleaned[j] === ']' && !stringState[j]) { lastCompleteArrEnd = j; break; }
  }

  let bestIdx = Math.max(lastCompleteObjEnd, lastCompleteArrEnd);
  if (bestIdx <= 0) return null;

  let truncated = cleaned.slice(0, bestIdx + 1);
  truncated = truncated.replace(/,\s*$/, '');

  let curly = 0, square = 0;
  let inStr = false, esc = false;
  for (const ch of truncated) {
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
  }

  for (let i = 0; i < square; i++) truncated += ']';
  for (let i = 0; i < curly; i++) truncated += '}';
  truncated = truncated.replace(/,\s*([}\]])/g, '$1');

  try {
    return JSON.parse(truncated) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function recoverFieldsIndividually(cleaned: string): Record<string, unknown> | null {
  try {
    const result: Record<string, unknown> = {};

    const scoreMatch = cleaned.match(/"score"\s*:\s*([\d.]+)/);
    if (scoreMatch) result.score = parseFloat(scoreMatch[1]);

    const issuesMatch = cleaned.match(/"issues"\s*:\s*\[/);
    if (issuesMatch) {
      const issuesStart = cleaned.indexOf('[', cleaned.indexOf('"issues"'));
      const recoveredIssues = recoverArrayElements(cleaned, issuesStart);
      if (recoveredIssues && recoveredIssues.length > 0) result.issues = recoveredIssues;
    }

    const suggestionsMatch = cleaned.match(/"suggestions"\s*:\s*\[/);
    if (suggestionsMatch) {
      const suggestionsStart = cleaned.indexOf('[', cleaned.indexOf('"suggestions"'));
      const recoveredSuggestions = recoverArrayElements(cleaned, suggestionsStart);
      if (recoveredSuggestions && recoveredSuggestions.length > 0) result.suggestions = recoveredSuggestions;
    }

    if (Object.keys(result).length > 0) return result;
  } catch {
    // Recovery failed
  }

  return null;
}

function recoverArrayElements(text: string, arrayStartIndex: number): unknown[] | null {
  if (arrayStartIndex === -1) return null;

  const elements: unknown[] = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStartIndex; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objStr = text.slice(objStart, i + 1);
        try { elements.push(JSON.parse(objStr)); } catch { /* skip */ }
        objStart = -1;
      }
    }
  }

  return elements;
}
