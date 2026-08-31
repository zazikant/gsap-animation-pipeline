'use client';

import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Pipeline } from '@/components/pipeline';
import { ConfigBar } from '@/components/config-bar';
import { IntentForm } from '@/components/intent-form';
import { PreviewPane } from '@/components/preview-pane';
import { GuidePane } from '@/components/guide-pane';
import { DeployPane } from '@/components/deploy-pane';
import { GenerationProgress, type StageState } from '@/components/generation-progress';
import { STAGE_ORDER, STAGE_META } from '@/lib/generate-pipeline';
import { DEFAULT_MODEL, type ModelId, getModelConfig } from '@/lib/models';
import { loadConfig, saveConfig } from '@/lib/config';
import type { GenerateResponse } from '@/lib/generate-pipeline';

type Stage = 'intent' | 'generate' | 'preview' | 'deploy';

const INITIAL_STAGES: StageState[] = STAGE_ORDER.map((id) => ({
  id,
  label: STAGE_META[id].name,
  description: STAGE_META[id].description,
  status: 'pending' as const,
}));

interface SseEvent {
  type: string;
  ts: number;
  [key: string]: unknown;
}

export function PipelineApp() {
  // ─── Persisted config (modelId + apiKey) — mirrors google-ads-subagent-vercel
  const initial = React.useMemo(() => loadConfig(), []);
  const [modelId, setModelId] = React.useState<ModelId>(initial.modelId);
  const [apiKey, setApiKey] = React.useState<string>(initial.apiKey);
  const [apiKeyDraft, setApiKeyDraft] = React.useState<string>(initial.apiKey);
  const [keyCommitted, setKeyCommitted] = React.useState<boolean>(Boolean(initial.apiKey));
  const apiKeyInputRef = React.useRef<HTMLInputElement>(null);

  const [intent, setIntent] = React.useState('');
  const [generated, setGenerated] = React.useState<GenerateResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stage, setStage] = React.useState<Stage>('intent');

  const [stages, setStages] = React.useState<StageState[]>(INITIAL_STAGES);
  const [progress, setProgress] = React.useState(0);
  const [countdownSec, setCountdownSec] = React.useState<number | undefined>(undefined);
  const [countdownTotalSec, setCountdownTotalSec] = React.useState<number | undefined>(undefined);
  const [countdownReason, setCountdownReason] = React.useState<string | undefined>(undefined);
  const [logs, setLogs] = React.useState<string[]>([]);
  const [streamError, setStreamError] = React.useState<string | null>(null);

  const config = getModelConfig(modelId);

  const persist = React.useCallback(
    (next: { modelId?: ModelId; apiKey?: string }) => {
      saveConfig({
        modelId: next.modelId ?? modelId,
        apiKey: next.apiKey ?? apiKey,
      });
    },
    [modelId, apiKey],
  );

  const handleModelChange = (id: ModelId) => {
    setModelId(id);
    persist({ modelId: id });
  };

  const commitApiKey = () => {
    const trimmed = apiKeyDraft.trim();
    setApiKey(trimmed);
    setKeyCommitted(Boolean(trimmed));
    persist({ apiKey: trimmed });
  };

  const handleClear = () => {
    setApiKey('');
    setApiKeyDraft('');
    setKeyCommitted(false);
    persist({ apiKey: '' });
  };

  function resetGenerationState() {
    setStages(INITIAL_STAGES);
    setProgress(0);
    setCountdownSec(undefined);
    setCountdownTotalSec(undefined);
    setCountdownReason(undefined);
    setLogs([]);
    setStreamError(null);
  }

  async function handleGenerate(prompt: string) {
    if (!apiKey.trim()) {
      setError('Click OK next to the API key first to save it.');
      apiKeyInputRef.current?.focus();
      return;
    }
    setIntent(prompt);
    setError(null);
    setStage('generate');
    resetGenerationState();

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ intent: prompt, modelId }),
      });

      if (!res.ok || !res.body) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errBody = await res.json();
          errMsg = errBody.error || errMsg;
        } catch {}
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const chunk of events) {
          const line = chunk.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          try {
            const evt = JSON.parse(payload) as SseEvent;
            handleSseEvent(evt);
          } catch {
            // Malformed event.
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStreamError(message);
      setError(message);
      setStage('intent');
    }
  }

  function handleSseEvent(evt: SseEvent) {
    switch (evt.type) {
      case 'stage-start': {
        const stageId = evt.stage as string;
        setStages((prev) =>
          prev.map((s) =>
            s.id === stageId
              ? { ...s, status: 'active', description: evt.description as string }
              : s,
          ),
        );
        break;
      }
      case 'stage-end': {
        const stageId = evt.stage as string;
        const ok = evt.ok as boolean;
        setStages((prev) =>
          prev.map((s) =>
            s.id === stageId ? { ...s, status: ok ? 'done' : 'failed' } : s,
          ),
        );
        break;
      }
      case 'log':
        setLogs((prev) => [...prev, evt.line as string]);
        break;
      case 'countdown': {
        setCountdownSec(evt.remainingSec as number);
        setCountdownTotalSec(evt.totalSec as number);
        setCountdownReason(evt.reason as string);
        if ((evt.remainingSec as number) === 0) {
          setTimeout(() => {
            setCountdownSec(undefined);
            setCountdownTotalSec(undefined);
            setCountdownReason(undefined);
          }, 500);
        }
        break;
      }
      case 'chunk':
        // Already streamed into the log. No-op.
        break;
      case 'pipeline-end': {
        const result = evt.result as GenerateResponse;
        setGenerated(result);
        setProgress(100);
        setStages((prev) => prev.map((s) => ({ ...s, status: 'done' })));
        setStage('preview');
        break;
      }
      case 'error':
        setStreamError(evt.message as string);
        break;
    }
  }

  React.useEffect(() => {
    const done = stages.filter((s) => s.status === 'done').length;
    const active = stages.filter((s) => s.status === 'active').length;
    const total = stages.length;
    setProgress(((done + active * 0.5) / total) * 100);
  }, [stages]);

  function handleReset() {
    setIntent('');
    setGenerated(null);
    setError(null);
    setStage('intent');
    resetGenerationState();
  }

  function handleLooksGood() {
    setStage('deploy');
  }

  function handleBackToPreview() {
    setStage('preview');
  }

  return (
    <main className="container mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-900 text-white shadow-sm">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900">GSAP Animation Pipeline</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              Intent-in, Code-out • {config.id === 'nvidia-gpt-oss-120b' ? 'Nvidia 120B' : 'GLM 5.1'} + LangGraph
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 border-zinc-300 bg-white text-zinc-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Pipeline Active
          </Badge>
          <Badge variant="outline" className="text-zinc-600">
            Model: GPT-OSS-120B
          </Badge>
          <Badge variant="outline" className="text-zinc-600">
            Next.js 16
          </Badge>
        </div>
      </header>

      <ConfigBar
        modelId={modelId}
        apiKeyDraft={apiKeyDraft}
        keyCommitted={keyCommitted}
        apiKeyInputRef={apiKeyInputRef}
        onModelChange={handleModelChange}
        onApiKeyDraftChange={setApiKeyDraft}
        onCommit={commitApiKey}
        onClear={handleClear}
        className="mb-8"
      />

      <Pipeline currentStage={stage} className="mb-8" />

      <Tabs value={stage} onValueChange={(v) => setStage(v as Stage)} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="intent">Intent</TabsTrigger>
          <TabsTrigger value="generate">Generate</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="deploy">Deploy</TabsTrigger>
        </TabsList>

        <TabsContent value="intent" className="mt-6">
          <IntentForm onGenerate={handleGenerate} error={error} />
        </TabsContent>

        <TabsContent value="generate" className="mt-6">
          {streamError ? (
            <Card>
              <CardContent className="py-16 text-center">
                <p className="text-sm text-red-600">Generation failed: {streamError}</p>
                <button
                  onClick={handleReset}
                  className="mt-3 text-xs text-zinc-900 underline-offset-2 hover:underline"
                >
                  ← Back to intent
                </button>
              </CardContent>
            </Card>
          ) : (
            <GenerationProgress
              stages={stages}
              progress={progress}
              countdownSec={countdownSec}
              countdownTotalSec={countdownTotalSec}
              countdownReason={countdownReason}
              logs={logs}
              error={streamError}
            />
          )}
        </TabsContent>

        <TabsContent value="preview" className="mt-6">
          {generated ? (
            <PreviewPane
              generated={generated}
              intent={intent}
              onLooksGood={handleLooksGood}
              onReset={handleReset}
            />
          ) : (
            <Card>
              <CardContent className="py-16 text-center text-sm text-zinc-500">
                No animation generated yet.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="deploy" className="mt-6">
          {generated ? (
            <GuidePane generated={generated} intent={intent} onBack={handleBackToPreview} />
          ) : (
            <DeployPane onBack={handleBackToPreview} />
          )}
        </TabsContent>
      </Tabs>
    </main>
  );
}
