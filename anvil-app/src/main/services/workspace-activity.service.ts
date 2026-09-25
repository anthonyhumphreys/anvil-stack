import type {
  AutomationTriageItem,
  Feature,
  WorkspaceActivityItem,
  WorkspaceActivityStatus,
  WorkspaceActivitySummary,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { listAutomationTriageItems } from './automation-persistence.service.js';
import { listWorkspaces } from './workspace.service.js';

const MAX_ITEMS_PER_WORKSPACE = 12;

interface AttentionThreadRow {
  id: string;
  workspace_id: string;
  title: string;
  persona_id: string;
  attention_state: string;
  attention_updated_at: string | null;
  last_viewed_at: string | null;
  last_message_at: string | null;
  updated_at: string;
}

interface RepoStatusRow {
  workspace_id: string;
  name: string;
  status: string;
}

interface ScaffoldRow {
  workspace_id: string;
  status: string;
  error_message: string | null;
  created_at: string;
}

function statusPriority(status: WorkspaceActivityStatus): number {
  if (status === 'error') return 5;
  if (status === 'warning') return 4;
  if (status === 'ready') return 3;
  if (status === 'running') return 2;
  return 1;
}

function dateValue(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function threadItem(row: AttentionThreadRow): WorkspaceActivityItem | null {
  const base = {
    id: `thread-${row.id}`,
    workspaceId: row.workspace_id,
    feature: 'chat' as Feature,
    route: `/chat?thread=${encodeURIComponent(row.id)}&persona=${encodeURIComponent(row.persona_id)}`,
    title: row.title,
    startedAt: row.attention_updated_at ?? row.last_message_at ?? row.updated_at,
  };
  switch (row.attention_state) {
    case 'approval':
      return { ...base, detail: 'Approval needed in Chat.', status: 'warning' };
    case 'input':
      return { ...base, detail: 'Your input is needed in Chat.', status: 'warning' };
    case 'failed':
      return { ...base, detail: 'The last turn failed.', status: 'error' };
    case 'working':
      return { ...base, detail: 'A turn is in progress.', status: 'running' };
    case 'complete': {
      const unseen =
        !row.last_viewed_at || dateValue(row.attention_updated_at) > dateValue(row.last_viewed_at);
      return unseen
        ? { ...base, detail: 'Completed work is ready to review.', status: 'ready' }
        : null;
    }
    default:
      return null;
  }
}

function automationItem(workspaceId: string, item: AutomationTriageItem): WorkspaceActivityItem {
  const detail =
    item.attention === 'blocked'
      ? (item.errorMessage ?? item.summary ?? 'Automation needs attention.')
      : item.attention === 'changes'
        ? (item.summary ?? `${item.changedFileCount} changed files are ready to review.`)
        : item.status === 'queued'
          ? 'Automation is queued.'
          : 'Automation is running.';
  const status: WorkspaceActivityStatus =
    item.attention === 'blocked'
      ? 'error'
      : item.attention === 'changes'
        ? 'ready'
        : item.status === 'queued'
          ? 'queued'
          : 'running';
  return {
    id: `automation-${item.id}`,
    workspaceId,
    feature: 'automations',
    route: `/automations?automation=${encodeURIComponent(item.automationId)}&run=${encodeURIComponent(item.id)}`,
    title: item.automationName,
    detail,
    status,
    startedAt: item.completedAt ?? item.startedAt,
  };
}

function scaffoldItem(row: ScaffoldRow): WorkspaceActivityItem | null {
  if (row.status === 'failed') {
    return {
      id: `scaffold-${row.workspace_id}`,
      workspaceId: row.workspace_id,
      feature: 'chat',
      route: '/chat',
      title: 'Workspace setup needs attention',
      detail: row.error_message ?? 'Scaffold session failed.',
      status: 'error',
      startedAt: row.created_at,
    };
  }
  if (row.status === 'active' || row.status === 'syncing' || row.status === 'indexing') {
    return {
      id: `scaffold-${row.workspace_id}`,
      workspaceId: row.workspace_id,
      feature: row.status === 'indexing' ? 'repos' : 'chat',
      route: row.status === 'indexing' ? '/workspace' : '/chat',
      title: row.status === 'indexing' ? 'Workspace indexing' : 'Workspace setup running',
      detail:
        row.status === 'indexing'
          ? 'Generated repositories are being indexed.'
          : 'Continue the scaffold flow in Chat.',
      status: 'running',
      startedAt: row.created_at,
    };
  }
  return null;
}

/**
 * Cross-workspace activity feed: threads needing attention, automation triage,
 * repo indexing/errors, and scaffold sessions — aggregated in one pass so the
 * sidebar workspace rail and the activity view stay cheap to refresh.
 */
export function getWorkspaceActivityFeed(): WorkspaceActivitySummary[] {
  const db = getDb();
  const workspaces = listWorkspaces();
  const byWorkspace = new Map<string, WorkspaceActivityItem[]>();

  const push = (item: WorkspaceActivityItem | null) => {
    if (!item) return;
    const list = byWorkspace.get(item.workspaceId) ?? [];
    list.push(item);
    byWorkspace.set(item.workspaceId, list);
  };

  const threadRows = db
    .prepare(
      `SELECT id, workspace_id, title, persona_id, attention_state, attention_updated_at,
              last_viewed_at, last_message_at, updated_at
       FROM chat_threads
       WHERE settled_at IS NULL
         AND workspace_id IS NOT NULL
         AND attention_state != 'idle'`,
    )
    .all() as AttentionThreadRow[];
  for (const row of threadRows) push(threadItem(row));

  const repoRows = db
    .prepare(
      `SELECT wr.workspace_id, r.name, r.status
       FROM workspace_repos wr JOIN repos r ON r.id = wr.repo_id
       WHERE r.status IN ('indexing', 'error')`,
    )
    .all() as RepoStatusRow[];
  const reposByWorkspace = new Map<string, { indexing: string[]; errored: string[] }>();
  for (const row of repoRows) {
    const bucket = reposByWorkspace.get(row.workspace_id) ?? { indexing: [], errored: [] };
    if (row.status === 'indexing') bucket.indexing.push(row.name);
    else bucket.errored.push(row.name);
    reposByWorkspace.set(row.workspace_id, bucket);
  }
  for (const [workspaceId, bucket] of reposByWorkspace) {
    if (bucket.indexing.length > 0) {
      push({
        id: `repos-indexing-${workspaceId}`,
        workspaceId,
        feature: 'repos',
        route: '/workspace',
        title: `${bucket.indexing.length} repo${bucket.indexing.length === 1 ? '' : 's'} indexing`,
        detail: bucket.indexing.join(', '),
        status: 'running',
      });
    }
    if (bucket.errored.length > 0) {
      push({
        id: `repos-error-${workspaceId}`,
        workspaceId,
        feature: 'repos',
        route: '/workspace',
        title: `${bucket.errored.length} repo${bucket.errored.length === 1 ? ' needs' : 's need'} attention`,
        detail: bucket.errored.join(', '),
        status: 'error',
      });
    }
  }

  const scaffoldRows = db
    .prepare(
      `SELECT workspace_id, status, error_message, created_at
       FROM workspace_scaffold_sessions
       WHERE status IN ('active', 'syncing', 'indexing', 'failed')`,
    )
    .all() as ScaffoldRow[];
  for (const row of scaffoldRows) push(scaffoldItem(row));

  for (const workspace of workspaces) {
    try {
      for (const item of listAutomationTriageItems(workspace.id)) {
        push(automationItem(workspace.id, item));
      }
    } catch (error) {
      console.warn('[WorkspaceActivity] Triage query failed:', error);
    }
  }

  const summaries: WorkspaceActivitySummary[] = [];
  for (const workspace of workspaces) {
    const items = (byWorkspace.get(workspace.id) ?? [])
      .sort((a, b) => {
        const delta = statusPriority(b.status) - statusPriority(a.status);
        return delta !== 0 ? delta : dateValue(b.startedAt) - dateValue(a.startedAt);
      })
      .slice(0, MAX_ITEMS_PER_WORKSPACE);
    if (items.length === 0) continue;
    summaries.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      status: items.reduce<WorkspaceActivityStatus>(
        (worst, item) =>
          statusPriority(item.status) > statusPriority(worst) ? item.status : worst,
        'queued',
      ),
      count: items.length,
      items,
    });
  }
  return summaries;
}
