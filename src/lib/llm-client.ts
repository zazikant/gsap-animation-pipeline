/**
 * Unified LLM client — dispatches to NVIDIA or OpenCode based on modelId.
 *
 * Mirrors `google-ads-subagent-vercel/app/api/chat-stream/route.ts` pattern:
 * the API route accepts `{ model, messages, ... }`, looks up the provider
 * config from MODELS, and forwards to the matching client.
 */

import { nvidiaChatCompletion, type NvidiaChatMessage, type NvidiaCallOptions } from './nvidia-client';
import {
  opencodeChatCompletion,
  type OpencodeChatMessage,
  type OpencodeCallOptions,
} from './opencode-client';
import { type ModelId, getModelConfig } from './models';

export type UnifiedChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface UnifiedCallOptions {
  modelId: ModelId;
  messages: UnifiedChatMessage[];
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  onLog?: (line: string) => void;
  onChunk?: (text: string) => void;
}

export interface UnifiedCallResult {
  content: string;
  reasoning: string;
  model: string;
  elapsedMs: number;
  attempts: number;
  provider: ModelId;
}

export async function unifiedChatCompletion(
  opts: UnifiedCallOptions,
): Promise<UnifiedCallResult> {
  const config = getModelConfig(opts.modelId);

  if (opts.modelId === 'nvidia-gpt-oss-120b') {
    const nvidiaOpts: NvidiaCallOptions = {
      model: config.model,
      messages: opts.messages as NvidiaChatMessage[],
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: config.timeoutMs,
      onLog: opts.onLog,
      onChunk: opts.onChunk,
    };
    const r = await nvidiaChatCompletion(nvidiaOpts);
    return { ...r, provider: opts.modelId };
  }

  if (opts.modelId === 'opencode-glm-5.1') {
    const opencodeOpts: OpencodeCallOptions = {
      model: config.model,
      messages: opts.messages as OpencodeChatMessage[],
      apiKey: opts.apiKey,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      timeoutMs: config.timeoutMs,
      reasoningEffort: config.reasoningEffort,
      onLog: opts.onLog,
      onChunk: opts.onChunk,
    };
    const r = await opencodeChatCompletion(opencodeOpts);
    return { ...r, provider: opts.modelId };
  }

  throw new Error(`Unknown modelId: ${opts.modelId}`);
}

export async function callUnifiedLLM(
  systemPrompt: string,
  userContent: string,
  modelId: ModelId,
  apiKey: string,
  maxTokens?: number,
  temperature?: number,
  onLog?: (line: string) => void,
  onChunk?: (text: string) => void,
): Promise<string> {
  const r = await unifiedChatCompletion({
    modelId,
    apiKey,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maxTokens,
    temperature,
    onLog,
    onChunk,
  });
  return r.content;
}
