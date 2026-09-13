import { BrowserWindow, ipcMain } from 'electron';
import type { WorkspaceCloneRequest, WorkspaceCreateOptions } from '../../shared/types.js';
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addReposToWorkspace,
  removeReposFromWorkspace,
  listWorkspaceRepoDefinitions,
  mapWorkspaceRepoToCheckout,
  getWorkspacePreferences,
  updateWorkspacePreferences,
  clearWorkspacePreferences,
  exportVSCodeWorkspace,
} from '../services/workspace.service.js';
import {
  linkWorkspaceRepo,
  listWorkspaceMaterializationOps,
  purgeQuarantinedCheckout,
  removeWorkspaceCheckout,
  startWorkspaceClone,
} from '../services/workspace-materialization.service.js';
import {
  computeBootstrapDigest,
  explainBootstrapRecipe,
  getWorkspaceBootstrap,
  isBootstrapApproved,
  listBootstrapApprovals,
  listBootstrapRuns,
  recordBootstrapApproval,
  resolveWorkspaceCommits,
  revokeBootstrapApproval,
  startBootstrapRun,
  workspaceCheckoutRoot,
} from '../services/bootstrap-policy.service.js';
import { buildDevicePolicy } from '../services/mesh-worker.service.js';
import type {
  WorkspaceBootstrapApprovalSummary,
  WorkspaceBootstrapStatus,
} from '../../shared/types.js';
import { scanForReposAsync, cancelScan } from '../services/repo-scan.service.js';
import { ensureGateTemplates } from '../services/lifecycle.service.js';

interface WorkspaceHandlersOptions {
  openWorkspaceWindow?: (workspaceId: string) => void;
}

