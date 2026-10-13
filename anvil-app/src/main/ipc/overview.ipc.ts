import { ipcMain } from 'electron';
import type {
  OverviewLayout,
  OverviewLayoutState,
  OverviewLayoutTarget,
  OverviewModuleRequest,
  OverviewModuleResult,
  OverviewScope,
  OverviewSources,
} from '../../shared/overview.js';
import {
  assertOverviewLayoutTarget,
  assertOverviewScope,
  getOverviewLayout,
  getOverviewSources,
  resetOverviewLayout,
  saveOverviewLayout,
  saveWorkspaceDefaultLayout,
} from '../services/overview-layout.service.js';
import { loadOverviewModule } from '../services/overview.service.js';

export function registerOverviewHandlers(): void {
  ipcMain.handle('overview:sources', (): OverviewSources => getOverviewSources());

  ipcMain.handle(
    'overview:get-layout',
    (_event, scope: OverviewScope): OverviewLayoutState =>
      getOverviewLayout(assertOverviewScope(scope)),
  );

  ipcMain.handle(
    'overview:save-layout',
    (_event, target: OverviewLayoutTarget, layout: OverviewLayout): OverviewLayout =>
      saveOverviewLayout(assertOverviewLayoutTarget(target), layout),
  );

  ipcMain.handle(
    'overview:save-workspace-default',
    (_event, workspaceId: string, layout: OverviewLayout): OverviewLayout => {
      const scope = assertOverviewScope({ kind: 'workspace', workspaceId });
      return saveWorkspaceDefaultLayout(
        scope.kind === 'workspace' ? scope.workspaceId : '',
        layout,
      );
    },
  );

  ipcMain.handle('overview:reset-layout', (_event, target: OverviewLayoutTarget): void => {
    resetOverviewLayout(assertOverviewLayoutTarget(target));
  });

  ipcMain.handle(
    'overview:load-module',
    (_event, request: OverviewModuleRequest): Promise<OverviewModuleResult> =>
      loadOverviewModule(request),
  );
}
