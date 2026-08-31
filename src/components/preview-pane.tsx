'use client';

import * as React from 'react';
import { CheckCircle2, Copy, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GenerateResponse } from '@/lib/generate-pipeline';

interface PreviewPaneProps {
  generated: GenerateResponse;
  intent: string;
  onLooksGood: () => void;
  onReset: () => void;
}

export function PreviewPane({ generated, intent, onLooksGood, onReset }: PreviewPaneProps) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(generated.gsapCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Live Preview</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Generated from: <span className="italic">"{intent}"</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={generated.validation.isValid ? 'default' : 'destructive'}>
            Quality: {generated.validation.qualityScore}
          </Badge>
          <Badge variant="outline">Attempts: {generated.attempts}</Badge>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Container</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div>
              <p className="text-zinc-500">Selector</p>
              <p className="mt-0.5 font-mono text-zinc-900">{generated.containerStructure.selector}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-zinc-500">Width</p>
                <p className="mt-0.5 font-mono">{generated.containerStructure.width}</p>
              </div>
              <div>
                <p className="text-zinc-500">Breakpoint</p>
                <p className="mt-0.5 font-mono">{generated.containerStructure.breakpoint}</p>
              </div>
            </div>
            <div>
              <p className="text-zinc-500">Notes</p>
              <p className="mt-0.5 text-zinc-700">{generated.containerStructure.notes}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">CSS Selectors</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-xs font-mono">
              {generated.cssSelectors.map((sel, i) => (
                <li
                  key={i}
                  className="break-all rounded border border-zinc-100 bg-zinc-50 px-2 py-1 text-zinc-900"
                  title={sel}
                >
                  {sel}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Strategy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-zinc-700">{generated.scalabilityStrategy}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Generated GSAP Code</CardTitle>
          <Button size="sm" variant="ghost" onClick={handleCopy}>
            {copied ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy Code
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-4 text-xs leading-relaxed">
            <code className="font-mono text-zinc-800">{generated.gsapCode}</code>
          </pre>
        </CardContent>
      </Card>

      {generated.validation.issues.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-sm text-amber-900">Validation Issues</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
              {generated.validation.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <footer className="flex flex-wrap items-center justify-end gap-3">
        <Button variant="ghost" onClick={onReset}>
          <RotateCcw className="h-3.5 w-3.5" /> Start Over
        </Button>
        <Button onClick={onLooksGood}>
          Looks Good — Get Guide →
        </Button>
      </footer>
    </div>
  );
}
