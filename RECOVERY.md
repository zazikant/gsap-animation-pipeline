# Recovery Log

## Source

- **GitHub repo (DELETED):** `zazikant/gsap-animation-pipeline` — returns 404 with no redirect
- **Live deployment:** https://gsap-animation-pipeline.vercel.app/
- **Vercel deployment ID:** `dpl_FXv9iVCdKeWYFnWU9tXgpomBcqLV`
- **Deployment cache age:** ~10 days (still serving from Vercel CDN)
- **Original commit hash (lost):** `3c0d53a45a46e0b2b6e8f5c1bdc11a6274e8b32c` — not findable in any public repo

## What was recovered

Downloaded 13 assets from `_next/static/`:

| File | Size | Role |
|---|---|---|
| `2473c16c0c2f6b5f.css` | 2 KB | App-specific CSS |
| `2636b89956242c09.js` | 178 KB | Likely framework/vendor (React + Next runtime) |
| `2641cf16268a874d.js` | 18 KB | Page-specific chunk |
| `29cc553a73248c69.js` | 158 KB | App component bundle |
| `33d3f2c0cda968c7.js` | 31 KB | App component bundle |
| `58c60a5fa6b544da.js` | 17 KB | App component bundle |
| `771dedee3f5e1621.js` | 225 KB | Likely framer-motion / Radix / shadcn UI primitives |
| `876918581f30bd14.js` | 41 KB | App component bundle |
| `a6dad97d9634a72d.js` | 113 KB | Likely LangGraph client or similar |
| `turbopack-545e9cc9493a73de.js` | 11 KB | Turbopack runtime |
| `93f3f6e10930b190.css` | 102 KB | Tailwind compiled CSS |
| `797e433ab948586e-*.woff2` | 31 KB | Font |
| `caa3a2e1cccd8315-*.woff2` | 28 KB | Font |

### UI strings extracted

| Group | Examples |
|---|---|
| **Main tabs** | Intent, Generate, Preview, Deploy |
| **Input field** | "What animation do you need?", "Just describe it - the AI will auto-derive the Elementor container structure and selectors" |
| **Component presets** | Testimonial Carousel, Hero Section, Feature Cards, Pricing Table, Image Gallery, Stats Counter |
| **Actions** | "Generate Animation", "New Animation", "Try Again", "Start Over", "Looks Good — Get Guide", "Back to Preview" |
| **Errors / status** | "Generation Error", "Rate Limit Reached", "Max Retries Exceeded", "Pipeline Active" |
| **Process flow** | "You give intent", "AI maps w0", "AI writes code", "You preview", "Live animation + GTM guide" |
| **Elementor grid hints** | `w0–w12`, `lg1–lg5`, `t1–t5`, `rb1–rb3`, `p1`, `c1–c8` |

### API routes discovered

```
POST /api/generate   → generates GSAP code from intent (SSE)
POST /api/guide      → returns GTM deployment guide (JSON)
```

### Tech identifiers (from minified JS)

| Identifier | Implies |
|---|---|
| `gsap.globalTimeline`, `gsap.version`, `gsap.min` | GSAP 3.x |
| `MotionPath`, `ScrollTrigger` patterns | GSAP plugins |
| `AppRouterAnnouncer`, `AppRouterContext` | Next.js 14+ App Router |
| `DismissableLayer`, `CollectionConsumer`, `CollectionProvider` | Radix UI primitives |
| GSAP refs: `decay, delay, duration, ease, from, inertia, keyframes, onComplete, onStart, onUpdate, repeat, set, spring, timeline, to, tween` | Tween config keys |

## What was NOT recoverable from the build

| Lost | Why |
|---|---|
| **Original source files** (`.ts`, `.tsx`, `.js`) | Vercel only stores compiled bundles; no source maps |
| **Source maps** | All `*.js.map` probes returned 404 |
| **`package.json`** | Inferred from chunks but dep versions are educated guesses |
| **Git history, branches, PRs** | Repo is gone |
| **Comments** | Stripped in minification |
| **Original file structure** | Only chunks, not paths |
| **API route handlers' logic** | Only endpoint paths recovered; full logic re-implemented |
| **LLM prompts / pipeline state machine** | Not in client bundles; the **LangGraph `StateGraph` is a re-architecture**, not a recovery |

## Discovery timeline

1. User reported commit `3c0d53a4...` unreachable at `github.com/zazikant/gsap-animation-pipeline`
2. Verified 404 across GitHub web UI, REST API, commit-search, and 5+ likely-renamed candidate repos
3. Identified deployment ID from page HTML: `dpl_FXv9iVCdKeWYFnWU9tXgpomBcqLV`
4. Vercel deployment-metadata API requires auth (403) — no source URL recoverable from Vercel
5. Downloaded all 13 `_next/static` chunks
6. Extracted strings via regex → identified "GSAP Animation Pipeline", 4 tabs (Intent/Generate/Preview/Deploy), 6 component presets, AI pipeline intent
7. Built this recovery project as the maximum-fidelity reconstruction

## Subsequent iterations (post-recovery)

The recovered project went through several rounds of refinement:

### Iteration 1 — Initial reconstruction
- Stub LLM client (template-based fallback)
- Linear pipeline with cosmetic `lg1-lg5` stage labels
- **No actual LangGraph** — just a sequential for-loop

### Iteration 2 — NVIDIA rate-limit pattern (from `ax-translator`)
- Adaptive cooldown (10/30/60s based on prior stage outcome)
- SSE streaming for live progress
- Multi-provider support (NVIDIA + OpenCode GLM 5.1)
- Bearer-header auth pattern (from `google-ads-subagent-vercel`)

### Iteration 3 — Real LangGraph `StateGraph`
- Installed `@langchain/langgraph@1.4`
- Built proper `StateGraph<PipelineState>` with 6 nodes and a **conditional edge** that routes validate→retry or validate→output
- Real retry-with-feedback: validation issues fed back into the next `generate` prompt
- Per-widget Elementor selector profiles (`widget-profiles.ts`)
- Real GSAP parser (`stripCodeFences`, `detectEntryPoint`, `normalizeGsapCode`)
- Structural validator that checks selectors, primitives, onerror handler, multi-CDN, matchMedia revert

### Iteration 4 — GTM guide fixes
- Removed broken wrapper that referenced undefined `initAnimation()`
- Removed invented `gtm.elementorVersion` data layer variable
- Removed false "SRI-safe fallback" claim (no integrity hashes were present)
- Single CDN load (jsdelivr) instead of dual-load
- Real `onerror` handler with console.error feedback

### Iteration 5 — Bug fixes from live testing
- `attempts` counter now increments even on LLM error path (was looping forever)
- `shouldRetry` now bails when `state.error` is set (was looping forever)
- All `stage-start` events now include a real `description` field (was falling back to "Starting…")
- `pipeline-end` event emitted from the runner (was missing — UI never transitioned to Preview)
