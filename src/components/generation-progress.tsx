'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2, Circle, AlertTriangle, Clock } from 'lucide-react';

export type StageStatus = 'pending' | 'active' | 'done' | 'failed';

export interface StageState {
  id: string;
  label: string;
  description: string;
  status: StageStatus;
}

interface GenerationProgressProps {
  stages: StageState[];
  progress: number;
  countdownSec?: number;
  countdownTotalSec?: number;
  countdownReason?: string;
  logs: string[];
  error?: string | null;
}

export function GenerationProgress({
  stages,
  progress,
  countdownSec,
  countdownTotalSec,
  countdownReason,
  logs,
  error,
}: GenerationProgressProps) {
  const logEndRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Generating Animation</h2>
          <p className="mt-1 text-xs text-zinc-600">
            AI pipeline: w0 auto-mapping → lg1–lg5 LangGraph loop → rb1–rb3 resilience
          </p>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-600">Progress</span>
            <span className="text-sm font-mono font-semibold text-zinc-900">{Math.round(progress)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full bg-zinc-900 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <ol className="space-y-2">
          {stages.map((s) => (
            <li
              key={s.id}
              className={cn(
                'flex items-start gap-3 rounded-md border p-3 text-sm transition-colors',
                s.status === 'active' && 'border-zinc-900 bg-white shadow-sm',
                s.status === 'done' && 'border-zinc-200 bg-zinc-50 opacity-70',
                s.status === 'pending' && 'border-zinc-200 bg-white',
                s.status === 'failed' && 'border-red-200 bg-red-50',
              )}
            >
              <StageIcon status={s.status} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'font-medium',
                    s.status === 'active' && 'text-zinc-900',
                    s.status === 'done' && 'text-zinc-500',
                    s.status === 'pending' && 'text-zinc-400',
                    s.status === 'failed' && 'text-red-700',
                  )}
                >
                  {s.id}: {s.label}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">{s.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-3">
        {countdownSec !== undefined && countdownSec > 0 && countdownTotalSec && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <Clock className="h-5 w-5 flex-shrink-0 animate-pulse text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">
                Rate-limit cooldown — {countdownSec}s remaining
              </p>
              <p className="mt-0.5 text-xs text-amber-700">{countdownReason}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-100">
                <div
                  className="h-full bg-amber-500 transition-all duration-1000 ease-linear"
                  style={{
                    width: `${((countdownTotalSec - countdownSec) / countdownTotalSec) * 100}%`,
                  }}
                />
              </div>
            </div>
            <span className="font-mono text-2xl font-bold tabular-nums text-amber-700">
              {countdownSec}
            </span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-medium text-red-900">Pipeline error</p>
              <p className="mt-1 text-xs text-red-700">{error}</p>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2">
            <span className="text-xs font-medium text-zinc-700">Live log</span>
            <span className="text-xs text-zinc-500">{logs.length} lines</span>
          </header>
          <div className="max-h-[400px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 && <p className="text-zinc-400">Waiting for first event…</p>}
            {logs.map((line, i) => (
              <div
                key={i}
                className={cn(
                  line.includes('ERROR') || line.includes('failed')
                    ? 'text-red-600'
                    : line.includes('cooldown') || line.includes('retry')
                    ? 'text-amber-600'
                    : line.includes('done') || line.includes('pass')
                    ? 'text-emerald-600'
                    : 'text-zinc-700',
                )}
              >
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case 'active':
      return <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-zinc-900" />;
    case 'done':
      return <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" />;
    case 'failed':
      return <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />;
    default:
      return <Circle className="mt-0.5 h-4 w-4 flex-shrink-0 text-zinc-300" />;
  }
}
