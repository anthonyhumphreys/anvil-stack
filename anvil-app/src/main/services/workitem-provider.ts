import { publishWorkItemReview } from './workitem-review-publication.service.js';
import { withWorkItemContext } from './workitem-context.service.js';
import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
  Iteration,
} from '../../shared/types.js';
import { getSettings, applyWorkItemConnection } from './settings.service.js';
import { adoProvider } from './ado.service.js';
import { linearProvider } from './linear.service.js';
import { jiraProvider } from './jira.service.js';

export interface WorkItemProviderService {
  listItems(filters?: WorkItemFilters): Promise<WorkItem[]>;
  getItem(id: string): Promise<WorkItem>;
  listIterations(): Promise<Iteration[]>;
  createItem(input: WorkItemCreateInput): Promise<WorkItem>;
  publishReview?(id: string, text: string): Promise<void>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

export function getActiveProvider(
  connectionId?: string,
  fresh = false,
): WorkItemProviderService | null {
  let settings = getSettings();
  if (connectionId) {
    const connection = settings.workItemConnections?.find((c) => c.id === connectionId);
    if (!connection) throw new Error('The linked Work Item connection is no longer configured.');
    settings = {
      ...applyWorkItemConnection(settings, connection),
      activeWorkItemConnectionId: connectionId,
    };
  }
  const provider =
    settings.workItemProvider === 'ado'
      ? adoProvider
      : settings.workItemProvider === 'linear'
        ? linearProvider
        : settings.workItemProvider === 'jira'
          ? jiraProvider
          : null;
  if (!provider) return null;
  return {
    publishReview: (id, text) =>
      withWorkItemContext(settings, true, () => publishWorkItemReview(id, text)),
    listItems: (filters) => withWorkItemContext(settings, fresh, () => provider.listItems(filters)),
    getItem: (id) => withWorkItemContext(settings, fresh, () => provider.getItem(id)),
    listIterations: () => withWorkItemContext(settings, fresh, () => provider.listIterations()),
    createItem: (input) => withWorkItemContext(settings, fresh, () => provider.createItem(input)),
    testConnection: () => withWorkItemContext(settings, fresh, () => provider.testConnection()),
  };
}
