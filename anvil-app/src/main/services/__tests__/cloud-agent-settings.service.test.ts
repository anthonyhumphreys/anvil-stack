import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

vi.mock('node:os', () => ({
  default: { homedir: () => '/tmp/anvil-cloud-auth-test-no-user-home' },
}));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const { login } = vi.hoisted(() => ({ login: vi.fn() }));
const secretStorage = vi.hoisted(() => ({ state: 'ready' }));
const settings = vi.hoisted(() => ({
  llmGatewayBillingMode: 'devpass',
  llmProvider: 'codex',
  enabledLlmProviders: ['codex'],
  localLlmMode: 'off',
  localLlmProvider: 'apple',
  localLlmEndpoint: '',
  localLlmModel: '',
  ollamaEndpoint: '',
  ollamaModel: '',
  lmStudioEndpoint: '',
  lmStudioModel: '',
  threadAssistProvider: 'off',
  foundryEndpoint: '',
  foundryDeploymentName: '',
  foundryApiVersion: '2024-10-21',
  foundryApiKey: undefined as string | undefined,
  openaiApiKey: undefined as string | undefined,
  llmGatewayApiKey: undefined as string | undefined,
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../settings.service.js', () => ({ getSettings: () => settings }));
vi.mock('../auth.service.js', () => ({
  encryptSecret: (value: string) => Buffer.from(`encrypted:${value}`),
  decryptSecret: (value: Buffer | null) =>
    value?.toString().replace(/^encrypted:/, '') ?? undefined,
  getSecretStorageStatus: () => secretStorage,
}));
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('@cursor/sdk', () => ({ Cursor: { auth: { login } } }));

import {
  connectCloudAgentProvider,
  disconnectCloudAgentProvider,
  getCloudAgentSettings,
  isCloudAgentProviderEnabled,
  readCloudAgentCredential,
  setCloudAgentProviderEnabled,
  validateDevinCredentialsToml,
  validateCloudAgentProvider,
} from '../cloud-agent-settings.service.js';

beforeEach(() => {
  vi.stubEnv('CODEX_HOME', '/tmp/anvil-cloud-auth-test-no-user-home/codex');
  vi.stubEnv('XDG_DATA_HOME', '/tmp/anvil-cloud-auth-test-no-user-home/data');
  vi.stubEnv('ANVIL_CLOUD_AGENTS_ENABLED', 'false');
  db.exec('DELETE FROM cloud_agent_provider_settings');
  settings.openaiApiKey = undefined;
  settings.foundryApiKey = undefined;
  settings.foundryEndpoint = '';
  settings.foundryDeploymentName = '';
  settings.llmGatewayApiKey = undefined;
  login.mockReset();
  secretStorage.state = 'ready';
});

afterEach(() => vi.unstubAllEnvs());

describe('cloud agent provider settings', () => {
  it('does not start browser login when credentials cannot be saved', async () => {
    secretStorage.state = 'locked';
    const result = await connectCloudAgentProvider('cursor');
    expect(result.error).toMatch(/credential storage/);
    expect(login).not.toHaveBeenCalled();
  });

  it('defaults only Codex to enabled and never returns credentials in status', () => {
    const snapshot = getCloudAgentSettings();
    expect(snapshot.anvilCloudAgentsEnabled).toBe(false);
    expect(
      snapshot.providers.filter(({ enabled }) => enabled).map(({ provider }) => provider),
    ).toEqual(['codex']);
    expect(
      snapshot.providers.every((status) => !('secret' in status) && !('apiKey' in status)),
    ).toBe(true);
  });

  it('enables Anvil Cloud Agents only when the explicit flag is true', () => {
    vi.stubEnv('ANVIL_CLOUD_AGENTS_ENABLED', '1');
    expect(getCloudAgentSettings().anvilCloudAgentsEnabled).toBe(false);

    vi.stubEnv('ANVIL_CLOUD_AGENTS_ENABLED', 'true');
    expect(getCloudAgentSettings().anvilCloudAgentsEnabled).toBe(true);
  });

  it('persists enablement, validates readiness, and maps saved API credentials to worker env', () => {
    settings.openaiApiKey = 'private-openai-key';
    setCloudAgentProviderEnabled('openai', true);
    expect(isCloudAgentProviderEnabled('openai')).toBe(true);
    validateCloudAgentProvider('openai');
    expect(readCloudAgentCredential('openai')).toEqual({
      env: { OPENAI_API_KEY: 'private-openai-key' },
    });
    expect(() => validateCloudAgentProvider('cursor')).toThrow('disabled');
  });

  it('stores the Cursor SDK returned key encrypted and only exposes it to the main process', async () => {
    login.mockResolvedValue({
      apiKey: 'cursor-private-key',
      apiKeyExpiresAtMs: Date.now() + 60000,
    });
    const result = await connectCloudAgentProvider('cursor');
    const stored = db
      .prepare('SELECT credential_blob FROM cloud_agent_provider_settings WHERE provider = ?')
      .get('cursor') as { credential_blob: Buffer };
    expect(stored.credential_blob.toString()).toContain('encrypted:');
    expect(result.snapshot.providers.find(({ provider }) => provider === 'cursor')).toMatchObject({
      connected: true,
    });
    expect(
      result.snapshot.providers.find(({ provider }) => provider === 'cursor'),
    ).not.toHaveProperty('apiKey');
    setCloudAgentProviderEnabled('cursor', true);
    expect(readCloudAgentCredential('cursor').env).toEqual({
      CURSOR_API_KEY: 'cursor-private-key',
    });
  });

  it('removes a provider credential on disconnect', async () => {
    login.mockResolvedValue({
      apiKey: 'cursor-private-key',
      apiKeyExpiresAtMs: Date.now() + 60000,
    });
    await connectCloudAgentProvider('cursor');
    disconnectCloudAgentProvider('cursor');
    expect(
      db
        .prepare(
          'SELECT credential_blob, enabled FROM cloud_agent_provider_settings WHERE provider = ?',
        )
        .get('cursor'),
    ).toEqual({
      credential_blob: null,
      enabled: 0,
    });
  });

  it('accepts only bounded Devin TOML containing the documented api_token field', () => {
    expect(validateDevinCredentialsToml('api_token = "synthetic-devin-api-token"')).toBe(true);
    expect(validateDevinCredentialsToml('access_token = "synthetic-devin-api-token"')).toBe(false);
    expect(validateDevinCredentialsToml('api_token = "short"')).toBe(false);
    expect(validateDevinCredentialsToml('api_token = [invalid')).toBe(false);
    expect(validateDevinCredentialsToml(`api_token = "${'x'.repeat(65 * 1024)}"`)).toBe(false);
  });
  it('keeps selected gateway billing mode and its key together for the worker', () => {
    settings.llmGatewayApiKey = 'fixture-gateway-key';
    setCloudAgentProviderEnabled('llmgateway', true);
    expect(readCloudAgentCredential('llmgateway')).toEqual({
      env: { LLMGATEWAY_API_KEY: 'fixture-gateway-key', LLMGATEWAY_BILLING_MODE: 'devpass' },
    });
  });

  it('does not persist a key returned after login cancellation', async () => {
    const controller = new AbortController();
    login.mockImplementation(async () => {
      controller.abort();
      return { apiKey: 'cancelled-fixture-key', apiKeyExpiresAtMs: Date.now() + 60_000 };
    });
    const result = await connectCloudAgentProvider('cursor', controller.signal);
    expect(result.error).toMatch(/cancelled/);
    expect(result.snapshot.providers.find(({ provider }) => provider === 'cursor')?.connected).toBe(
      false,
    );
    expect(
      db
        .prepare(
          "SELECT credential_blob FROM cloud_agent_provider_settings WHERE provider='cursor'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('rejects expired keys and stops grants after the provider is disabled', async () => {
    login.mockResolvedValueOnce({
      apiKey: 'expired-fixture-key',
      apiKeyExpiresAtMs: Date.now() - 1,
    });
    expect((await connectCloudAgentProvider('cursor')).error).toBeDefined();
    login.mockResolvedValue({
      apiKey: 'valid-fixture-key',
      apiKeyExpiresAtMs: Date.now() + 60_000,
    });
    await connectCloudAgentProvider('cursor');
    setCloudAgentProviderEnabled('cursor', true);
    setCloudAgentProviderEnabled('cursor', false);
    expect(() => readCloudAgentCredential('cursor')).toThrow(/disabled/);
  });
});
