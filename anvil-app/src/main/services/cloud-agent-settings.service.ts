import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/database.js';
import type { AgentProvider, AppSettings } from '../../shared/types.js';
import type {
  CloudAgentConnectionProvider,
  CloudAgentConnectionResult,
  CloudAgentProviderStatus,
  CloudAgentSettingsSnapshot,
} from '../../shared/cloud-agent.js';
import { decryptSecret, encryptSecret, getSecretStorageStatus } from './auth.service.js';
import { getSettings } from './settings.service.js';
import { LLM_GATEWAY_KEY_ENV } from '../../shared/llm-gateway.js';
import { parse as parseToml } from 'smol-toml';
import { shell } from 'electron';

const PROVIDERS: readonly AgentProvider[] = [
  'codex',
  'openai',
  'azure',
  'llmgateway',
  'cursor',
  'devin',
];
const CONNECTABLE: readonly CloudAgentConnectionProvider[] = ['cursor', 'devin'];
const MAX_DEVIN_CREDENTIAL_BYTES = 64 * 1024;
const DEVIN_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ENABLED: readonly AgentProvider[] = ['codex'];
const CURSOR_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const connectingProviders = new Set<CloudAgentConnectionProvider>();

interface ProviderRow {
  provider: string;
  enabled: number;
  credential_blob: Buffer | null;
  expires_at_ms: number | null;
}

interface CredentialRecord {
  secret: string;
  expiresAtMs?: number;
}

function validProvider(provider: string): provider is AgentProvider {
  return PROVIDERS.includes(provider as AgentProvider);
}

function validConnectable(provider: string): provider is CloudAgentConnectionProvider {
  return CONNECTABLE.includes(provider as CloudAgentConnectionProvider);
}

function row(provider: AgentProvider): ProviderRow | undefined {
  return getDb()
    .prepare('SELECT * FROM cloud_agent_provider_settings WHERE provider = ?')
    .get(provider) as ProviderRow | undefined;
}

function enabled(provider: AgentProvider): boolean {
  const saved = row(provider);
  return saved ? saved.enabled === 1 : DEFAULT_ENABLED.includes(provider);
}

function decryptCredential(provider: AgentProvider): CredentialRecord | undefined {
  const saved = row(provider);
  if (!saved?.credential_blob) return undefined;
  const raw = decryptSecret(saved.credential_blob, `cloud agent ${provider}`);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as CredentialRecord;
    if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function saveCredential(
  provider: CloudAgentConnectionProvider,
  secret: string,
  expiresAtMs?: number,
): void {
  const blob = encryptSecret(JSON.stringify({ secret, expiresAtMs } satisfies CredentialRecord));
  getDb()
    .prepare(
      `INSERT INTO cloud_agent_provider_settings (provider, enabled, credential_blob, expires_at_ms)
     VALUES (?, COALESCE((SELECT enabled FROM cloud_agent_provider_settings WHERE provider = ?), 0), ?, ?)
     ON CONFLICT(provider) DO UPDATE SET credential_blob = excluded.credential_blob,
       expires_at_ms = excluded.expires_at_ms, updated_at = datetime('now')`,
    )
    .run(provider, provider, blob, expiresAtMs ?? null);
}

function cursorExpiration(): number | undefined {
  return row('cursor')?.expires_at_ms ?? decryptCredential('cursor')?.expiresAtMs;
}

function devinCredentialPath(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'devin', 'credentials.toml');
  }
  return path.join(
    dataHome || path.join(os.homedir(), '.local', 'share'),
    'devin',
    'credentials.toml',
  );
}

function readDevinCredentials(): string | undefined {
  const candidates = [
    devinCredentialPath(),
    path.join(os.homedir(), '.config', 'devin', 'credentials.toml'),
  ];
  for (const filePath of candidates) {
    try {
      if (!existsSync(filePath)) continue;
      const stat = lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DEVIN_CREDENTIAL_BYTES)
        continue;
      const content = readFileSync(filePath, 'utf8');
      if (validateDevinCredentialsToml(content)) return content;
    } catch {
      // Try the alternate CLI data directory.
    }
  }
  return undefined;
}

