'use client';

import * as React from 'react';
import { Key, Check, X, Eye, EyeOff, Zap, Cpu } from 'lucide-react';
import { MODELS, type ModelId } from '@/lib/models';
import { cn } from '@/lib/utils';

interface ConfigBarProps {
  modelId: ModelId;
  apiKeyDraft: string;
  keyCommitted: boolean;
  apiKeyInputRef: React.RefObject<HTMLInputElement | null>;
  onModelChange: (id: ModelId) => void;
  onApiKeyDraftChange: (draft: string) => void;
  onCommit: () => void;
  onClear: () => void;
  className?: string;
}

export function ConfigBar({
  modelId,
  apiKeyDraft,
  keyCommitted,
  apiKeyInputRef,
  onModelChange,
  onApiKeyDraftChange,
  onCommit,
  onClear,
  className,
}: ConfigBarProps) {
  const [showKey, setShowKey] = React.useState(false);
  const config = MODELS[modelId];

  return (
    <div className={cn('rounded-lg border border-zinc-200 bg-white p-4 shadow-sm', className)}>
      {/* Row 1 — full-width API key input (the most important field) */}
      <div>
        <label
          htmlFor="api-key"
          className="flex items-center gap-1.5 text-xs font-medium text-zinc-700"
        >
          <Key className="h-3.5 w-3.5" />
          {config.id === 'nvidia-gpt-oss-120b' ? 'NVIDIA API Key' : 'OpenCode API Key'}
          {keyCommitted && (
            <span className="ml-1 inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">
              <Check className="h-3 w-3" /> saved
            </span>
          )}
        </label>
        <div className="mt-1.5 flex gap-2">
          <div className="relative flex-1">
            <input
              ref={apiKeyInputRef}
              id="api-key"
              type={showKey ? 'text' : 'password'}
              value={apiKeyDraft}
              onChange={(e) => onApiKeyDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onCommit();
                }
              }}
              placeholder={`${config.apiKeyPrefix}…`}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 pr-10 font-mono text-xs placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <button
            type="button"
            onClick={onCommit}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50"
            title="Save the key (Enter)"
          >
            <Check className="h-3.5 w-3.5" /> OK
          </button>
          {keyCommitted && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-medium text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-700"
              title="Clear saved key"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-500">
          {config.id === 'nvidia-gpt-oss-120b' ? (
            <>
              Get a key at{' '}
              <a
                href="https://build.nvidia.com/"
                className="text-zinc-900 underline-offset-2 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                build.nvidia.com
              </a>{' '}
              (free tier works; rate-limited).
            </>
          ) : (
            <>
              Get a key at{' '}
              <a
                href="https://opencode.ai/auth"
                className="text-zinc-900 underline-offset-2 hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                opencode.ai/auth
              </a>{' '}
              (Zen gateway).
            </>
          )}
        </p>
      </div>

      {/* Row 2 — Model + Speed side by side */}
      <div className="mt-4 grid gap-4 border-t border-zinc-200 pt-4 lg:grid-cols-[1fr_auto] lg:items-end">
        <div>
          <label
            htmlFor="model"
            className="flex items-center gap-1.5 text-xs font-medium text-zinc-700"
          >
            <Cpu className="h-3.5 w-3.5" />
            Model
          </label>
          <select
            id="model"
            value={modelId}
            onChange={(e) => onModelChange(e.target.value as ModelId)}
            className="mt-1.5 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          >
            {(Object.keys(MODELS) as ModelId[]).map((id) => {
              const m = MODELS[id];
              return (
                <option key={id} value={id}>
                  {m.name}
                </option>
              );
            })}
          </select>
          <p className="mt-1.5 text-[11px] text-zinc-500">{config.description}</p>
        </div>

        <div>
          <div className="text-xs font-medium text-zinc-700">Speed</div>
          <div className="mt-1.5 flex h-[38px] items-center gap-2 rounded-md border border-zinc-300 bg-white px-3">
            {config.cooldownMultiplier === 0 ? (
              <>
                <Zap className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-medium text-zinc-900">Fast (no cooldown)</span>
              </>
            ) : (
              <>
                <span className="text-sm font-medium text-zinc-900">Adaptive cooldown</span>
                <span className="text-xs text-zinc-500">(10-60s)</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
