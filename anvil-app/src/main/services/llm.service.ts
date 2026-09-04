import { AzureOpenAI, OpenAI } from 'openai';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { getSettings } from './settings.service.js';
import { PRIMARY_CODEX_TEMP_PREFIX } from '../../shared/app-identity.js';
import { DEFAULT_CODEX_MODEL } from '../../shared/codex-models.js';
import {
  callPreferredLocalModel,
  classifyPromptForLocalModel,
  isLikelyLocalModelRefusal,
} from './local-llm.service.js';
import { LLM_GATEWAY_API_URL, LLM_GATEWAY_SOURCE } from '../../shared/llm-gateway.js';

let cachedClient: AzureOpenAI | OpenAI | null = null;
let cachedProvider: string | null = null;
let codexExecQueue: Promise<void> = Promise.resolve();
let codexQueueDepth = 0;

export interface LlmCallOptions {
  cwd?: string;
  taskClass?:
    | 'simple-json'
    | 'short-summary'
    | 'prompt-draft'
    | 'code-review'
    | 'security'
    | 'compliance'
    | 'long-context';
  onProgress?: (message: string) => void;
}

class EmptyLlmResponseError extends Error {}

const LOCAL_LLM_MAX_PROMPT_CHARS = 12_000;

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }

    process.kill(-pid, signal);
  } catch {
    // Process is already gone or cannot be signalled.
  }
}

function isLikelyJsonResponse(value: string): boolean {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\[[\s\S]*\]|\{[\s\S]*\})$/);
  if (!match) return false;

  try {
    JSON.parse(match[1]);
    return true;
  } catch {
    return false;
  }
}

function isLocalLlmEligible(prompt: string, maxTokens: number, options?: LlmCallOptions): boolean {
  if (!options?.taskClass) return false;
  if (prompt.length > LOCAL_LLM_MAX_PROMPT_CHARS) return false;
  if (maxTokens > 4096) return false;
  return true;
}

async function tryLocalLlm(
  prompt: string,
  maxTokens: number,
  options?: LlmCallOptions,
): Promise<string | null> {
  const settings = getSettings();
  if (settings.localLlmMode !== 'prefer-simple') return null;
  if (!isLocalLlmEligible(prompt, maxTokens, options)) return null;

  options?.onProgress?.('Checking whether the selected local model can handle this...');
  const route = await classifyPromptForLocalModel(prompt);
  if (route !== 'local') {
    if (route === 'cloud') {
      console.log('[LLM] On-device classifier routed prompt to the configured backend');
    } else {
      console.warn('[LLM] On-device classification unavailable; using configured backend');
    }
    return null;
  }

  options?.onProgress?.('Trying the selected local model...');
  const result = await callPreferredLocalModel(prompt, maxTokens);
  if (!result.ok || !result.content?.trim()) {
    const fallbackReason = result.error ? ` (${result.error})` : '';
    console.warn(`[LLM] Local model fallback${fallbackReason}`);
    options?.onProgress?.('Local model unavailable; falling back to configured LLM...');
    return null;
  }

  const content = result.content.trim();
  if (isLikelyLocalModelRefusal(content)) {
    console.warn('[LLM] Local model returned a refusal; falling back');
    options?.onProgress?.('Local model refused the request; falling back to configured LLM...');
    return null;
  }

  if (options?.taskClass === 'simple-json' && !isLikelyJsonResponse(content)) {
    console.warn('[LLM] Local model returned non-JSON for a JSON task; falling back');
    options?.onProgress?.('Local model returned invalid JSON; falling back to configured LLM...');
    return null;
  }

  console.log(`[LLM] Local model response accepted (${content.length} chars)`);
  return content;
}

/**
 * Read Codex CLI config.toml to get Azure endpoint, model, and env key.
 * Supports both the new model_providers format and the legacy openai_base_url.
 */
