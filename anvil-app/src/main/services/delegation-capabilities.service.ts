import type { AgentProvider } from '../../shared/types.js';
import type { ChatDelegationDestination } from '../../shared/chat-delegation.js';
import type { AgentToolSessionContext } from '../agent-tools/dispatch.js';
import { supportsRemoteWorkflowProvider } from '../../shared/workflow-target.js';
import { DEFAULT_CODEX_MODEL } from '../../shared/codex-models.js';
import { getSettings } from './settings.service.js';
import { getCodexSessionModel } from './codex-session.service.js';
import { detectCodexCli } from './codex-bridge.service.js';
import { detectCursorCli } from './cursor-bridge.service.js';
import { detectDevinCli } from './devin-bridge.service.js';
import { getLlmGatewayStatus } from './llm-gateway.service.js';
import { getCloudAgentSettings } from './cloud-agent-settings.service.js';
import {
  getRuntimeStatus,
  listDevices,
  listCloudEnvironments,
  listCloudProviderConnections,
} from './sync-runtime.service.js';

export interface DelegationCapabilities {
  providers: Array<{
    id: AgentProvider;
    localAvailable: boolean;
    defaultModel: string;
    models: Array<{ id: string; label: string }>;
  }>;
  destinations: ChatDelegationDestination[];
  notices: string[];
}

/** Only returns public capability metadata, never configuration or credentials. */
export async function discoverDelegationCapabilities(
  ctx: AgentToolSessionContext,
): Promise<DelegationCapabilities> {
  const settings = getSettings();
  const enabled = settings.enabledLlmProviders?.length
    ? settings.enabledLlmProviders
    : [settings.llmProvider];
  const [codex, cursor, devin, gateway] = await Promise.all([
    enabled.some((p) => p !== 'cursor' && p !== 'devin')
      ? detectCodexCli().catch(() => null)
      : null,
    enabled.includes('cursor') ? detectCursorCli().catch(() => null) : null,
    enabled.includes('devin') ? detectDevinCli().catch(() => null) : null,
    enabled.includes('llmgateway') ? getLlmGatewayStatus().catch(() => null) : null,
  ]);
  const providers = enabled.map((id): DelegationCapabilities['providers'][number] => {
    const models =
      id === 'cursor'
        ? (cursor?.models.map((m) => ({ id: m.id, label: m.label })) ?? [])
        : id === 'devin'
          ? (devin?.models.map((m) => ({ id: m.id, label: m.label })) ?? [])
          : id === 'llmgateway'
            ? (gateway?.models
                .filter((m) => !m.hidden)
                .map((m) => ({ id: m.id, label: m.displayName })) ?? [])
            : (codex?.models
                ?.filter((m) => !m.hidden)
                .map((m) => ({ id: m.id, label: m.displayName })) ?? []);
    const defaultModel =
      id === ctx.provider
        ? (getCodexSessionModel(ctx.sessionId) ?? settings.openaiModel)
        : id === 'cursor' || id === 'devin'
          ? 'auto'
          : id === 'llmgateway'
            ? (models[0]?.id ?? '')
            : settings.llmProvider === id ||
                models.some((model) => model.id === settings.openaiModel)
              ? settings.openaiModel
              : (codex?.configuredModel ?? DEFAULT_CODEX_MODEL);
    if (defaultModel && !models.some((m) => m.id === defaultModel))
      models.unshift({ id: defaultModel, label: defaultModel });
    const localAvailable =
      id === 'cursor'
        ? cursor?.installed === true
        : id === 'devin'
          ? devin?.installed === true && devin.authenticated !== false
          : id === 'llmgateway'
            ? codex?.installed === true && gateway?.connected === true
            : id === 'openai'
              ? codex?.installed === true && Boolean(settings.openaiApiKey)
              : id === 'azure'
                ? codex?.installed === true &&
                  Boolean(settings.foundryApiKey && settings.foundryEndpoint)
                : codex?.installed === true;
    return { id, localAvailable, defaultModel, models };
  });
  const destinations: ChatDelegationDestination[] = [
    {
      id: 'local',
      label: 'This device',
      target: { kind: 'local' },
      capabilities: ['shared-checkout'],
      providers: providers.filter((p) => p.localAvailable).map((p) => p.id),
      state: 'local',
    },
  ];
  const notices: string[] = [];
  const runtime = getRuntimeStatus();
  if (runtime.auth.state !== 'signed-in' || runtime.backendIdentityReviewRequired) {
    notices.push(
      'Fleet and cloud delegation need a connected Mesh account and trusted destinations.',
    );
    return { providers, destinations, notices };
  }
  const [devices, environments] = await Promise.allSettled([
    listDevices(),
    listCloudEnvironments(false),
  ]);
  const remoteProviders = providers.map((p) => p.id).filter(supportsRemoteWorkflowProvider);
  if (devices.status === 'fulfilled') {
    for (const device of devices.value.devices) {
      if (device.self || device.revoked || device.trustState !== 'trusted') continue;
      const host = runtime.meshHosts.find((h) => h.enrollmentId === device.enrollmentId);
      const capabilities = host?.capabilities ?? [];
      destinations.push({
        id: `device:${device.enrollmentId}`,
        label: device.displayName || 'Trusted device',
        target: { kind: 'device', enrollmentId: device.enrollmentId },
        capabilities,
        providers: remoteProviders.filter(
          (p) =>
            !capabilities.some((c) => c.startsWith('provider:')) ||
            capabilities.includes(`provider:${p}`),
        ),
        state: host?.state ?? 'unknown',
      });
    }
  } else notices.push('Could not refresh fleet capabilities. Check your Mesh connection.');
  const cloud = getCloudAgentSettings();
  const cloudProviders = remoteProviders.filter((p) =>
    cloud.providers.some((c) => c.provider === p && c.enabled && (p === 'codex' || c.connected)),
  );
  if (environments.status === 'fulfilled') {
    for (const environment of environments.value.environments) {
      if (!['enrolled', 'running', 'suspended'].includes(environment.state)) continue;
      destinations.push({
        id: `environment:${environment.environmentId}`,
        label: `${environment.provider} · ${environment.environmentId}`,
        target: { kind: 'existing-environment', environmentId: environment.environmentId },
        capabilities: ['isolated-checkout'],
        providers: cloudProviders,
        state: environment.state,
      });
    }
  } else notices.push('Could not refresh cloud environments. Check your Mesh connection.');
  for (const connection of listCloudProviderConnections()) {
    destinations.push({
      id: `cloud:${connection.id}`,
      label: connection.displayName || connection.provider,
      target: {
        kind: 'provisioned-environment',
        provider: connection.provider,
        connectionId: connection.id,
        ttlSeconds: 1800,
      },
      capabilities: ['isolated-checkout', 'temporary-environment'],
      providers: cloudProviders,
      state: 'provision-on-approval',
    });
  }
  if (cloud.anvilCloudAgentsEnabled)
    destinations.push({
      id: 'cloud:managed',
      label: 'Anvil Cloud Agents',
      target: { kind: 'provisioned-environment', provider: 'anvil-managed', ttlSeconds: 1800 },
      capabilities: ['isolated-checkout', 'temporary-environment'],
      providers: cloudProviders,
      state: 'provision-on-approval',
    });
  notices.push(
    'Remote jobs use committed snapshots. Dependencies pass reports, not code changes. Remote workflow providers: Codex, OpenAI and Azure.',
  );
  return { providers, destinations, notices };
}
