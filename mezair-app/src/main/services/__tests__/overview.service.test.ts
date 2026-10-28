import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';
import {
  createOverviewModule,
  type OverviewModuleInstance,
  type OverviewModuleRequest,
  type OverviewScope,
} from '../../../shared/overview.js';
import type { AppSettings, CodeReviewPullRequest } from '../../../shared/types.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const mocks = vi.hoisted(() => ({
  settings: { workItemConnections: [], docsProvider: 'none' } as unknown as AppSettings,
  preferences: new Map<
    string,
    { workitems: Record<string, unknown>; docs: Record<string, unknown> }
  >(),
  listPullRequests: vi.fn<(remoteUrl?: string | null) => Promise<CodeReviewPullRequest[]>>(),
  listItems: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('../settings.service.js', () => ({ getSettings: () => mocks.settings }));
vi.mock('../workspace.service.js', () => ({
  listWorkspaces: () =>
    inMemoryDb.prepare('SELECT id, name FROM workspaces ORDER BY name').all() as Array<{
      id: string;
      name: string;
    }>,
  getWorkspacePreferences: (id: string) => mocks.preferences.get(id) ?? null,
}));
vi.mock('../workspace-activity.service.js', () => ({ getWorkspaceActivityFeed: () => [] }));
vi.mock('../git.service.js', () => ({
  getFullStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, files: [] })),
}));
vi.mock('../adr-discovery.service.js', () => ({ scanRepoForAdrs: () => [] }));
vi.mock('../docs-provider.js', () => ({ getActiveDocsProvider: () => null }));
vi.mock('../linear-docs.service.js', () => ({
  withLinearDocsApiKey: (_key: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({ listItems: mocks.listItems }),
}));
vi.mock('../code-review-pr.service.js', () => ({
  listPullRequests: mocks.listPullRequests,
  parseGitHubRemoteUrl: (url: string) =>
    url.includes('github.com') ? { provider: 'github' } : null,
  parseAdoRemoteUrl: () => null,
}));

import { clearOverviewCaches, documentReview, loadOverviewModule } from '../overview.service.js';
import {
  getOverviewLayout,
  resetOverviewLayout,
  saveOverviewLayout,
  saveWorkspaceDefaultLayout,
} from '../overview-layout.service.js';

const now = new Date().toISOString();
const global: OverviewScope = { kind: 'global' };
const backend: OverviewScope = { kind: 'workspace', workspaceId: 'ws-backend' };

function seed(): void {
  for (const table of [
    'overview_layouts',
    'security_findings',
    'security_audits',
    'chat_threads',
    'automation_runs',
    'automation_definitions',
    'workspace_notes',
    'workspace_repos',
    'repos',
    'workspaces',
  ]) {
    inMemoryDb.exec(`DELETE FROM ${table}`);
  }
  const workspace = inMemoryDb.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  );
  workspace.run('ws-backend', 'Backend', now, now);
  workspace.run('ws-web', 'Website', now, now);
  const repo = inMemoryDb.prepare(
    `INSERT INTO repos (id, name, path, remote_url, status, last_commit_date) VALUES (?, ?, ?, ?, 'indexed', ?)`,
  );
  repo.run('repo-api', 'api', '/tmp/api', 'https://github.com/acme/api.git', now);
  repo.run('repo-site', 'site', '/tmp/site', 'https://github.com/acme/site.git', now);
  repo.run('repo-shared', 'shared', '/tmp/shared', null, now);
  const link = inMemoryDb.prepare(
    `INSERT INTO workspace_repos (workspace_id, repo_id, added_at) VALUES (?, ?, ?)`,
  );
  link.run('ws-backend', 'repo-api', now);
  link.run('ws-web', 'repo-site', now);
  link.run('ws-backend', 'repo-shared', now);
  link.run('ws-web', 'repo-shared', now);
}

