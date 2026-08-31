# GSAP Animation Pipeline — Elementor + GTM

> **AI-powered GSAP animation generator** for **Elementor-built WordPress sites**, deployed via **Google Tag Manager**.
>
> Pipeline: Intent → Generate → Preview → Deploy, wired through a real `@langchain/langgraph` `StateGraph` with conditional retry edges and per-widget Elementor selector profiles.

![Pipeline Active](https://img.shields.io/badge/pipeline-active-emerald)
![Model: GLM 5.1 + Nvidia 120B](https://img.shields.io/badge/model-GLM_5.1_+_Nvidia_120B-blue)
![Next.js 16](https://img.shields.io/badge/Next.js-16-black)
![LangGraph](https://img.shields.io/badge/LangGraph-1.4-purple)

## What it does

1. **Intent** — User describes the animation (e.g. "Animated testimonial carousel with fade-in quotes and slide-in author names")
2. **Generate** — LLM (Nvidia gpt-oss-120B *or* OpenCode Zen GLM 5.1) writes GSAP code targeting the right Elementor widget profile (testimonial, hero, cards, pricing, gallery, counter)
3. **Parse + Validate** — `parseGsapNode` strips fences + normalizes IIFEs; `validateNode` runs structural checks (selectors present, primitives used, onerror handler, no multi-CDN load, matchMedia reverted)
4. **Retry** — If validation fails, `retryGuardNode` builds a corrective prompt with the previous code + the failure issues, applies the NVIDIA adaptive cooldown, and routes back to `generateNode`
5. **Output** — Final code + container structure + CSS selectors + scalability strategy, packaged into a `GenerateResponse`

## Tech stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript 5** · **Tailwind v4**
- **@langchain/langgraph 1.4** — real `StateGraph` with `Annotation.Root`, conditional edges, retry-with-feedback
- **GSAP 3.13** — target animation library
- **shadcn/ui / Radix UI** primitives
- **Two providers:**
  - **NVIDIA NIM** `openai/gpt-oss-120b` — slow (40-50s TTFB), but high quality; full adaptive cooldown
  - **OpenCode Zen** `glm-5.1` — fast (1.5s TTFB), gateway aliases to GLM-5.3; uses `reasoning_effort: "low"`; no cooldown

## Adaptive Cooldown (NVIDIA rate-limit handling)

Pattern lifted from `ax-translator/src/app/page.tsx:727-786`:

| Outcome | Wait |
|---|---|
| Succeeded on first attempt | 10s |
| Succeeded after retries | 30s |
| Failed all attempts | 60s |
| Rate-limit error detected | 60s |
| OpenCode provider | 0s (skipped) |

The UI shows a live countdown of remaining seconds per cooldown.

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000. Paste your API key in the top bar (NVIDIA `nvapi-…` or OpenCode `sk-…`), pick the model from the dropdown, click a preset or describe your animation, hit **Generate**.

### Environment variables

Optional — you can paste the key directly in the UI:

| Variable | Purpose |
|---|---|
| `NVIDIA_API_KEY` | Server-side fallback for the NVIDIA provider |
| (none) | OpenCode Zen key is always client-side |

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/generate` | POST | SSE stream of `stage-start` / `log` / `countdown` / `pipeline-end` events |
| `/api/guide` | POST | Returns a copy-paste-ready GTM Custom HTML tag payload for the generated code |

Request to `/api/generate`:

```json
{
  "intent": "Animated testimonial carousel with fade-in quotes",
  "modelId": "opencode-glm-5.1"
}
```

Headers:
- `Authorization: Bearer <apiKey>` (NVIDIA or OpenCode)
- `Content-Type: application/json`

## Project structure

```
src/
├── app/
│   ├── api/
│   │   ├── generate/route.ts    ← SSE endpoint, Bearer auth, modelId dispatch
│   │   └── guide/route.ts        ← GTM guide generator
│   ├── layout.tsx
│   ├── page.tsx                  ← Renders <PipelineApp />
│   └── globals.css               ← Tailwind v4 base + body bg
├── components/
│   ├── pipeline-app.tsx          ← Main page: ConfigBar + 4-step tabs + SSE consumer
│   ├── config-bar.tsx            ← API key input + model dropdown + speed badge
│   ├── intent-form.tsx            ← Textarea + 6 preset cards + process-flow strip
│   ├── generation-progress.tsx   ← Live log + stage cards + countdown badge
│   ├── preview-pane.tsx          ← Container/Selectors/Strategy/Code + GTM button
│   ├── guide-pane.tsx             ← Markdown rendering of /api/guide
│   ├── deploy-pane.tsx
│   ├── pipeline.tsx              ← 4-step Intent/Generate/Preview/Deploy tracker
│   └── ui/                        ← shadcn primitives
└── lib/
    ├── pipeline-graph.ts         ← LangGraph StateGraph (THE CORE)
    ├── gsap-utils.ts             ← Parser + structural validator
    ├── widget-profiles.ts        ← Per-widget Elementor selector profiles
    ├── models.ts                 ← Provider config (NVIDIA + OpenCode)
    ├── llm-client.ts             ← Unified dispatcher
    ├── nvidia-client.ts          ← Streaming SSE client (120s timeout, 1 retry)
    ├── opencode-client.ts        ← Streaming SSE client (50s timeout, GLM 5.1)
    ├── rate-limit.ts             ← Adaptive cooldown logic
    ├── config.ts                 ← localStorage config (modelId + apiKey)
    ├── generate-pipeline.ts      ← Public types + re-exports
    └── gtm-guide.ts              ← GTM deployment guide generator
```

## Origin

This project was **recovered** from a now-deleted GitHub repo by downloading all 13 `_next/static` chunks from the live Vercel deployment and extracting:
- UI text strings (Intent / Generate / Preview / Deploy, presets, process-flow labels)
- API routes (`/api/generate`, `/api/guide`)
- Tech identifiers (GSAP, Next.js App Router, Radix UI primitives)
- Model + provider config (GLM 5.1, Nvidia 120B, LangGraph)

The recovered logic was then rewritten as a real `@langchain/langgraph` `StateGraph` — not a cosmetic loop with `lg1-lg5` labels.

See [RECOVERY.md](./RECOVERY.md) for the full forensic reconstruction log.
