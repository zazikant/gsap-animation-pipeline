import { NextRequest, NextResponse } from 'next/server';
import { buildGtmGuide } from '@/lib/gtm-guide';
import type { GenerateResponse } from '@/lib/generate-pipeline';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { generated: GenerateResponse; intent: string };
    const guide = buildGtmGuide(body.generated, body.intent);
    return NextResponse.json({ guide });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('[Guide API] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
