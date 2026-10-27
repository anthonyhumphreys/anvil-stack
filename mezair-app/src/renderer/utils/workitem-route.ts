import type { WorkItemReference } from '../../shared/change-review-types';
import type { WorkItemProvider } from '../../shared/types';

const WORK_ITEM_PROVIDERS: ReadonlySet<string> = new Set<WorkItemProvider>([
  'ado',
  'linear',
  'jira',
  'github',
]);

export function parseWorkItemReference(params: URLSearchParams): WorkItemReference | undefined {
  const id = params.get('workItemId');
  const connectionId = params.get('workItemConnection');
  const provider = params.get('workItemProvider');
  if (!id || !connectionId || !provider || !WORK_ITEM_PROVIDERS.has(provider)) return undefined;
  return { id, connectionId, provider: provider as WorkItemProvider };
}