function readCodexConfig(): { baseUrl: string; model: string; envKey: string } | null {
  try {
    const toml = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf-8');
    const modelMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);

    // New format: [model_providers.azure] section with base_url and env_key
    const providerBaseUrl = toml.match(/\[model_providers\.azure\][^[]*?base_url\s*=\s*"([^"]+)"/s);
    const providerEnvKey = toml.match(/\[model_providers\.azure\][^[]*?env_key\s*=\s*"([^"]+)"/s);
    if (providerBaseUrl) {
      return {
        baseUrl: providerBaseUrl[1],
        model: modelMatch?.[1] ?? DEFAULT_CODEX_MODEL,
        envKey: providerEnvKey?.[1] ?? 'AZURE_OPENAI_API_KEY',
      };
    }

    // Legacy format: top-level openai_base_url
    const legacyBaseUrl = toml.match(/^\s*openai_base_url\s*=\s*"([^"]+)"/m);
    if (legacyBaseUrl) {
      return {
        baseUrl: legacyBaseUrl[1],
        model: modelMatch?.[1] ?? DEFAULT_CODEX_MODEL,
        envKey: 'OPENAI_API_KEY',
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get or create the LLM client based on the configured provider.
 * Only used for API-backed providers. Codex and Cursor route through their CLIs.
 */
function getClient(): { client: AzureOpenAI | OpenAI; model: string } {
  const settings = getSettings();
  const provider = settings.llmProvider ?? 'openai';
  console.log(`[LLM] getClient: provider=${provider}`);

  // Reset if provider changed
  if (cachedProvider !== provider) {
    console.log(`[LLM] Provider changed from ${cachedProvider} to ${provider}, resetting client`);
    cachedClient = null;
    cachedProvider = provider;
  }

  if (provider === 'azure') {
    // Azure config is read from Codex CLI's config.toml; API key from env.
    const codexConfig = readCodexConfig();
    if (!codexConfig) {
      throw new Error(
        'Azure AI Foundry: base_url not found in ~/.codex/config.toml.\n' +
          'See https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex',
      );
    }
    const apiKey = process.env[codexConfig.envKey];
    if (!apiKey) {
      throw new Error(`Azure AI Foundry: ${codexConfig.envKey} environment variable is not set.`);
    }
    if (!cachedClient) {
      // The SDK appends /openai/deployments/... — strip /openai and any trailing path.
      const endpoint = codexConfig.baseUrl.replace(/\/openai(\/.*)?$/, '');
      console.log(`[LLM] Creating Azure client: endpoint=${endpoint}`);
      cachedClient = new AzureOpenAI({
        endpoint,
        apiKey,
      });
    }
    return { client: cachedClient, model: codexConfig.model };
  }

  if (provider === 'llmgateway') {
    if (!settings.llmGatewayApiKey) {
      throw new Error('Connect LLMGateway in Settings before using this provider');
    }
    if (!cachedClient) {
      console.log('[LLM] Creating LLMGateway client');
      cachedClient = new OpenAI({
        apiKey: settings.llmGatewayApiKey,
        baseURL: LLM_GATEWAY_API_URL,
        defaultHeaders: { 'x-source': LLM_GATEWAY_SOURCE },
      });
    }
    return { client: cachedClient, model: settings.openaiModel || DEFAULT_CODEX_MODEL };
  }

  // OpenAI API key
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key must be configured in settings');
  }
  if (!cachedClient) {
    console.log('[LLM] Creating OpenAI client with API key');
    cachedClient = new OpenAI({
      apiKey: settings.openaiApiKey,
    });
  }
  return { client: cachedClient, model: settings.openaiModel || DEFAULT_CODEX_MODEL };
}

/**
 * Route a prompt through the Codex CLI using `codex exec`.
 * Streams progress to stderr; final response goes to stdout.
 */
function enqueueCodexExec<T>(
  task: () => Promise<T>,
  onProgress?: (message: string) => void,
): Promise<T> {
  const queuePosition = codexQueueDepth;
  codexQueueDepth += 1;

  if (queuePosition > 0) {
    onProgress?.(
      `Waiting for ${queuePosition} earlier Codex request${queuePosition === 1 ? '' : 's'}...`,
    );
  }

  const run = codexExecQueue.catch(() => undefined).then(task);
  codexExecQueue = run.then(
    () => undefined,
    () => undefined,
  );

  return run.finally(() => {
    codexQueueDepth = Math.max(0, codexQueueDepth - 1);
  });
}

function summariseCliStderr(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('WARNING: proceeding'));

  if (lines.length === 0) return null;

  const summary = lines.slice(-3).join(' | ');
  return summary.length > 280 ? `${summary.slice(0, 277)}...` : summary;
}

