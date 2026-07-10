import { ipcMain } from 'electron';
import type { AppSettings } from '../../shared/types.js';
import {
  getSettings,
  updateSettings,
  testFoundryConnection,
  testDocsProviderConnection,
  testGitConnection,
  resetOnboardingState,
} from '../services/settings.service.js';
import { resetLlmClient } from '../services/llm.service.js';
import { testAppleFoundationModels } from '../services/apple-foundation-models.service.js';
import { getActiveProvider } from '../services/workitem-provider.js';
import {
  readCodexAgentsFile,
  writeCodexAgentsFile,
} from '../services/codex-agents-file.service.js';
import { detectCodexCli, setCodexAgentMaxThreads } from '../services/codex-bridge.service.js';
import {
  isNotionMcpInstalled,
  installNotionMcp,
  startNotionOAuthFlow,
  exchangeNotionOAuthCode,
} from '../services/notion.service.js';

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', () => {
    try {
      const settings = getSettings();
      // Strip secrets from the response — renderer gets masked values
      return {
        ...settings,
        foundryApiKey: settings.foundryApiKey ? '••••••••' : undefined,
        openaiApiKey: settings.openaiApiKey ? '••••••••' : undefined,
        adoPat: settings.adoPat ? '••••••••' : undefined,
        linearApiKey: settings.linearApiKey ? '••••••••' : undefined,
        jiraApiToken: settings.jiraApiToken ? '••••••••' : undefined,
        confluencePat: settings.confluencePat ? '••••••••' : undefined,
        githubPat: settings.githubPat ? '••••••••' : undefined,
        notionOauthToken: settings.notionOauthToken ? '••••••••' : undefined,
      };
    } catch (err) {
      console.error('[Settings IPC] Error getting settings:', err);
      throw err;
    }
  });

  ipcMain.handle('settings:update', (_event, partial: Partial<AppSettings>) => {
    try {
      // Don't update secrets if the masked placeholder was sent back
      const cleaned = { ...partial };
      if (cleaned.foundryApiKey === '••••••••') delete cleaned.foundryApiKey;
      if (cleaned.openaiApiKey === '••••••••') delete cleaned.openaiApiKey;
      if (cleaned.adoPat === '••••••••') delete cleaned.adoPat;
      if (cleaned.linearApiKey === '••••••••') delete cleaned.linearApiKey;
      if (cleaned.jiraApiToken === '••••••••') delete cleaned.jiraApiToken;
      if (cleaned.confluencePat === '••••••••') delete cleaned.confluencePat;
      if (cleaned.githubPat === '••••••••') delete cleaned.githubPat;
      if (cleaned.notionOauthToken === '••••••••') delete cleaned.notionOauthToken;

      updateSettings(cleaned);
      resetLlmClient();
    } catch (err) {
      console.error('[Settings IPC] Error updating settings:', err);
      throw err;
    }
  });

  ipcMain.handle('settings:codex-status', async () => {
    try {
      return await detectCodexCli();
    } catch (err) {
      console.error('[Settings IPC] Error detecting Codex CLI:', err);
      throw err;
    }
  });

  ipcMain.handle('settings:codex-agent-max-threads', async (_event, maxThreads: number) => {
    setCodexAgentMaxThreads(maxThreads);
    return detectCodexCli();
  });

  ipcMain.handle('settings:test-foundry', async () => {
    try {
      return await testFoundryConnection();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:test-apple-foundation-models', async () => {
    try {
      return await testAppleFoundationModels();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:test-workitem-provider', async () => {
    try {
      const settings = getSettings();
      console.log('[Settings IPC] Testing work item provider:', settings.workItemProvider);
      const provider = getActiveProvider();
      if (!provider) return { ok: false, error: 'No work item provider selected' };
      const result = await provider.testConnection();
      console.log('[Settings IPC] Test result:', result);
      return result;
    } catch (err) {
      console.error('[Settings IPC] Test error:', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:linear-teams', async () => {
    try {
      const { listLinearTeams } = await import('../services/linear.service.js');
      return await listLinearTeams();
    } catch (err) {
      console.error('[Settings IPC] Error listing Linear teams:', err);
      return [];
    }
  });

  ipcMain.handle('settings:test-confluence', async () => {
    try {
      const { confluenceProvider } = await import('../services/confluence.service.js');
      return confluenceProvider.testConnection();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:test-docs-provider', async () => {
    try {
      return await testDocsProviderConnection();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:test-git', async () => {
    try {
      return await testGitConnection();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:notion-mcp-status', async () => {
    try {
      const installed = await isNotionMcpInstalled();
      return { installed };
    } catch (err) {
      return { installed: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:notion-mcp-install', async () => {
    try {
      return await installNotionMcp();
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:notion-oauth-start', async () => {
    try {
      return await startNotionOAuthFlow();
    } catch (err) {
      return { authUrl: '', state: '', error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:notion-oauth-exchange', async (_event, code: string) => {
    try {
      return await exchangeNotionOAuthCode(code);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('settings:codex-agents:get', async () => {
    try {
      return await readCodexAgentsFile();
    } catch (err) {
      console.error('[Settings IPC] Error reading Codex AGENTS.md:', err);
      throw err;
    }
  });

  ipcMain.handle('settings:codex-agents:save', async (_event, content: string) => {
    try {
      return await writeCodexAgentsFile(content);
    } catch (err) {
      console.error('[Settings IPC] Error saving Codex AGENTS.md:', err);
      throw err;
    }
  });

  ipcMain.handle('settings:reset-onboarding', async () => {
    try {
      resetOnboardingState();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
