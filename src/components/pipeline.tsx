'use client';

import { cn } from '@/lib/utils';

type Stage = 'intent' | 'generate' | 'preview' | 'deploy';

const STAGE_ORDER: Stage[] = ['intent', 'generate', 'preview', 'deploy'];
const STAGE_LABELS: Record<Stage, string> = {
  intent: 'You give intent',
  generate: 'AI maps w0',
  preview: 'AI writes code',
  deploy: 'You preview',
};

interface PipelineProps {
  currentStage: Stage;
  className?: string;
}

export function Pipeline({ currentStage, className }: PipelineProps) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);

  return (
    <ol className={cn('flex items-center justify-between gap-2', className)}>
      {STAGE_ORDER.map((stage, idx) => {
        const status = idx < currentIdx ? 'done' : idx === currentIdx ? 'active' : 'pending';
        return (
          <li key={stage} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium',
                status === 'active' && 'bg-zinc-900 text-white shadow',
                status === 'done' && 'bg-zinc-200 text-zinc-700',
                status === 'pending' && 'bg-zinc-100 text-zinc-400 ring-1 ring-zinc-200',
              )}
            >
              {idx + 1}
            </div>
            <div className="min-w-0">
              <p
                className={cn(
                  'truncate text-xs font-medium',
                  status === 'pending' ? 'text-zinc-400' : 'text-zinc-900',
                )}
              >
                {STAGE_LABELS[stage]}
              </p>
            </div>
            {idx < STAGE_ORDER.length - 1 && (
              <div
                className={cn(
                  'h-px flex-1',
                  idx < currentIdx ? 'bg-zinc-300' : 'bg-zinc-200',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
