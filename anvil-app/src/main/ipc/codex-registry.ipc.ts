import { ipcMain } from 'electron';
import type { CodexMcpRegisterInput, CodexSkillInstallInput } from '../../shared/types.js';
import {
  getCodexRegistrySnapshot,
  installCodexSkill,
  registerCodexMcp,
  searchSkillsShRegistry,
} from '../services/codex-registry.service.js';

export function registerCodexRegistryHandlers(): void {
  ipcMain.handle('codex-registry:snapshot', async () => getCodexRegistrySnapshot());

  ipcMain.handle('codex-registry:search-skills', async (_event, query: string) => {
    try {
      return await searchSkillsShRegistry(query);
    } catch (err) {
      console.warn('[Codex Registry IPC] Failed to search skills.sh:', err);
      return [];
    }
  });

  ipcMain.handle('codex-registry:install-skill', async (_event, input: CodexSkillInstallInput) => {
    try {
      return await installCodexSkill(input);
    } catch (err) {
      return {
        success: false,
        command: 'npx skills add',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('codex-registry:register-mcp', async (_event, input: CodexMcpRegisterInput) => {
    try {
      return await registerCodexMcp(input);
    } catch (err) {
      return {
        success: false,
        command: 'codex mcp add',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