export function validateDevinCredentialsToml(toml: string): boolean {
  if (Buffer.byteLength(toml, 'utf8') > MAX_DEVIN_CREDENTIAL_BYTES) return false;
  try {
    const parsed = parseToml(toml) as Record<string, unknown>;
    const token = parsed.api_token;
    return typeof token === 'string' && token.trim().length >= 16 && token.length <= 16_384;
  } catch {
    return false;
  }
}

function runDevinLogin(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Devin connection cancelled.'));
    let settled = false;
    let outputBytes = 0;
    let captured = '';
    const child = spawn('devin', ['auth', 'login'], {
      cwd: os.homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      finish(new Error('Devin connection cancelled.'));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      finish(
        new Error(
          'Devin login timed out. Try `devin auth login --force-manual-token-flow` in a terminal.',
        ),
      );
    }, DEVIN_LOGIN_TIMEOUT_MS);
    timeout.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunk: Buffer) => {
      if (outputBytes >= 8_192) return;
      const bounded = chunk.subarray(0, 8_192 - outputBytes);
      captured += bounded.toString('utf8');
      outputBytes += bounded.length;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => {
      const detail =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'Devin CLI is not installed. Install it, then connect again.'
          : 'Could not start Devin CLI login.';
      finish(new Error(detail));
    });
    child.once('close', (code) => {
      if (signal?.aborted) return finish(new Error('Devin connection cancelled.'));
      if (code !== 0)
        return finish(
          new Error(
            'Devin login did not complete. Try `devin auth login --force-manual-token-flow` in a terminal.',
          ),
        );
      if (!readDevinCredentials()) {
        // Do not surface CLI output here; it can contain authentication material.
        void captured;
        return finish(new Error('Devin login finished, but no usable credentials file was found.'));
      }
      finish();
    });
  });
}

function settingsHaveKey(settings: AppSettings, provider: AgentProvider): boolean {
  switch (provider) {
    case 'openai':
      return Boolean(settings.openaiApiKey?.trim());
    case 'azure':
      return Boolean(
        settings.foundryApiKey?.trim() &&
        settings.foundryEndpoint?.trim() &&
        settings.foundryDeploymentName?.trim(),
      );
    case 'llmgateway':
      return Boolean(settings.llmGatewayApiKey?.trim());
    default:
      return false;
  }
}

function localReadiness(
  provider: AgentProvider,
  settings: AppSettings,
): { connected: boolean; detail?: string } {
  if (provider === 'codex') {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    let hasHostAuth = false;
    try {
      const authPath = path.join(codexHome, 'auth.json');
      const stat = lstatSync(authPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024) {
        const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {
          OPENAI_API_KEY?: unknown;
          tokens?: { access_token?: unknown };
        };
        hasHostAuth =
          typeof auth.tokens?.access_token === 'string' || typeof auth.OPENAI_API_KEY === 'string';
      }
    } catch {
      hasHostAuth = false;
    }
    const hasExplicitFallback = Boolean(
      settings.openaiApiKey?.trim() ||
      process.env.CODEX_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim(),
    );
    if (hasHostAuth) return { connected: true };
    if (hasExplicitFallback)
      return {
        connected: true,
        detail: 'A saved API key is available as an explicit Codex authentication option.',
      };
    // A missing host token must not prevent the explicitly authorized device-code flow.
    return {
      connected: false,
      detail: 'No Codex host login is available; cloud runs can use device sign-in.',
    };
  }
  if (provider === 'openai' || provider === 'azure' || provider === 'llmgateway') {
    return settingsHaveKey(settings, provider)
      ? { connected: true }
      : {
          connected: false,
          detail:
            provider === 'azure'
              ? 'Add a Foundry key, endpoint, and deployment in provider settings.'
              : 'Add an API key in provider settings.',
        };
  }
  return { connected: false };
}