export function buildCursorPrintArgs(prompt: string, model = 'auto'): string[] {
  return ['-p', '--model', model, prompt];
}

export function buildCodexExecArgs(outputPath: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    outputPath,
    '-',
  ];
}

async function callCursor(
  prompt: string,
  options?: LlmCallOptions,
  model = 'auto',
): Promise<string> {
  const cleanPrompt = prompt.replace(/\0/g, '');
  const cwd = options?.cwd;
  console.log(
    `[LLM] Cursor CLI: sending prompt (${cleanPrompt.length} chars)${cwd ? ` cwd=${cwd}` : ''}`,
  );

  return enqueueCodexExec(
    async () =>
      new Promise((resolve, reject) => {
        options?.onProgress?.('Sending request to Cursor CLI...');
        const child = spawn('cursor-agent', buildCursorPrintArgs(cleanPrompt, model), {
          ...(cwd && { cwd }),
          env: { ...process.env },
          detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
          stderr += '\nCursor CLI timed out after 300 seconds.\n';
          killProcessTree(child.pid, 'SIGTERM');
        }, 300_000);
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', (err) => {
          clearTimeout(timeout);
          reject(new Error(`Cursor CLI error: ${err.message}`));
        });
        child.on('close', (code, signal) => {
          clearTimeout(timeout);
          const result = stdout.trim();
          if (code !== 0) {
            const msg =
              stderr.trim() || (signal ? `terminated by ${signal}` : `exited with code ${code}`);
            reject(new Error(`Cursor CLI error: ${msg}`));
            return;
          }
          if (!result) {
            const detail = summariseCliStderr(stderr);
            reject(
              new EmptyLlmResponseError(
                `Cursor CLI returned an empty response${detail ? `: ${detail}` : ''}`,
              ),
            );
            return;
          }
          resolve(result);
        });
      }),
    options?.onProgress,
  );
}

async function callCodex(prompt: string, options?: LlmCallOptions): Promise<string> {
  // Strip null bytes that can appear in file content
  const cleanPrompt = prompt.replace(/\0/g, '');
  const cwd = options?.cwd;
  console.log(
    `[LLM] Codex exec: sending prompt via stdin (${cleanPrompt.length} chars)${cwd ? ` cwd=${cwd}` : ''}`,
  );

  return enqueueCodexExec(async () => {
    options?.onProgress?.('Sending request to Codex...');

    const tempDir = mkdtempSync(join(tmpdir(), PRIMARY_CODEX_TEMP_PREFIX));
    const outputPath = join(tempDir, 'last-message.txt');

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let sigkillTimer: NodeJS.Timeout | undefined;
      let forceRejectTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup.
        }
      };

      const child = spawn('codex', buildCodexExecArgs(outputPath), {
        ...(cwd && { cwd }),
        env: {
          ...process.env,
          OTEL_SDK_DISABLED: 'true',
        },
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        timedOut = true;
        stderr += '\nCodex CLI timed out after 300 seconds.\n';
        killProcessTree(child.pid, 'SIGTERM');
        sigkillTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 2_000);
        sigkillTimer.unref();
        forceRejectTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('Codex CLI timed out after 300 seconds'));
        }, 7_000);
        forceRejectTimer.unref();
      }, 300_000);

      const clearTimers = () => {
        clearTimeout(timeout);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        if (forceRejectTimer) clearTimeout(forceRejectTimer);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        clearTimers();
        if (settled) return;
        settled = true;
        cleanup();
        console.error('[LLM] Codex exec spawn error:', err.message);
        reject(new Error(`Codex CLI error: ${err.message}`));
      });

      child.on('close', (code, signal) => {
        clearTimers();
        if (settled) return;
        settled = true;
        const fallback = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8').trim() : '';
        const result = stdout.trim() || fallback;
        const stderrSummary = summariseCliStderr(stderr);
        cleanup();

        if (code !== 0) {
          const msg =
            stderr.trim() ||
            (timedOut
              ? 'timed out after 300 seconds'
              : signal
                ? `terminated by ${signal}`
                : `exited with code ${code}`);
          console.error('[LLM] Codex exec failed:', msg);
          reject(new Error(`Codex CLI error: ${msg}`));
          return;
        }

        if (result.length === 0) {
          const detail = stderrSummary ? `: ${stderrSummary}` : '';
          reject(new EmptyLlmResponseError(`Codex CLI returned an empty response${detail}`));
          return;
        }

        console.log(
          `[LLM] Codex exec: got response (${result.length} chars)${stdout.trim() ? '' : ' via output file'}`,
        );
        resolve(result);
      });

      child.stdin.write(cleanPrompt);
      child.stdin.end();
    });
  }, options?.onProgress);
}

