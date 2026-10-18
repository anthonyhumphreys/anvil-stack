import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';
const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  codex: vi.fn(),
  cursor: vi.fn(),
  devin: vi.fn(),
  gateway: vi.fn(),
  cloud: vi.fn(),
  runtime: vi.fn(),
  devices: vi.fn(),
  environments: vi.fn(),
  connections: vi.fn(),
}));
vi.mock('../settings.service.js', () => ({ getSettings: mocks.settings }));
vi.mock('../codex-session.service.js', () => ({ getCodexSessionModel: () => 'gpt-6.1-sol' }));
vi.mock('../codex-bridge.service.js', () => ({ detectCodexCli: mocks.codex }));
vi.mock('../cursor-bridge.service.js', () => ({ detectCursorCli: mocks.cursor }));
vi.mock('../devin-bridge.service.js', () => ({ detectDevinCli: mocks.devin }));
vi.mock('../llm-gateway.service.js', () => ({ getLlmGatewayStatus: mocks.gateway }));
vi.mock('../cloud-agent-settings.service.js', () => ({ getCloudAgentSettings: mocks.cloud }));
vi.mock('../sync-runtime.service.js', () => ({
  getRuntimeStatus: mocks.runtime,
  listDevices: mocks.devices,
  listCloudEnvironments: mocks.environments,
  listCloudProviderConnections: mocks.connections,
}));
import { discoverDelegationCapabilities } from '../delegation-capabilities.service.js';
const ctx: AgentToolSessionContext = {
  sessionId: 'session',
  appThreadId: 'thread',
  workspaceId: 'ws',
  repoIds: ['repo'],
  provider: 'codex',
  mode: 'on-request',
  features: ['chat'],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockReturnValue({
    llmProvider: 'codex',
    enabledLlmProviders: ['codex', 'cursor', 'openai'],
    openaiModel: 'gpt-6.1-sol',
    openaiApiKey: 'secret-do-not-return',
  });
  mocks.codex.mockResolvedValue({
    installed: true,
    models: [
      { id: 'gpt-6.1-sol', displayName: 'Sol 6.1' },
      { id: 'hidden', displayName: 'Hidden', hidden: true },
    ],
  });
  mocks.cursor.mockResolvedValue({ installed: true, models: [{ id: 'auto', label: 'Auto' }] });
  mocks.runtime.mockReturnValue({
    auth: { state: 'signed-in' },
    meshHosts: [
      { enrollmentId: 'trusted', state: 'online', capabilities: ['provider:codex', 'linux'] },
    ],
  });
  mocks.cloud.mockReturnValue({
    anvilCloudAgentsEnabled: true,
    providers: [
      { provider: 'codex', enabled: true, connected: true },
      { provider: 'openai', enabled: false, connected: true },
    ],
  });
  mocks.devices.mockResolvedValue({
    devices: [
      { enrollmentId: 'trusted', displayName: 'Linux builder', trustState: 'trusted' },
      { enrollmentId: 'untrusted', trustState: 'unknown' },
      { enrollmentId: 'revoked', trustState: 'trusted', revoked: true },
      { enrollmentId: 'self', trustState: 'trusted', self: true },
    ],
  });
  mocks.environments.mockResolvedValue({
    environments: [
      { environmentId: 'running', provider: 'aws', state: 'running' },
      { environmentId: 'dead', provider: 'aws', state: 'destroyed' },
    ],
  });
  mocks.connections.mockReturnValue([
    { id: 'aws', provider: 'aws', displayName: 'AWS' },
    { id: 'cloudflare', provider: 'cloudflare', displayName: 'Cloudflare' },
  ]);
});
describe('delegation capability discovery', () => {
  it('does not copy Cursor auto selection into a Codex task', async () => {
    mocks.settings.mockReturnValue({
      llmProvider: 'cursor',
      enabledLlmProviders: ['codex', 'cursor'],
      openaiModel: 'auto',
    });
    mocks.codex.mockResolvedValue({
      installed: true,
      configuredModel: 'gpt-6.1-sol',
      models: [{ id: 'gpt-6.1-sol', displayName: 'Sol 6.1' }],
    });
    const result = await discoverDelegationCapabilities({ ...ctx, provider: 'cursor' });
    expect(result.providers.find((provider) => provider.id === 'codex')).toMatchObject({
      defaultModel: 'gpt-6.1-sol',
    });
    expect(
      result.providers.find((provider) => provider.id === 'codex')?.models.map((model) => model.id),
    ).not.toContain('auto');
  });
  it('lists enabled models and trusted destinations without leaking credentials', async () => {
    const result = await discoverDelegationCapabilities(ctx);
    expect(result.providers.map((p) => p.id)).toEqual(['codex', 'cursor', 'openai']);
    expect(result.providers[0].models.map((m) => m.id)).not.toContain('hidden');
    expect(result.destinations.map((d) => d.id)).toEqual([
      'local',
      'device:trusted',
      'environment:running',
      'cloud:aws',
      'cloud:cloudflare',
      'cloud:managed',
    ]);
    expect(result.destinations.find((d) => d.id === 'device:trusted')?.providers).toEqual([
      'codex',
    ]);
    expect(result.destinations.find((d) => d.id === 'cloud:aws')?.providers).toEqual(['codex']);
    expect(JSON.stringify(result)).not.toContain('secret-do-not-return');
    expect(mocks.devin).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it('keeps local discovery available when Mesh is signed out or needs a trust review', async () => {
    for (const runtime of [
      { auth: { state: 'signed-out' } },
      { auth: { state: 'signed-in' }, backendIdentityReviewRequired: true },
    ]) {
      mocks.runtime.mockReturnValue(runtime);
      const result = await discoverDelegationCapabilities(ctx);
      expect(result.destinations.map((d) => d.id)).toEqual(['local']);
      expect(result.notices.join()).toContain('connected Mesh account');
    }
    expect(mocks.devices).not.toHaveBeenCalled();
  });
  it('tolerates partial discovery failures and does not advertise unavailable local providers', async () => {
    mocks.devices.mockRejectedValue(new Error('Offline'));
    mocks.codex.mockRejectedValue(new Error('Missing CLI'));
    mocks.cursor.mockResolvedValue({ installed: false, models: [] });
    const result = await discoverDelegationCapabilities(ctx);
    expect(result.destinations[0].providers).toEqual([]);
    expect(result.destinations.some((d) => d.id === 'cloud:cloudflare')).toBe(true);
    expect(result.notices.join()).toContain('Could not refresh fleet capabilities');
  });
});
