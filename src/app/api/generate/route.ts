import { NextRequest } from 'next/server';
import { runGenerationPipelineStream, type PipelineEvent } from '@/lib/generate-pipeline';
import { MODELS, type ModelId } from '@/lib/models';

// Vercel maxDuration — must fit the user's plan or the BUILD FAILS:
//   Hobby: 60s · Pro (serverless): 300s · Pro + Fluid: 800s · Enterprise: 900s
// We default to 60s (Hobby-safe) so the build succeeds on every plan.
//
// The per-call LLM timeout in lib/models.ts (50s for gpt-oss-20b) is sized
// to fit this 60s cap: 50s LLM + ~5s for parse/validate/output + 5s buffer.
// If the LLM call exceeds 50s, nvidia-client throws a clean TIMEOUT error
// with an actionable message ("try a simpler intent, switch to GLM 5.1, or
// run locally"), and the pipeline emits a pipeline-end event before
// Vercel's 60s hard cap kicks in.
//
// On Vercel Pro/Enterprise, bump BOTH this maxDuration (300/600) AND the
// gpt-oss-20b timeoutMs in lib/models.ts (180_000) to enable the full
// retry path. Pipeline maxAttempts=3 is already sized for the 600s budget.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function sse(event: PipelineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  // ─── Auth: API key travels in `Authorization: Bearer` (mirrors
  // `google-ads-subagent-vercel/app/api/chat-stream/route.ts`).
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Missing Authorization: Bearer <apiKey> header' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const apiKey = auth.slice('Bearer '.length).trim();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Empty API key' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Body: intent + optional modelId + presetId.
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