function audit(id: string, repoId: string, startedAt: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO security_audits (id, repo_id, scope, status, started_at, completed_at)
       VALUES (?, ?, '[]', 'completed', ?, ?)`,
    )
    .run(id, repoId, startedAt, startedAt);
}

function finding(
  id: string,
  auditId: string,
  severity: string,
  extra: Partial<{ workItemId: string; dismissed: number }> = {},
): void {
  inMemoryDb
    .prepare(
      `INSERT INTO security_findings (id, audit_id, severity, category, affected_files, description, work_item_id, dismissed)
       VALUES (?, ?, ?, 'Injection', '["src/db.ts"]', 'Unsanitised query', ?, ?)`,
    )
    .run(id, auditId, severity, extra.workItemId ?? null, extra.dismissed ?? 0);
}

function request(
  scope: OverviewScope,
  module: OverviewModuleInstance,
  refresh = false,
): OverviewModuleRequest {
  return { scope, module, timeRange: '7d', refresh };
}

beforeEach(() => {
  seed();
  clearOverviewCaches();
  mocks.listPullRequests.mockReset();
  mocks.listItems.mockReset();
  mocks.preferences.clear();
  mocks.settings = { workItemConnections: [], docsProvider: 'none' } as unknown as AppSettings;
});

describe('overview findings', () => {
  it('keeps workspace overviews inside their own repositories', async () => {
    audit('audit-site', 'repo-site', now);
    finding('f-site', 'audit-site', 'high');
    audit('audit-api', 'repo-api', now);
    finding('f-api', 'audit-api', 'critical');

    const result = await loadOverviewModule(request(backend, createOverviewModule('findings')));
    expect(result.rows.map((row) => (row as { id: string }).id)).toEqual(['security:f-api']);
  });

  it('uses only the latest audit, hides dismissed and logged findings by default', async () => {
    audit('old', 'repo-api', '2026-01-01T00:00:00.000Z');
    finding('f-old', 'old', 'critical');
    audit('new', 'repo-api', now);
    finding('f-open', 'new', 'high');
    finding('f-logged', 'new', 'high', { workItemId: 'ANV-1' });
    finding('f-dismissed', 'new', 'critical', { dismissed: 1 });
    finding('f-low', 'new', 'low');

    const unlogged = await loadOverviewModule(request(backend, createOverviewModule('findings')));
    expect(unlogged.rows.map((row) => (row as { id: string }).id)).toEqual(['security:f-open']);

    const all = await loadOverviewModule(
      request(
        backend,
        createOverviewModule('findings', { config: { findingStatus: 'all', severity: 'all' } }),
      ),
    );
    expect(all.rows.map((row) => (row as { id: string }).id).sort()).toEqual([
      'security:f-logged',
      'security:f-low',
      'security:f-open',
    ]);
  });

  it('shows a repository shared by two workspaces once, naming both', async () => {
    audit('audit-shared', 'repo-shared', now);
    finding('f-shared', 'audit-shared', 'high');

    const result = await loadOverviewModule(request(global, createOverviewModule('findings')));
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows as Array<{ workspaceName: string; alsoIn: string[] }>;
    expect([row.workspaceName, ...row.alsoIn].sort()).toEqual(['Backend', 'Website']);
  });
});

describe('overview pull requests', () => {
  const pullRequest = (overrides: Partial<CodeReviewPullRequest>): CodeReviewPullRequest => ({
    id: '1',
    title: 'Change',
    provider: 'github',
    state: 'open',
    isDraft: false,
    sourceBranch: 'feature',
    targetBranch: 'main',
    updatedAt: now,
    url: 'https://github.com/acme/api/pull/1',
    ...overrides,
  });

  it('distinguishes merged from closed-unmerged and skips repos without a hosted remote', async () => {
    mocks.listPullRequests.mockResolvedValue([
      pullRequest({ id: '1', state: 'merged' }),
      pullRequest({ id: '2', state: 'closed' }),
      pullRequest({ id: '3', state: 'closed', updatedAt: '2025-01-01T00:00:00.000Z' }),
    ]);
    const result = await loadOverviewModule(
      request(backend, createOverviewModule('pull-requests')),
    );
    expect(mocks.listPullRequests).toHaveBeenCalledTimes(1);
    expect(result.rows.map((row) => (row as { state: string }).state)).toEqual([
      'merged',
      'closed',
    ]);
    expect(result.source).toBe('GitHub');
  });

  it('keeps the last successful result when the source disconnects', async () => {
    const module = createOverviewModule('pull-requests');
    mocks.listPullRequests.mockResolvedValueOnce([pullRequest({ id: '7' })]);
    const first = await loadOverviewModule(request(backend, module));
    expect(first.state).toBe('ready');

    mocks.listPullRequests.mockRejectedValueOnce(new Error('Error: GitHub CLI not authenticated'));
    const second = await loadOverviewModule(request(backend, module, true));
    expect(second.state).toBe('disconnected');
    expect(second.message).toBe('GitHub CLI not authenticated.');
    expect(second.rows).toHaveLength(1);
    expect(second.lastSuccessAt).toBe(first.observedAt);
  });
});

describe('overview tickets', () => {
  it('asks for setup instead of broadening to another connection', async () => {
    mocks.settings = {
      workItemConnections: [{ id: 'conn-1', name: 'Platform', provider: 'linear' }],
      docsProvider: 'none',
    } as unknown as AppSettings;
    const result = await loadOverviewModule(request(backend, createOverviewModule('tickets')));
    expect(result.state).toBe('needs-setup');
    expect(result.setupTarget).toBe('workspace#connections');
    expect(mocks.listItems).not.toHaveBeenCalled();
  });

  it('keeps the workspace iteration scope for its own connection', async () => {
    mocks.settings = {
      workItemConnections: [{ id: 'conn-1', name: 'Platform', provider: 'linear' }],
      docsProvider: 'none',
    } as unknown as AppSettings;
    mocks.preferences.set('ws-backend', {
      workitems: { workItemConnectionId: 'conn-1', iterationIds: ['cycle-9'] },
      docs: {},
    });
    mocks.listItems.mockResolvedValue([
      {
        id: 'ANV-51',
        title: 'Dashboard',
        state: 'In Progress',
        type: 'Feature',
        priority: 2,
        provider: 'linear',
      },
    ]);
    const result = await loadOverviewModule(request(backend, createOverviewModule('tickets')));
    expect(mocks.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIds: ['cycle-9'] }),
    );
    expect(result.source).toBe('Linear · Platform');
    expect(result.rows).toHaveLength(1);
  });
});

describe('overview sessions and activity', () => {
  it('lists recent sessions with their state and skips settled threads', async () => {
    const thread = inMemoryDb.prepare(
      `INSERT INTO chat_threads (id, workspace_id, persona_id, title, attention_state, last_message_at, settled_at)
       VALUES (?, 'ws-backend', 'coder', ?, ?, ?, ?)`,
    );
    thread.run('t-1', 'Registry indexing review', 'idle', now, null);
    thread.run('t-2', 'Archived', 'complete', now, now);
    thread.run('t-3', 'Old', 'idle', '2025-01-01T00:00:00.000Z', null);

    const result = await loadOverviewModule(request(backend, createOverviewModule('sessions')));
    expect(result.rows.map((row) => (row as { threadId: string }).threadId)).toEqual(['t-1']);
    expect(result.emptyReason).toBe('no-recent-activity');
  });

  it('merges automation outcomes and notes into recent activity', async () => {
    inMemoryDb
      .prepare(
        `INSERT INTO automation_definitions (id, workspace_id, name, persona_id, prompt, schedule_cron, timezone, created_at, updated_at)
         VALUES ('auto-1', 'ws-backend', 'Nightly checks', 'coder', 'go', '* * * * *', 'UTC', ?, ?)`,
      )
      .run(now, now);
    inMemoryDb
      .prepare(
        `INSERT INTO automation_runs (id, automation_id, workspace_id, trigger, status, error_message, started_at, completed_at)
         VALUES ('run-1', 'auto-1', 'ws-backend', 'schedule', 'failed', 'Tests failed', ?, ?)`,
      )
      .run(now, now);
    inMemoryDb
      .prepare(
        `INSERT INTO workspace_notes (id, workspace_id, body, source, status, created_at)
         VALUES ('note-1', 'ws-backend', '# Setup walkthrough\nmore', 'desktop', 'open', ?)`,
      )
      .run(now);

    const result = await loadOverviewModule(
      request(
        backend,
        createOverviewModule('activity', { config: { eventTypes: ['automation', 'note'] } }),
      ),
    );
    const rows = result.rows as Array<{ kind: string; outcome: string; title: string }>;
    expect(rows.map((row) => [row.kind, row.outcome, row.title]).sort()).toEqual([
      ['automation', 'Failed', 'Nightly checks'],
      ['note', 'Note added', 'Setup walkthrough'],
    ]);
  });
});

describe('documentation review evidence', () => {
  it('suggests a review only when code moved on by more than a week', () => {
    expect(
      documentReview(
        { lastUpdated: '2026-09-01T00:00:00.000Z' },
        { repoName: 'api', date: '2026-10-01T00:00:00.000Z' },
      ),
    ).toEqual({
      review: 'needs-review',
      evidence: 'api changed on 2026-10-01; this page was last updated on 2026-09-01.',
    });
    expect(
      documentReview(
        { lastUpdated: '2026-09-28T00:00:00.000Z' },
        { repoName: 'api', date: '2026-10-01T00:00:00.000Z' },
      ),
    ).toEqual({ review: 'current' });
    expect(documentReview({ lastUpdated: '2026-09-28T00:00:00.000Z' }, null)).toEqual({
      review: 'unknown',
    });
  });
});

describe('overview layouts', () => {
  const sources = {
    workItemConnections: [],
    workspaceConnectionIds: {},
    docs: { provider: 'none' as const, configured: false },
  };

  it('layers workspace override over the shared default over built-in', () => {
    expect(getOverviewLayout(backend, sources).source).toBe('built-in');

    saveWorkspaceDefaultLayout('ws-backend', {
      version: 1,
      modules: [createOverviewModule('sessions', { id: 's' })],
    });
    const shared = getOverviewLayout({ kind: 'workspace', workspaceId: 'ws-web' }, sources);
    expect(shared.source).toBe('workspace-default');
    expect(shared.layout.modules.map((m) => m.id)).toEqual(['s']);

    saveOverviewLayout('workspace:ws-backend', {
      version: 1,
      modules: [createOverviewModule('repositories', { id: 'r' })],
    });
    const override = getOverviewLayout(backend, sources);
    expect(override.source).toBe('workspace-override');
    expect(override.fallback.modules.map((m) => m.id)).toEqual(['s']);

    resetOverviewLayout('workspace:ws-backend');
    expect(getOverviewLayout(backend, sources).source).toBe('workspace-default');
  });

  it('drops a workspace override when its workspace is deleted', () => {
    inMemoryDb.pragma('foreign_keys = ON');
    saveOverviewLayout('workspace:ws-web', {
      version: 1,
      modules: [createOverviewModule('repositories', { id: 'r' })],
    });
    inMemoryDb.exec("DELETE FROM workspace_repos WHERE workspace_id = 'ws-web'");
    inMemoryDb.exec("DELETE FROM workspaces WHERE id = 'ws-web'");
    expect(inMemoryDb.prepare('SELECT COUNT(*) AS count FROM overview_layouts').get()).toEqual({
      count: 0,
    });
    inMemoryDb.pragma('foreign_keys = OFF');
  });

  it('refuses to save a layout for a workspace that does not exist', () => {
    expect(() => saveOverviewLayout('workspace:missing', { version: 1, modules: [] })).toThrow(
      'no longer exists',
    );
  });
});
