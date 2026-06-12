import type {
  WorkItem,
  WorkItemCreateInput,
  WorkItemFilters,
  Iteration,
} from '../../shared/types.js';
import { getSettings } from './settings.service.js';
import { adoProvider } from './ado.service.js';
import { linearProvider } from './linear.service.js';
import { jiraProvider } from './jira.service.js';

export interface WorkItemProviderService {
  listItems(filters?: WorkItemFilters): Promise<WorkItem[]>;
  getItem(id: string): Promise<WorkItem>;
  listIterations(): Promise<Iteration[]>;
  createItem(input: WorkItemCreateInput): Promise<WorkItem>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

export function getActiveProvider(): WorkItemProviderService | null {
  const settings = getSettings();
  switch (settings.workItemProvider) {
    case 'ado':
      return adoProvider;
    case 'linear':
      return linearProvider;
    case 'jira':
      return jiraProvider;
    case 'none':
      return null;
    default:
      return null;
  }
}
