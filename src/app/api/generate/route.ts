import { NextRequest } from 'next/server';
import { runGenerationPipelineStream, type PipelineEvent } from '@/lib/generate-pipeline';
import { MODELS, type ModelId } from '@/lib/models';

// Edge runtime — CRITICAL for gpt-oss-20b on Vercel.
//
// This pattern is lifted from ax-translator/src/app/api/translate/route.ts,
// which documents the discovery:
//
//   "Vercel's Node serverless path hangs on openai/gpt-oss-120b
//    (confirmed via /api/debug). Edge uses a different egress that works."
//
// The same hang affects gpt-oss-20b — on Node serverless, NVIDIA API calls
// silently exceed the 50s per-call timeout, even when the same call
// completes in ~30s locally or via curl from the same machine. Edge
// runtime uses a different network egress that doesn't have this issue.
//
// Edge runtime maxDuration caps:
//   - Hobby: 30s
//   - Pro: 300s
// We set maxDuration=60. On Hobby Edge, Vercel will cap the actual run at
// 30s — that's enough for first-attempt zero-shot generation. On Pro, the
// full 60s budget is available.
export const runtime = 'edge';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function sse(event: PipelineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  // ─── Auth: prefer server-side API keys (ax-translator pattern), fall
  // back to Bearer header from the client UI. This lets the user paste
  // their own key for testing while still allowing the deployed site to
  // ship with server-side keys for both providers.
  const authHeader = request.headers.get('Authorization') ?? '';
  const bearerKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  // ─── Body: intent + optional modelId + presetId.
  // We need the modelId FIRST so we know which server-side env var to check.
  let body: { intent?: string; presetId?: string; modelId?: ModelId };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { intent, presetId, modelId } = body;
  if (!intent || intent.trim().length < 10) {
    return new Response(
      JSON.stringify({ error: 'Missing or too-short intent (min 10 chars)' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Default to NVIDIA — matches the original gsap-animation-pipeline.
  const resolvedModelId: ModelId =
    modelId && modelId in MODELS ? modelId : 'nvidia-gpt-oss-20b';

  // Pick the server-side env var based on the resolved provider. NVIDIA
  // uses NVIDIA_API_KEY; OpenCode uses OPENCODE_API_KEY. If neither is
  // set, we fall back to the client-provided Bearer key (UI ConfigBar).
  const serverKey =
    resolvedModelId === 'opencode-glm-5.1'
      ? process.env.OPENCODE_API_KEY
      : process.env.NVIDIA_API_KEY;
  const apiKey = serverKey || bearerKey;
  if (!apiKey) {
    const envVarName =
      resolvedModelId === 'opencode-glm-5.1'
        ? 'OPENCODE_API_KEY'
        : 'NVIDIA_API_KEY';
    return new Response(
      JSON.stringify({
        error: `Missing API key. Either set ${envVarName} in your Vercel env vars, or paste a key in the UI ConfigBar.`,
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: PipelineEvent) => {
        try {
          controller.enqueue(encoder.encode(sse(event)));
        } catch {
          // Controller may be closed if client disconnected.
        }
      };

      try {
        await runGenerationPipelineStream({
          intent,
          presetId,
          apiKey,
          modelId: resolvedModelId,
          emit,
        });
      } catch (err: unknown) {
        emit({
          type: 'error',
          ts: Date.now(),
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