function providerStatus(provider: AgentProvider, settings: AppSettings): CloudAgentProviderStatus {
  const isEnabled = enabled(provider);
  if (validConnectable(provider) && connectingProviders.has(provider)) {
    return { provider, enabled: isEnabled, connected: false, connectionState: 'connecting' };
  }
  const secretStatus = getSecretStorageStatus();
  if (provider === 'cursor') {
    const expiration = cursorExpiration();
    if (expiration !== undefined && expiration <= Date.now()) {
      return {
        provider,
        enabled: isEnabled,
        connected: false,
        connectionState: 'expired',
        detail: 'Cursor key expired. Connect again.',
      };
    }
    const key = decryptCredential('cursor');
    if (key) return { provider, enabled: isEnabled, connected: true, connectionState: 'connected' };
    if (row('cursor')?.credential_blob && secretStatus.state !== 'ready') {
      return {
        provider,
        enabled: isEnabled,
        connected: false,
        connectionState: 'locked',
        detail: 'Unlock credential storage to use Cursor.',
      };
    }
    return { provider, enabled: isEnabled, connected: false, connectionState: 'disconnected' };
  }
  if (provider === 'devin') {
    const stored = decryptCredential('devin');
    if (stored && validateDevinCredentialsToml(stored.secret)) {
      return { provider, enabled: isEnabled, connected: true, connectionState: 'connected' };
    }
    if (row('devin')?.credential_blob && secretStatus.state !== 'ready') {
      return {
        provider,
        enabled: isEnabled,
        connected: false,
        connectionState: 'locked',
        detail: 'Unlock credential storage to use Devin.',
      };
    }
    const localAvailable = row('devin') === undefined && Boolean(readDevinCredentials());
    return {
      provider,
      enabled: isEnabled,
      connected: false,
      connectionState: 'disconnected',
      detail: localAvailable
        ? 'Devin CLI credentials are available on this device. Connect to reuse them.'
        : 'Connect to sign in to Devin.',
    };
  }
  const ready = localReadiness(provider, settings);
  return {
    provider,
    enabled: isEnabled,
    connected: ready.connected,
    connectionState: ready.connected ? 'connected' : 'disconnected',
    ...(ready.detail ? { detail: ready.detail } : {}),
  };
}

export function getCloudAgentSettings(): CloudAgentSettingsSnapshot {
  const settings = getSettings();
  return { providers: PROVIDERS.map((provider) => providerStatus(provider, settings)) };
}

export function isCloudAgentProviderEnabled(provider: AgentProvider): boolean {
  if (!validProvider(provider)) throw new Error('Invalid cloud agent provider.');
  return enabled(provider);
}

