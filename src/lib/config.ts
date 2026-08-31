'use client';

import { DEFAULT_MODEL, type ModelId } from './models';

const STORAGE_KEY = 'gsap-pipeline:config:v1';

export interface PersistedConfig {
  readonly modelId: ModelId;
  readonly apiKey: string;
}

export function loadConfig(): PersistedConfig {
  if (typeof window === 'undefined') {
    return { modelId: DEFAULT_MODEL, apiKey: '' };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { modelId: DEFAULT_MODEL, apiKey: '' };
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    return {
      modelId: parsed.modelId === 'opencode-glm-5.1' ? 'opencode-glm-5.1' : DEFAULT_MODEL,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
    };
  } catch {
    return { modelId: DEFAULT_MODEL, apiKey: '' };
  }
}

export function saveConfig(config: PersistedConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }
}
