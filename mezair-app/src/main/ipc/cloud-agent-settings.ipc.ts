import { ipcMain } from 'electron';
import type { AgentProvider } from '../../shared/types.js';
import type { CloudAgentConnectionProvider } from '../../shared/cloud-agent.js';
import {
  connectCloudAgentProvider,
  disconnectCloudAgentProvider,
  getCloudAgentSettings,
  setCloudAgentProviderEnabled,
} from '../services/cloud-agent-settings.service.js';

const activeConnections = new Map<CloudAgentConnectionProvider, AbortController>();

const CONNECTABLE = new Set<CloudAgentConnectionProvider>(['cursor', 'devin']);

function requireConnectable(value: unknown): CloudAgentConnectionProvider {
  if (typeof value !== 'string' || !CONNECTABLE.has(value as CloudAgentConnectionProvider))
    throw new Error('Unsupported cloud agent provider connection.');
  return value as CloudAgentConnectionProvider;
}

export function registerCloudAgentSettingsHandlers(): void {
  ipcMain.handle('cloud-agent-settings:get', () => getCloudAgentSettings());
  ipcMain.handle(
    'cloud-agent-settings:set-enabled',
    (_event, provider: AgentProvider, enabled: boolean) =>
      setCloudAgentProviderEnabled(provider, enabled),
  );
  ipcMain.handle('cloud-agent-settings:connect', async (_event, rawProvider: unknown) => {
    const provider = requireConnectable(rawProvider);
    if (activeConnections.has(provider))
      throw new Error(`${provider} connection is already in progress.`);
    const controller = new AbortController();
    activeConnections.set(provider, controller);
    try {
      return await connectCloudAgentProvider(provider, controller.signal);
    } finally {
      if (activeConnections.get(provider) === controller) activeConnections.delete(provider);
    }
  });
  ipcMain.handle('cloud-agent-settings:disconnect', (_event, rawProvider: unknown) => {
    const provider = requireConnectable(rawProvider);
    activeConnections.get(provider)?.abort();
    return disconnectCloudAgentProvider(provider);
  });
  ipcMain.handle('cloud-agent-settings:cancel', (_event, rawProvider: unknown) => {
    const provider = requireConnectable(rawProvider);
    activeConnections.get(provider)?.abort();
  });
}
