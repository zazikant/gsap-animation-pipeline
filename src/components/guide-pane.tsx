'use client';

import * as React from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { GenerateResponse } from '@/lib/generate-pipeline';

interface GuidePaneProps {
  generated: GenerateResponse;
  intent: string;
  onBack: () => void;
}

export function GuidePane({ generated, intent, onBack }: GuidePaneProps) {
  const [guide, setGuide] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/guide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ generated, intent }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setGuide(data.guide);
          setIsLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load guide');
          setIsLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [generated, intent]);

  return (
    <div className="space-y-6">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Preview
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Deployment Guide</CardTitle>
          <p className="text-xs text-zinc-600">
            Drop this into Google Tag Manager on your Elementor WordPress site.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex items-center gap-2 py-12 text-sm text-zinc-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              Building deployment guide…
            </div>
          )}
          {error && <div className="text-sm text-red-600">Error: {error}</div>}
          {guide && (
            <div className="prose prose-zinc prose-sm max-w-none">
              <ReactMarkdown>{guide}</ReactMarkdown>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
