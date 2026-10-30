// Creates work items through the configured work item provider (Azure
// DevOps, Linear, Jira). Shared by the findings and dependencies surfaces.
import { getActiveProvider } from '../../../services/workitem-provider.js';
import { errorMessage } from './tool-kit.js';

export interface WorkItemDraft {
  targetId: string;
  title: string;
  description: string;
}

export interface WorkItemBatchResult {
  created: Array<{ targetId: string; workItemId: string }>;
  failed: Array<{ targetId: string; error: string }>;
}

export class NoWorkItemProviderError extends Error {
  constructor() {
    super(
      'No work item connection is configured. Connect Azure DevOps, Linear or Jira in Settings, then try again.',
    );
    this.name = 'NoWorkItemProviderError';
  }
}

export async function createWorkItemsForDrafts(
  drafts: readonly WorkItemDraft[],
): Promise<WorkItemBatchResult> {
  const provider = getActiveProvider();
  if (!provider) throw new NoWorkItemProviderError();
  const result: WorkItemBatchResult = { created: [], failed: [] };
  // Sequential: provider APIs rate-limit and the batch is user-selected (small).
  for (const draft of drafts) {
    try {
      const item = await provider.createItem({
        title: draft.title.slice(0, 250),
        description: draft.description,
      });
      result.created.push({ targetId: draft.targetId, workItemId: item.id });
    } catch (error) {
      result.failed.push({ targetId: draft.targetId, error: errorMessage(error) });
    }
  }
  return result;
}

export function describeWorkItemBatch(result: WorkItemBatchResult): string {
  const parts: string[] = [];
  if (result.created.length > 0) {
    parts.push(
      `Created ${result.created.length} work item${result.created.length === 1 ? '' : 's'} (${result.created
        .map((entry) => entry.workItemId)
        .join(', ')}).`,
    );
  }
  if (result.failed.length > 0) {
    parts.push(
      `${result.failed.length} failed: ${result.failed[0].error}${result.failed.length > 1 ? ' …' : ''}`,
    );
  }
  return parts.join(' ') || 'Nothing to create.';
}
