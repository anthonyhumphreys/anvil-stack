import { ipcMain } from 'electron';
import type { CodexMcpRegisterInput, CodexSkillInstallInput } from '../../shared/types.js';
import {
  getCodexRegistrySnapshot,
  installCodexSkill,
  registerCodexMcp,
  searchSkillsShRegistry,
} from '../services/codex-registry.service.js';
import {
  getSkillRecommendationCatalog,
  inspectRecommendedSkillCollection,
  installRecommendedSkillCollection,
  saveOrganizationSkillRecommendations,
} from '../services/skill-recommendations.service.js';
import type {
  SaveSkillRecommendationsInput,
  SkillRecommendationSelection,
} from '../../shared/skill-recommendations.js';

export function registerCodexRegistryHandlers(): void {
  ipcMain.handle('codex-registry:snapshot', async () => getCodexRegistrySnapshot());
  ipcMain.handle('codex-registry:recommendations', () => getSkillRecommendationCatalog());
  ipcMain.handle(
    'codex-registry:inspect-collection',
    (_event, input: SkillRecommendationSelection) => inspectRecommendedSkillCollection(input),
  );
  ipcMain.handle(
    'codex-registry:install-collection',
    (_event, input: SkillRecommendationSelection & { skillName?: string }) =>
      installRecommendedSkillCollection(input),
  );
  ipcMain.handle(
    'codex-registry:save-recommendations',
    (_event, input: SaveSkillRecommendationsInput) => saveOrganizationSkillRecommendations(input),
  );

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
