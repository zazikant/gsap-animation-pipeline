'use client';

import * as React from 'react';
import { AlertTriangle, Layers } from 'lucide-react';
import { PRESETS } from '@/lib/presets';

interface IntentFormProps {
  onGenerate: (intent: string) => void;
  error: string | null;
}

export function IntentForm({ onGenerate, error }: IntentFormProps) {
  const [text, setText] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  function handlePreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (preset) {
      setText(preset.defaultPrompt);
      textareaRef.current?.focus();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length >= 10) onGenerate(trimmed);
  }

  return (
    <div className="space-y-6">
      {/* Heading */}
      <header className="text-center">
        <h2 className="text-3xl font-bold tracking-tight text-zinc-900">
          What animation do you need?
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          Just describe it — the AI will auto-derive the Elementor container structure and selectors
        </p>
      </header>

      {/* Preset cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handlePreset(preset.id)}
            className="group flex flex-col items-start gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:border-zinc-400 hover:shadow"
          >
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700 group-hover:bg-zinc-200">
              <Layers className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900">{preset.name}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{preset.description}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Describe Your Animation */}
      <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <header className="mb-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-zinc-900">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            </svg>
            Describe Your Animation
          </h3>
          <p className="mt-1 text-xs text-zinc-600">
            The AI will automatically determine the Elementor container structure (w0), CSS
            selectors (w2), and scalability strategy (w12) from your description.
          </p>
        </header>
        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g., Animated testimonial carousel with fade-in quotes and slide-in author names on each slide change…"
            rows={6}
            className="min-h-[140px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {text.length === 0 ? 'No description yet' : `${text.length} chars`}
            </span>
            <button
              type="submit"
              disabled={text.trim().length < 10}
              className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              Generate Animation →
            </button>
          </div>
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>
                <p className="font-medium">Generation Error</p>
                <p className="mt-1 text-red-600">{error}</p>
              </div>
            </div>
          )}
        </form>
      </div>

      {/* Process flow */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: '💬', label: 'You give intent', desc: 'Describe what you want' },
          { icon: '🗺️', label: 'AI maps w0', desc: 'Auto-derives container structure & selectors' },
          { icon: '⚡', label: 'AI writes code', desc: 'LangGraph loop + validation' },
          { icon: '👁', label: 'You preview', desc: 'Live animation → GTM guide' },
        ].map((step, i) => (
          <div
            key={i}
            className="rounded-lg border border-zinc-200 bg-zinc-50 p-4"
          >
            <div className="text-lg">{step.icon}</div>
            <p className="mt-2 text-sm font-semibold text-zinc-900">{step.label}</p>
            <p className="mt-0.5 text-xs text-zinc-500">{step.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
