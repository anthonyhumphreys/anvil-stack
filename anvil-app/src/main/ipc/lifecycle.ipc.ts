import { ipcMain } from 'electron';
import {
  createItem,
  updateItem,
  deleteItem,
  getItem,
  listItems,
  linkRepos,
  unlinkRepo,
  getGateTemplates,
  updateGateTemplate,
  resetGateTemplates,
  recordGateDecision,
  listGateDecisions,
} from '../services/lifecycle.service.js';
import { checkReadiness } from '../services/gate-readiness.service.js';
import { runAnalysis, getAnalysis, listAnalyses } from '../services/impact-analysis.service.js';
import { generatePack, listPacks, exportPack } from '../services/handover-pack.service.js';
import type {
  LifecycleStage,
  GateId,
  GateTemplateUpdate,
  GateDecisionOutcome,
  ImpactAnalysisScopeType,
} from '../../shared/lifecycle-types.js';
import type { WorkItemProvider } from '../../shared/types.js';

export function registerLifecycleHandlers(): void {
  // --- Lifecycle items ---

  ipcMain.handle(
    'lifecycle:create-item',
    (
      _event,
      workspaceId: string,
      opts: {
        title: string;
        description?: string;
        linkedWorkItemId?: string;
        linkedWorkItemProvider?: WorkItemProvider;
        changeClassification?: 'major' | 'minor' | 'standard';
      },
    ) => {
      try {
        return createItem(workspaceId, opts);
      } catch (err) {
        console.error('[Lifecycle IPC] Error creating item:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'lifecycle:update-item',
    (
      _event,
      id: string,
      opts: {
        title?: string;
        description?: string;
        stage?: LifecycleStage;
        changeClassification?: 'major' | 'minor' | 'standard';
        linkedWorkItemId?: string | null;
        linkedWorkItemProvider?: WorkItemProvider | null;
      },
    ) => {
      try {
        return updateItem(id, opts);
      } catch (err) {
        console.error('[Lifecycle IPC] Error updating item:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('lifecycle:delete-item', (_event, id: string) => {
    try {
      return deleteItem(id);
    } catch (err) {
      console.error('[Lifecycle IPC] Error deleting item:', err);
      throw err;
    }
  });

  ipcMain.handle('lifecycle:get-item', (_event, id: string) => {
    try {
      return getItem(id);
    } catch (err) {
      console.error('[Lifecycle IPC] Error getting item:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'lifecycle:list-items',
    (
      _event,
      workspaceId: string,
      filters?: { stage?: LifecycleStage; linkedWorkItemId?: string },
    ) => {
      try {
        return listItems(workspaceId, filters);
      } catch (err) {
        console.error('[Lifecycle IPC] Error listing items:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('lifecycle:link-repos', (_event, lifecycleItemId: string, repoIds: string[]) => {
    try {
      return linkRepos(lifecycleItemId, repoIds);
    } catch (err) {
      console.error('[Lifecycle IPC] Error linking repos:', err);
      throw err;
    }
  });

  ipcMain.handle('lifecycle:unlink-repo', (_event, lifecycleItemId: string, repoId: string) => {
    try {
      return unlinkRepo(lifecycleItemId, repoId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error unlinking repo:', err);
      throw err;
    }
  });

  // --- Gate templates ---

  ipcMain.handle('lifecycle:get-gate-templates', (_event, workspaceId: string) => {
    try {
      return getGateTemplates(workspaceId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error getting gate templates:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'lifecycle:update-gate-template',
    (_event, workspaceId: string, gate: GateId, updates: GateTemplateUpdate) => {
      try {
        return updateGateTemplate(workspaceId, gate, updates);
      } catch (err) {
        console.error('[Lifecycle IPC] Error updating gate template:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('lifecycle:reset-gate-templates', (_event, workspaceId: string) => {
    try {
      return resetGateTemplates(workspaceId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error resetting gate templates:', err);
      throw err;
    }
  });

  // --- Gate readiness ---

  ipcMain.handle('lifecycle:check-readiness', (_event, lifecycleItemId: string, gate: GateId) => {
    try {
      return checkReadiness(lifecycleItemId, gate);
    } catch (err) {
      console.error('[Lifecycle IPC] Error checking readiness:', err);
      throw err;
    }
  });

  // --- Gate decisions ---

  ipcMain.handle(
    'lifecycle:record-gate-decision',
    (
      _event,
      lifecycleItemId: string,
      opts: {
        gate: GateId;
        decision: GateDecisionOutcome;
        decidedBy: string;
        conditions?: string;
        rationale?: string;
      },
    ) => {
      try {
        return recordGateDecision(lifecycleItemId, opts);
      } catch (err) {
        console.error('[Lifecycle IPC] Error recording gate decision:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('lifecycle:list-gate-decisions', (_event, lifecycleItemId: string) => {
    try {
      return listGateDecisions(lifecycleItemId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error listing gate decisions:', err);
      throw err;
    }
  });

  // --- Impact analysis ---

  ipcMain.handle(
    'lifecycle:run-impact-analysis',
    async (
      _event,
      lifecycleItemId: string,
      opts: {
        scopeType: ImpactAnalysisScopeType;
        scopeRef?: string;
        repoId?: string;
        selectedModulePaths?: string[];
      },
    ) => {
      try {
        return await runAnalysis(lifecycleItemId, opts);
      } catch (err) {
        console.error('[Lifecycle IPC] Error running impact analysis:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('lifecycle:get-impact-analysis', (_event, id: string) => {
    try {
      return getAnalysis(id);
    } catch (err) {
      console.error('[Lifecycle IPC] Error getting impact analysis:', err);
      throw err;
    }
  });

  ipcMain.handle('lifecycle:list-impact-analyses', (_event, lifecycleItemId: string) => {
    try {
      return listAnalyses(lifecycleItemId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error listing impact analyses:', err);
      throw err;
    }
  });

  // --- Handover packs ---

  ipcMain.handle('lifecycle:generate-handover-pack', async (_event, lifecycleItemId: string) => {
    try {
      return await generatePack(lifecycleItemId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error generating handover pack:', err);
      throw err;
    }
  });

  ipcMain.handle('lifecycle:list-handover-packs', (_event, lifecycleItemId: string) => {
    try {
      return listPacks(lifecycleItemId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error listing handover packs:', err);
      throw err;
    }
  });

  ipcMain.handle('lifecycle:export-handover-pack', async (_event, packId: string) => {
    try {
      return await exportPack(packId);
    } catch (err) {
      console.error('[Lifecycle IPC] Error exporting handover pack:', err);
      throw err;
    }
  });
}
