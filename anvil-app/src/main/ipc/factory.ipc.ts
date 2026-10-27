import { ipcMain } from 'electron';
import type {
  FactoryActivateInput,
  FactoryControlInput,
  FactoryDefinitionInput,
  FactoryPreviewOptions,
  FactoryRunControlInput,
  FactorySaveInput,
} from '../../shared/factories.js';
import {
  activateFactory,
  controlFactory,
  controlFactoryRun,
  draftFactory,
  getFactory,
  getFactoryRun,
  listFactories,
  listFactoryRuns,
  listFactoryOrganizations,
  listFactoryOrganizationMembers,
  listFactoryDirectory,
  registerFactoryOrganizationKey,
  validateFactoryOrganizationTeam,
  previewFactory,
  saveFactory,
} from '../services/factory.service.js';

export function registerFactoryHandlers(): void {
  ipcMain.handle('factories:draft', (_event, request: string, workspaceId: string) =>
    draftFactory(request, workspaceId),
  );
  ipcMain.handle(
    'factories:preview',
    (
      _event,
      definition: FactoryDefinitionInput,
      factoryId?: string,
      options?: FactoryPreviewOptions,
    ) => previewFactory(definition, factoryId, { repinWorkflow: options?.repinWorkflow === true }),
  );
  ipcMain.handle('factories:save', (_event, input: FactorySaveInput) => saveFactory(input));
  ipcMain.handle('factories:activate', (_event, input: FactoryActivateInput) =>
    activateFactory(input),
  );
  ipcMain.handle('factories:list', (_event, workspaceId?: string) => listFactories(workspaceId));
  ipcMain.handle('factories:get', (_event, factoryId: string) => getFactory(factoryId));
  ipcMain.handle('factories:list-runs', (_event, factoryId: string) => listFactoryRuns(factoryId));
  ipcMain.handle('factories:get-run', (_event, runId: string) => getFactoryRun(runId));
  ipcMain.handle('factories:control', (_event, input: FactoryControlInput) =>
    controlFactory(input),
  );
  ipcMain.handle('factories:control-run', (_event, input: FactoryRunControlInput) =>
    controlFactoryRun(input),
  );
  ipcMain.handle('factories:organizations', () => listFactoryOrganizations());
  ipcMain.handle('factories:organization-members', (_event, organizationId: string) =>
    listFactoryOrganizationMembers(organizationId),
  );
  ipcMain.handle(
    'factories:organization-team',
    (
      _event,
      organizationId: string,
      source: { host: 'github.com'; owner: string; repo: string },
      teamId: string,
    ) => validateFactoryOrganizationTeam(organizationId, source, teamId),
  );
  ipcMain.handle('factories:organization-key-register', (_event, organizationId: string) =>
    registerFactoryOrganizationKey(organizationId),
  );
  ipcMain.handle('factories:directory', (_event, organizationId?: string) =>
    listFactoryDirectory(organizationId),
  );
}
