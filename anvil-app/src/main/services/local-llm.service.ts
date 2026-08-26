import type {
  LocalLlmCapabilities,
  LocalLlmProvider,
} from '../../shared/types.js';
import { callAppleFoundationModel } from './apple-foundation-models.service.js';
import { getSettings } from './settings.service.js';

export interface LocalLlmResult {
  ok: boolean;
  content?: string;
  unavailable?: boolean;
  error?: string;
}

export type LocalLlmRoute = 'local' | 'cloud';

const CLASSIFIER_MAX_SAMPLE_CHARS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

const DEFAULT_ENDPOINTS: Record<Exclude<LocalLlmProvider, 'apple'>, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  'lm-studio': 'http://127.0.0.1:1234/v1',
};

export function getLocalLlmCapabilities(): LocalLlmCapabilities {
  return {
    platform: process.platform,
    providers: process.platform === 'darwin' ? ['apple', 'ollama', 'lm-studio'] : ['ollama', 'lm-studio'],
  };
}

export function getDefaultLocalLlmEndpoint(provider: LocalLlmProvider): string {
  return provider === 'apple' ? '' : DEFAULT_ENDPOINTS[provider];
}

function normaliseOpenAiBaseUrl(provider: Exclude<LocalLlmProvider, 'apple'>, value: string): string {
  const endpoint = (value.trim() || DEFAULT_ENDPOINTS[provider]).replace(/\/+$/, '');
  return endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  return body.trim().slice(0, 500) || `${response.status} ${response.statusText}`;
}

async function resolveModel(baseUrl: string, configuredModel: string): Promise<string> {
  if (configuredModel.trim()) return configuredModel.trim();
  const response = await fetch(`${baseUrl}/models`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Could not list local models: ${await readError(response)}`);
  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  const model = payload.data?.find((candidate) => candidate.id?.trim())?.id?.trim();
  if (!model) throw new Error('No local model is loaded. Load a model or enter its model ID.');
  return model;
}

async function callOpenAiCompatibleLocalModel(
  provider: Exclude<LocalLlmProvider, 'apple'>,
  prompt: string,
  maxTokens: number,
): Promise<LocalLlmResult> {
  const settings = getSettings();
  const baseUrl = normaliseOpenAiBaseUrl(provider, settings.localLlmEndpoint);

  try {
    const model = await resolveModel(baseUrl, settings.localLlmModel);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `${provider} returned ${await readError(response)}` };
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    return content
      ? { ok: true, content }
      : { ok: false, error: `${provider} returned an empty response` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      unavailable: /fetch failed|ECONNREFUSED|timed out|abort/i.test(message),
      error: message,
    };
  }
}

export async function callPreferredLocalModel(
  prompt: string,
  maxTokens = 4096,
): Promise<LocalLlmResult> {
  const provider = getSettings().localLlmProvider;
  if (provider === 'apple') {
    if (process.platform !== 'darwin') {
      return { ok: false, unavailable: true, error: 'Apple Intelligence requires macOS.' };
    }
    return callAppleFoundationModel(prompt);
  }
  return callOpenAiCompatibleLocalModel(provider, prompt, maxTokens);
}

export function isLikelyLocalModelRefusal(value: string): boolean {
  return /(?:i apologize|i'm sorry|cannot assist|can't assist|unable to assist)/i.test(value);
}

export function parseLocalLlmRouteResponse(content: string | undefined | null): LocalLlmRoute | null {
  if (!content) return null;
  const trimmed = content.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { route?: unknown };
      if (parsed.route === 'local' || parsed.route === 'cloud') return parsed.route;
    } catch {
      // Fall through to the bare-word check.
    }
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === 'local' || lowered === '"local"') return 'local';
  if (lowered === 'cloud' || lowered === '"cloud"') return 'cloud';
  return null;
}

export async function classifyPromptForLocalModel(prompt: string): Promise<LocalLlmRoute | null> {
  const sample = prompt.slice(0, CLASSIFIER_MAX_SAMPLE_CHARS);
  const classificationPrompt = [
    'You are a routing classifier. Decide whether the user prompt below can be fully answered by a small local language model with no tools.',
    '',
    'Answer "local" ONLY if the prompt is simple, self-contained, and needs no repository or file access, no code edits, no command execution, no web access, and no deep multi-step reasoning.',
    'Answer "cloud" for anything involving code changes, repositories, files, tools, long or complex analysis, or anything you are unsure about.',
    '',
    'Respond with ONLY this JSON, nothing else: {"route": "local"} or {"route": "cloud"}',
    '',
    '--- USER PROMPT START ---',
    sample,
    '--- USER PROMPT END ---',
  ].join('\n');
  const result = await callPreferredLocalModel(classificationPrompt, 32);
  return result.ok ? parseLocalLlmRouteResponse(result.content) : null;
}

export async function testPreferredLocalModel(): Promise<{ ok: boolean; error?: string }> {
  const result = await callPreferredLocalModel('Respond with only the word pong.', 8);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? 'The selected local model is unavailable.' };
}