export function registerWorkspaceHandlers(options: WorkspaceHandlersOptions = {}): void {
  ipcMain.handle('workspace:list', () => {
    try {
      return listWorkspaces();
    } catch (err) {
      console.error('[Workspace IPC] Error listing workspaces:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:get', (_event, id: string) => {
    try {
      return getWorkspace(id);
    } catch (err) {
      console.error('[Workspace IPC] Error getting workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:create', (_event, opts: WorkspaceCreateOptions) => {
    try {
      const workspace = createWorkspace(opts);
      ensureGateTemplates(workspace.id);
      return workspace;
    } catch (err) {
      console.error('[Workspace IPC] Error creating workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:get-preferences', (_event, workspaceId: string) => {
    try {
      return getWorkspacePreferences(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error getting workspace preferences:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace:update-preferences',
    (
      _event,
      workspaceId: string,
      updates: {
        workitems?: Record<string, unknown>;
        docs?: Record<string, unknown>;
        launch?: Record<string, unknown>;
      },
    ) => {
      try {
        return updateWorkspacePreferences(workspaceId, updates);
      } catch (err) {
        console.error('[Workspace IPC] Error updating workspace preferences:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'workspace:clear-preferences',
    (_event, workspaceId: string, sections?: Array<'workitems' | 'docs' | 'launch'>) => {
      try {
        return clearWorkspacePreferences(workspaceId, sections);
      } catch (err) {
        console.error('[Workspace IPC] Error clearing workspace preferences:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('workspace:update', (_event, id: string, opts: { name: string }) => {
    try {
      return updateWorkspace(id, opts);
    } catch (err) {
      console.error('[Workspace IPC] Error updating workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:delete', (_event, id: string) => {
    try {
      return deleteWorkspace(id);
    } catch (err) {
      console.error('[Workspace IPC] Error deleting workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:add-repos', (_event, workspaceId: string, repoIds: string[]) => {
    try {
      return addReposToWorkspace(workspaceId, repoIds);
    } catch (err) {
      console.error('[Workspace IPC] Error adding repos to workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:remove-repos', (_event, workspaceId: string, repoIds: string[]) => {
    try {
      return removeReposFromWorkspace(workspaceId, repoIds);
    } catch (err) {
      console.error('[Workspace IPC] Error removing repos from workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:repo-definitions', (_event, workspaceId: string) => {
    try {
      return listWorkspaceRepoDefinitions(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error listing repo definitions:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace:map-repo',
    (_event, workspaceId: string, portableId: string, repoId: string) => {
      try {
        if (typeof portableId !== 'string' || portableId.length === 0) {
          throw new Error('portableId is required');
        }
        if (typeof repoId !== 'string' || repoId.length === 0) {
          throw new Error('repoId is required');
        }
        return mapWorkspaceRepoToCheckout(workspaceId, portableId, repoId);
      } catch (err) {
        console.error('[Workspace IPC] Error mapping repo definition:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('workspace:start-clone', async (_event, input: WorkspaceCloneRequest) => {
    try {
      if (typeof input !== 'object' || input === null) {
        throw new Error('clone request is required');
      }
      return await startWorkspaceClone(input);
    } catch (err) {
      console.error('[Workspace IPC] Error starting workspace clone:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace:link-repo',
    async (
      _event,
      workspaceId: string,
      portableId: string,
      checkoutPath: string,
      options?: { allowRemoteDivergence?: boolean },
    ) => {
      try {
        if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
          throw new Error('checkoutPath is required');
        }
        return await linkWorkspaceRepo(workspaceId, portableId, checkoutPath, options ?? {});
      } catch (err) {
        console.error('[Workspace IPC] Error linking repo:', err);
        throw err;
      }
    },
  );

  ipcMain.handle(
    'workspace:remove-checkout',
    async (
      _event,
      workspaceId: string,
      portableId: string,
      options?: { deleteCheckout?: boolean },
    ) => {
      try {
        if (typeof portableId !== 'string' || portableId.length === 0) {
          throw new Error('portableId is required');
        }
        return await removeWorkspaceCheckout(workspaceId, portableId, options ?? {});
      } catch (err) {
        console.error('[Workspace IPC] Error removing checkout:', err);
        throw err;
      }
    },
  );

  ipcMain.handle('workspace:purge-quarantine', async (_event, quarantineId: string) => {
    try {
      if (typeof quarantineId !== 'string' || quarantineId.length === 0) {
        throw new Error('quarantineId is required');
      }
      return await purgeQuarantinedCheckout(quarantineId);
    } catch (err) {
      console.error('[Workspace IPC] Error purging quarantined checkout:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:materialization-ops', (_event, workspaceId: string) => {
    try {
      return listWorkspaceMaterializationOps(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error listing materialisation ops:', err);
      throw err;
    }
  });

  ipcMain.handle(
    'workspace:bootstrap-status',
    async (_event, workspaceId: string): Promise<WorkspaceBootstrapStatus> => {
      const recipe = getWorkspaceBootstrap(workspaceId);
      if (recipe === null) {
        return { recipe: null, digest: null, approved: false, explanation: null, runs: [] };
      }
      const input = {
        recipe,
        repositoryCommits: await resolveWorkspaceCommits(workspaceId),
        executionPolicy: buildDevicePolicy(),
      };
      const digest = computeBootstrapDigest(input);
      return {
        recipe,
        digest,
        approved: isBootstrapApproved(workspaceId, digest, recipe),
        explanation: explainBootstrapRecipe(recipe),
        runs: listBootstrapRuns(workspaceId),
      };
    },
  );

  ipcMain.handle(
    'workspace:bootstrap-approve',
    async (
      _event,
      workspaceId: string,
      options?: { shellApproved?: boolean },
    ): Promise<{ approval: WorkspaceBootstrapApprovalSummary; runId: string | null }> => {
      const recipe = getWorkspaceBootstrap(workspaceId);
      if (recipe === null) throw new Error('workspace has no bootstrap recipe');
      const input = {
        recipe,
        repositoryCommits: await resolveWorkspaceCommits(workspaceId),
        executionPolicy: buildDevicePolicy(),
      };
      const approval = recordBootstrapApproval(workspaceId, {
        ...input,
        shellApproved: options?.shellApproved === true,
      });
      // Approving implies intent to run — start immediately when a checkout
      // exists; otherwise the run stays a pending record the materialisation
      // flow can trigger after cloning.
      const checkoutRoot = workspaceCheckoutRoot(workspaceId);
      const runId = checkoutRoot
        ? startBootstrapRun({ workspaceId, ...input, checkoutRoot }).runId
        : null;
      return { approval, runId };
    },
  );

  ipcMain.handle('workspace:bootstrap-run', async (_event, workspaceId: string) => {
    const recipe = getWorkspaceBootstrap(workspaceId);
    if (recipe === null) throw new Error('workspace has no bootstrap recipe');
    const checkoutRoot = workspaceCheckoutRoot(workspaceId);
    if (checkoutRoot === null) throw new Error('workspace has no mapped checkout');
    return startBootstrapRun({
      workspaceId,
      recipe,
      repositoryCommits: await resolveWorkspaceCommits(workspaceId),
      executionPolicy: buildDevicePolicy(),
      checkoutRoot,
    }).runId;
  });

  ipcMain.handle(
    'workspace:bootstrap-revoke-approval',
    (_event, approvalId: string): { revoked: boolean } => {
      if (typeof approvalId !== 'string' || approvalId.length === 0) {
        throw new Error('approvalId is required');
      }
      revokeBootstrapApproval(approvalId);
      return { revoked: true };
    },
  );

  ipcMain.handle(
    'workspace:bootstrap-approvals',
    (_event, workspaceId: string): WorkspaceBootstrapApprovalSummary[] =>
      listBootstrapApprovals(workspaceId),
  );

  ipcMain.handle('workspace:export-vscode', async (_event, workspaceId: string) => {
    try {
      return await exportVSCodeWorkspace(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error exporting VS Code workspace:', err);
      throw err;
    }
  });

  ipcMain.handle('workspace:open-in-new-window', (_event, workspaceId: string) => {
    try {
      getWorkspace(workspaceId);
      if (!options.openWorkspaceWindow) {
        throw new Error('Workspace window opener is not registered');
      }
      options.openWorkspaceWindow(workspaceId);
    } catch (err) {
      console.error('[Workspace IPC] Error opening workspace in new window:', err);
      throw err;
    }
  });

  ipcMain.handle('repo:scan', async (_event, folderPath: string, maxDepth?: number) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const repos = await scanForReposAsync(folderPath, maxDepth, (repo) => {
        win?.webContents.send('repo:scan-progress', repo);
      });
      return repos;
    } catch (err) {
      console.error('[Workspace IPC] Error scanning for repos:', err);
      throw err;
    }
  });

  ipcMain.handle('repo:cancel-scan', () => {
    try {
      cancelScan();
    } catch (err) {
      console.error('[Workspace IPC] Error cancelling scan:', err);
      throw err;
    }
  });
}