export function setCloudAgentProviderEnabled(
  provider: AgentProvider,
  isEnabled: boolean,
): CloudAgentSettingsSnapshot {
  if (!validProvider(provider)) throw new Error('Invalid cloud agent provider.');
  if (typeof isEnabled !== 'boolean') throw new Error('Enabled must be a boolean.');
  getDb()
    .prepare(
      `INSERT INTO cloud_agent_provider_settings (provider, enabled)
     VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
    )
    .run(provider, isEnabled ? 1 : 0);
  return getCloudAgentSettings();
}

export function setCloudAgentProviderConnecting(
  provider: CloudAgentConnectionProvider,
  isConnecting: boolean,
): void {
  if (!validConnectable(provider)) throw new Error('Provider cannot be connected here.');
  if (isConnecting) connectingProviders.add(provider);
  else connectingProviders.delete(provider);
}

export async function connectCloudAgentProvider(
  provider: CloudAgentConnectionProvider,
  signal?: AbortSignal,
): Promise<CloudAgentConnectionResult> {
  if (!validConnectable(provider)) throw new Error('Provider cannot be connected here.');
  if (getSecretStorageStatus().state !== 'ready') {
    return {
      snapshot: getCloudAgentSettings(),
      error:
        'Unlock or set up credential storage in Privacy settings before connecting a cloud provider.',
    };
  }
  setCloudAgentProviderConnecting(provider, true);
  const abortController = new AbortController();
  if (signal?.aborted) abortController.abort();
  const onAbort = () => abortController.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, DEVIN_LOGIN_TIMEOUT_MS);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (provider === 'cursor') {
      const { Cursor } = await import('@cursor/sdk');
      const result = await Cursor.auth.login({
        store: null,
        apiKeyTtlMs: CURSOR_KEY_TTL_MS,
        apiKeyName: 'Anvil Cloud Agents',
        signal: abortController.signal,
        openBrowser: async (loginUrl: string) => {
          const url = new URL(loginUrl);
          if (url.protocol !== 'https:' || !['cursor.com', 'www.cursor.com'].includes(url.hostname))
            throw new Error('Cursor returned an unexpected sign-in URL.');
          await shell.openExternal(url.toString());
        },
      });
      if (abortController.signal.aborted) throw new Error('Cursor connection cancelled.');
      if (!result.apiKey?.trim() || result.apiKey.length > 16_384)
        throw new Error('Cursor login returned an invalid API key.');
      if (!Number.isFinite(result.apiKeyExpiresAtMs) || result.apiKeyExpiresAtMs <= Date.now())
        throw new Error('Cursor login returned an expired API key.');
      saveCredential(provider, result.apiKey, result.apiKeyExpiresAtMs);
    } else {
      let content = decryptCredential('devin')?.secret ?? readDevinCredentials();
      if (!content) {
        await runDevinLogin(abortController.signal);
        if (abortController.signal.aborted) throw new Error('Devin connection cancelled.');
        content = readDevinCredentials();
      }
      if (!content) throw new Error('Devin credentials could not be read after login.');
      if (abortController.signal.aborted) throw new Error('Devin connection cancelled.');
      saveCredential(provider, content);
    }
    setCloudAgentProviderConnecting(provider, false);
    return { snapshot: getCloudAgentSettings() };
  } catch (error) {
    const message = abortController.signal.aborted
      ? `${provider === 'cursor' ? 'Cursor' : 'Devin'} connection ${timedOut ? 'timed out.' : 'cancelled.'}`
      : provider === 'cursor'
        ? 'Cursor sign-in could not be completed. Check the browser flow and try again.'
        : error instanceof Error
          ? error.message
          : 'Devin login could not be completed.';
    setCloudAgentProviderConnecting(provider, false);
    return { snapshot: getCloudAgentSettings(), error: message };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    setCloudAgentProviderConnecting(provider, false);
  }
}

export function disconnectCloudAgentProvider(
  provider: CloudAgentConnectionProvider,
): CloudAgentSettingsSnapshot {
  if (!validConnectable(provider)) throw new Error('Provider cannot be disconnected here.');
  getDb()
    .prepare(
      `INSERT INTO cloud_agent_provider_settings (provider, enabled, credential_blob, expires_at_ms)
     VALUES (?, ?, NULL, NULL) ON CONFLICT(provider) DO UPDATE SET credential_blob = NULL,
       expires_at_ms = NULL, updated_at = datetime('now')`,
    )
    .run(provider, enabled(provider) ? 1 : 0);
  return getCloudAgentSettings();
}

export function readCloudAgentCredential(provider: AgentProvider): {
  env: Record<string, string>;
  devinCredentialsToml?: string;
} {
  validateCloudAgentProvider(provider);
  const settings = getSettings();
  switch (provider) {
    case 'codex': {
      const token =
        settings.openaiApiKey?.trim() ||
        process.env.CODEX_API_KEY?.trim() ||
        process.env.OPENAI_API_KEY?.trim();
      return { env: token ? { OPENAI_API_KEY: token } : {} };
    }
    case 'openai':
      return { env: { OPENAI_API_KEY: settings.openaiApiKey! } };
    case 'azure':
      return {
        env: {
          AZURE_OPENAI_API_KEY: settings.foundryApiKey!,
          AZURE_OPENAI_ENDPOINT: settings.foundryEndpoint,
          AZURE_OPENAI_API_VERSION: settings.foundryApiVersion,
          AZURE_OPENAI_DEPLOYMENT: settings.foundryDeploymentName,
        },
      };
    case 'llmgateway':
      return {
        env: {
          [LLM_GATEWAY_KEY_ENV]: settings.llmGatewayApiKey!,
          LLMGATEWAY_BILLING_MODE: settings.llmGatewayBillingMode,
        },
      };
    case 'cursor':
      return { env: { CURSOR_API_KEY: decryptCredential('cursor')!.secret } };
    case 'devin':
      return { env: {}, devinCredentialsToml: decryptCredential('devin')!.secret };
  }
}

export function validateCloudAgentProvider(provider: AgentProvider): void {
  if (!validProvider(provider)) throw new Error('Invalid cloud agent provider.');
  if (!enabled(provider)) throw new Error(`${provider} is disabled for cloud agents.`);
  const status = providerStatus(provider, getSettings());
  if (provider === 'codex' && status.detail?.includes('cloud runs can use device sign-in')) return;
  if (!status.connected) throw new Error(status.detail ?? `${provider} is not connected.`);
}
