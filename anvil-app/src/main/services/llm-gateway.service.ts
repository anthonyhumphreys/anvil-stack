import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import type {
  LlmGatewayBillingMode,
  LlmGatewayModel,
  LlmGatewayStatus,
  ReasoningEffort,
} from '../../shared/types.js';
import { LLM_GATEWAY_KEY_ENV, LLM_GATEWAY_SOURCE } from '../../shared/llm-gateway.js';
import { getSettings, updateSettings } from './settings.service.js';

const LLM_GATEWAY_LOGIN_URL = 'https://llmgateway.io/connect/cli';
const MODELS_DEV_URL = 'https://models.dev/api.json';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

let modelCache:
  | { billingMode: LlmGatewayBillingMode; models: LlmGatewayModel[]; expiresAt: number }
  | undefined;
let activeLogin: Promise<LlmGatewayStatus> | undefined;

interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  description?: string;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>;
}

function providerIdForMode(mode: LlmGatewayBillingMode): string {
  return mode === 'devpass' ? 'llmgateway' : 'llmgateway-providers';
}

function orgForMode(mode: LlmGatewayBillingMode): 'devpass' | 'default' {
  return mode === 'devpass' ? 'devpass' : 'default';
}

function supportedReasoningEfforts(model: ModelsDevModel): ReasoningEffort[] {
  if (!model.reasoning) return [];
  const explicit = (model.reasoning_options ?? [])
    .flatMap((option) => (option.type === 'effort' ? (option.values ?? []) : []))
    .filter((value): value is ReasoningEffort => REASONING_EFFORTS.has(value as ReasoningEffort));
  return explicit.length > 0 ? explicit : ['low', 'medium', 'high'];
}

export function parseLlmGatewayModels(
  catalog: Record<string, unknown>,
  billingMode: LlmGatewayBillingMode,
): LlmGatewayModel[] {
  const provider = catalog[providerIdForMode(billingMode)] as ModelsDevProvider | undefined;
  if (!provider?.models) return [];

  return Object.entries(provider.models)
    .filter(([, model]) => model.tool_call === true)
    .map(([catalogId, model]) => {
      const reasoningEfforts = supportedReasoningEfforts(model);
      return {
        id: model.id ?? catalogId,
        displayName: model.name ?? model.id ?? catalogId,
        description: model.description,
        supportedReasoningEfforts: reasoningEfforts,
        defaultReasoningEffort: reasoningEfforts.includes('medium')
          ? 'medium'
          : reasoningEfforts[0],
        serviceTiers: [],
        contextWindow: model.limit?.context,
        maxOutputTokens: model.limit?.output,
        inputPrice: model.cost?.input,
        outputPrice: model.cost?.output,
      } satisfies LlmGatewayModel;
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function listLlmGatewayModels(
  billingMode: LlmGatewayBillingMode,
  force = false,
): Promise<LlmGatewayModel[]> {
  if (!force && modelCache?.billingMode === billingMode && modelCache.expiresAt > Date.now()) {
    return modelCache.models;
  }

  const response = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`);
  const catalog = (await response.json()) as Record<string, unknown>;
  const models = parseLlmGatewayModels(catalog, billingMode);
  if (models.length === 0) {
    throw new Error(`No agent-capable models found for ${providerIdForMode(billingMode)}`);
  }
  modelCache = { billingMode, models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return models;
}

export async function getLlmGatewayStatus(
  forceModels = false,
  billingModeOverride?: LlmGatewayBillingMode,
): Promise<LlmGatewayStatus> {
  const settings = getSettings();
  const billingMode = billingModeOverride ?? settings.llmGatewayBillingMode;
  try {
    return {
      connected: Boolean(settings.llmGatewayApiKey),
      billingMode,
      models: await listLlmGatewayModels(billingMode, forceModels),
    };
  } catch (error) {
    return {
      connected: Boolean(settings.llmGatewayApiKey),
      billingMode,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildLlmGatewayLoginUrl(
  callback: string,
  state: string,
  billingMode: LlmGatewayBillingMode,
): string {
  const url = new URL(LLM_GATEWAY_LOGIN_URL);
  url.search = new URLSearchParams({
    callback,
    state,
    source: LLM_GATEWAY_SOURCE,
    org: orgForMode(billingMode),
    name: 'Anvil',
  }).toString();
  return url.toString();
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Failed to bind the LLMGateway login callback server'));
    });
  });
}

async function performLogin(billingMode: LlmGatewayBillingMode): Promise<LlmGatewayStatus> {
  const state = randomBytes(24).toString('hex');
  let settle: ((key: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const keyPromise = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    const key = url.searchParams.get('key');
    if (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`LLMGateway did not connect: ${error}`);
      fail?.(new Error(error));
      return;
    }
    if (!key || url.searchParams.get('state') !== state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid LLMGateway authorization response. Return to Anvil and try again.');
      fail?.(new Error('Invalid LLMGateway callback state'));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>LLMGateway connected</title><main style="font:16px system-ui;padding:3rem"><h1>Connected to Anvil</h1><p>You can close this window and return to Anvil.</p></main>',
    );
    settle?.(key);
  });

  const port = await listenOnLoopback(server);
  const callback = `http://127.0.0.1:${port}/callback`;
  const timeout = setTimeout(
    () => fail?.(new Error('LLMGateway login timed out after 5 minutes')),
    LOGIN_TIMEOUT_MS,
  );

  try {
    await shell.openExternal(buildLlmGatewayLoginUrl(callback, state, billingMode));
    const key = await keyPromise;
    updateSettings({ llmGatewayApiKey: key, llmGatewayBillingMode: billingMode });
    return getLlmGatewayStatus(true);
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

export function startLlmGatewayLogin(
  billingMode: LlmGatewayBillingMode,
): Promise<LlmGatewayStatus> {
  if (!activeLogin) {
    activeLogin = performLogin(billingMode).finally(() => {
      activeLogin = undefined;
    });
  }
  return activeLogin;
}

export async function disconnectLlmGateway(): Promise<LlmGatewayStatus> {
  updateSettings({ llmGatewayApiKey: '' });
  return getLlmGatewayStatus();
}

export function applyLlmGatewayEnvironment(
  env: Record<string, string>,
  apiKey: string | undefined,
): void {
  if (!apiKey) throw new Error('Connect LLMGateway in Settings before starting an agent.');
  env[LLM_GATEWAY_KEY_ENV] = apiKey;
}