/** Reset cached client — call when settings change. */
export function resetLlmClient(): void {
  cachedClient = null;
  cachedProvider = null;
}

/**
 * Make an LLM call. Routes through Codex CLI or OpenAI SDK depending on provider.
 */
export async function callLlm(
  userMessage: string,
  maxTokens: number,
  temperature: number,
  maxRetries = 3,
  options?: LlmCallOptions,
): Promise<string> {
  const settings = getSettings();
  let lastEmptyResponseMessage: string | null = null;

  const localResult = await tryLocalLlm(userMessage, maxTokens, options);
  if (localResult) return localResult;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let result: string;

    if (settings.llmProvider === 'codex' || settings.llmProvider === 'cursor') {
      try {
        result =
          settings.llmProvider === 'cursor'
            ? await callCursor(userMessage, options, settings.openaiModel || 'auto')
            : await callCodex(userMessage, options);
      } catch (err) {
        if (err instanceof EmptyLlmResponseError) {
          lastEmptyResponseMessage = err.message;

          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
            const retryMessage = `CLI provider returned no content, retrying (${attempt + 2}/${maxRetries + 1})...`;
            console.warn(`[LLM] ${retryMessage}`);
            options?.onProgress?.(retryMessage);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        throw err;
      }
    } else {
      const { client, model } = getClient();
      const settings = getSettings();
      try {
        const body: Record<string, unknown> = {
          model,
          messages: [{ role: 'user', content: userMessage }],
          max_completion_tokens: maxTokens,
          temperature,
        };
        // Direct OpenAI API calls use the standard reasoning efforts. Codex-only max/ultra
        // travel through the Codex app-server path instead.
        if (
          model.startsWith('gpt-5') &&
          settings.reasoningLevel &&
          settings.reasoningLevel !== 'max' &&
          settings.reasoningLevel !== 'ultra'
        ) {
          body.reasoning_effort = settings.reasoningLevel;
        }
        const response = await client.chat.completions.create(
          body as unknown as Parameters<typeof client.chat.completions.create>[0],
        );
        result = 'choices' in response ? (response.choices[0]?.message?.content ?? '') : '';
      } catch (err: unknown) {
        const status = (err as { status?: number }).status;
        if (status === 429 && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          console.log(`[LLM] Rate limited, retrying in ${Math.round(delay)}ms...`);
          options?.onProgress?.(
            `Rate limited by the LLM provider, retrying (${attempt + 2}/${maxRetries + 1})...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }

    if (result.length > 0) return result;

    // Empty response — retry if we have attempts left
    lastEmptyResponseMessage = 'LLM returned empty response';
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(
        `[LLM] Empty response (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms...`,
      );
      options?.onProgress?.(
        `Received an empty response, retrying (${attempt + 2}/${maxRetries + 1})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
  }

  throw new Error(lastEmptyResponseMessage ?? 'LLM returned empty response after all retries');
}

/**
 * Test the configured LLM connection with a minimal request.
 */
export async function testLlmConnection(): Promise<{ ok: boolean; error?: string }> {
  console.log('[LLM] Testing connection...');
  try {
    const settings = getSettings();
    if (settings.llmProvider === 'codex' || settings.llmProvider === 'cursor') {
      console.log(`[LLM] Test: running ${settings.llmProvider} CLI ping`);
      if (settings.llmProvider === 'cursor') {
        await callCursor('respond with the word pong', undefined, settings.openaiModel || 'auto');
      } else {
        await callCodex('respond with the word pong');
      }
      console.log(`[LLM] Test: ${settings.llmProvider} connection OK`);
      return { ok: true };
    }

    const { client, model } = getClient();
    console.log(`[LLM] Test: sending ping to model=${model}`);
    await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_completion_tokens: 5,
    });
    console.log('[LLM] Test: connection OK');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[LLM] Test: connection FAILED:', msg);
    return { ok: false, error: msg };
  }
}
