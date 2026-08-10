import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import {
  appendAutomationRunEvent,
  claimPendingWatchtowerEvent,
  completeAutomationRun,
  countEnabledAutomations,
  createAutomationRecord,
  createAutomationRun,
  enqueueWatchtowerEvent,
  getAutomation,
  getAutomationRun,
  listAutomationRunEvents,
  listAutomationRuns,
  listAutomations,
  listDueAutomations,
  listExternalWatchtowerAutomations,
  listPendingWatchtowerEvents,
  listWatchtowerAutomations,
  updateAutomationRecord,
  updateAutomationRunWorktrees,
  updateWatchtowerState,
} from '../automation-persistence.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM automation_run_events');
  inMemoryDb.exec('DELETE FROM watchtower_events');
  inMemoryDb.exec('DELETE FROM automation_runs');
  inMemoryDb.exec('DELETE FROM automation_definitions');
  inMemoryDb.exec('DELETE FROM workspace_preferences');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb.exec('DELETE FROM repos');

  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run('ws-1', 'Workspace');

  inMemoryDb
    .prepare(
      `INSERT INTO repos (
         id,
         name,
         path,
         remote_url,
         default_branch,
         status,
         file_count,
         branch_count,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, NULL, 'main', 'indexed', 0, 1, datetime('now'), datetime('now'))`,
    )
    .run('repo-1', 'orders-service', '/tmp/orders-service');
});

describe('automation persistence', () => {
  it('creates and updates workspace automations', () => {
    const created = createAutomationRecord(
      'ws-1',
      {
        name: 'Morning triage',
        personaId: 'coder',
        prompt: 'Summarise the most important changes.',
        repoIds: ['repo-1'],
        scheduleCron: '0 9 * * 1-5',
        timezone: 'Europe/London',
        enabled: true,
        allowRepoWrite: true,
        allowCommandRun: true,
      },
      '2026-04-29T08:00:00.000Z',
    );

    expect(created.workspaceId).toBe('ws-1');
    expect(created.repoIds).toEqual(['repo-1']);
    expect(listAutomations('ws-1')).toHaveLength(1);

    const updated = updateAutomationRecord(
      created.id,
      {
        name: 'Morning triage updated',
        personaId: 'docs',
        prompt: 'Check documentation drift.',
        repoIds: ['repo-1'],
        scheduleCron: '0 10 * * 1-5',
        timezone: 'UTC',
        enabled: false,
        allowRepoWrite: false,
        allowCommandRun: false,
      },
      null,
    );

    expect(updated?.name).toBe('Morning triage updated');
    expect(updated?.enabled).toBe(false);
    expect(updated?.nextRunAt).toBeUndefined();
  });

  it('persists automation loop configuration', () => {
    const created = createAutomationRecord(
      'ws-1',
      {
        name: 'Review loop',
        personaId: 'coder',
        prompt: 'Implement and review the next ready task.',
        repoIds: ['repo-1'],
        scheduleCron: '0 9 * * 1-5',
        timezone: 'Europe/London',
        enabled: true,
        allowRepoWrite: true,
        allowCommandRun: true,
        loopConfig: {
          enabled: true,
          mode: 'sequence',
          memberPersonaIds: ['coder', 'reviewer', 'security'],
          separateThreads: true,
          maxIterations: 3,
          stopCondition: 'Stop after reviewer finds no actionable issues.',
        },
      },
      '2026-04-29T08:00:00.000Z',
    );

    expect(created.loopConfig).toEqual({
      enabled: true,
      mode: 'sequence',
      memberPersonaIds: ['coder', 'reviewer', 'security'],
      separateThreads: true,
      maxIterations: 3,
      stopCondition: 'Stop after reviewer finds no actionable issues.',
    });

    const updated = updateAutomationRecord(
      created.id,
      {
        name: 'Review loop',
        personaId: 'coder',
        prompt: 'Implement and review the next ready task.',
        repoIds: ['repo-1'],
        scheduleCron: '0 9 * * 1-5',
        timezone: 'Europe/London',
        enabled: true,
        allowRepoWrite: true,
        allowCommandRun: true,
        loopConfig: {
          enabled: false,
          mode: 'dynamic',
          memberPersonaIds: ['coder'],
          separateThreads: true,
          maxIterations: 1,
          stopCondition: '',
        },
      },
      '2026-04-29T08:00:00.000Z',
    );

    expect(updated?.loopConfig).toBeUndefined();
  });

  it('persists run lifecycle, retained worktrees, and events', () => {
    const automation = createAutomationRecord(
      'ws-1',
      {
        name: 'Nightly sweep',
        personaId: 'coder',
        prompt: 'Inspect the repo.',
        repoIds: ['repo-1'],
        scheduleCron: '0 1 * * *',
        timezone: 'UTC',
        enabled: true,
        allowRepoWrite: true,
        allowCommandRun: true,
      },
      '2026-04-30T01:00:00.000Z',
    );

    const run = createAutomationRun(automation, 'manual');
    updateAutomationRunWorktrees(run.id, [
      {
        repoId: 'repo-1',
        repoName: 'orders-service',
        branchName: 'anvil/automation/test',
        path: '/tmp/worktree',
        kept: true,
      },
    ]);
    appendAutomationRunEvent(run.id, 'text', 'Started scanning the repository.');
    appendAutomationRunEvent(run.id, 'command_exec', 'npm test', { exitCode: 0 });

    const completed = completeAutomationRun(run.id, {
      status: 'completed',
      assistantMessage: 'No issues found.',
      changedFileCount: 2,
      worktrees: [
        {
          repoId: 'repo-1',
          repoName: 'orders-service',
          branchName: 'anvil/automation/test',
          path: '/tmp/worktree',
          kept: true,
        },
      ],
    });

    expect(completed?.status).toBe('completed');
    expect(completed?.changedFileCount).toBe(2);
    expect(listAutomationRuns(automation.id)).toHaveLength(1);
    expect(listAutomationRunEvents(run.id)).toHaveLength(2);
    expect(getAutomationRun(run.id)?.assistantMessage).toBe('No issues found.');
    expect(getAutomation(automation.id)?.lastRunStatus).toBe('completed');
  });

  it('keeps Watchtower listeners out of the cron queue and records event context', () => {
    const automation = createAutomationRecord(
      'ws-1',
      {
        name: 'Workflow follow-up',
        personaId: 'coder',
        prompt: 'Review the completed workflow output.',
        repoIds: ['repo-1'],
        triggerMode: 'watchtower',
        watchEvent: 'workflow.completed',
        scheduleCron: '0 9 * * 1-5',
        timezone: 'UTC',
        enabled: true,
        allowRepoWrite: false,
        allowCommandRun: false,
      },
      null,
    );

    expect(listDueAutomations('2099-01-01T00:00:00.000Z')).toEqual([]);
    expect(listWatchtowerAutomations('ws-1', 'workflow.completed')).toEqual([automation]);
    expect(countEnabledAutomations()).toBe(0);

    const event = {
      id: 'workflow-1:completed',
      type: 'workflow.completed' as const,
      workspaceId: 'ws-1',
      repoIds: ['repo-1'],
      sourceId: 'workflow-1',
      sourceLabel: 'Ship feature',
      occurredAt: '2026-08-10T12:00:00.000Z',
    };
    const run = createAutomationRun(automation, 'watchtower', event);

    expect(run.trigger).toBe('watchtower');
    expect(run.triggerContext).toEqual(event);
  });

  it('persists external Watchtower targets and claims each observed transition once', () => {
    const automation = createAutomationRecord(
      'ws-1',
      {
        name: 'Merged PR follow-up',
        personaId: 'coder',
        prompt: 'Review what landed and prepare the next action.',
        repoIds: ['repo-1'],
        triggerMode: 'watchtower',
        watchEvent: 'pull_request.merged',
        watchTarget: { repoId: 'repo-1', pullRequestNumber: 42 },
        scheduleCron: '0 9 * * 1-5',
        timezone: 'UTC',
        enabled: true,
        allowRepoWrite: false,
        allowCommandRun: false,
      },
      null,
    );

    expect(automation.watchTarget).toEqual({ repoId: 'repo-1', pullRequestNumber: 42 });
    expect(listExternalWatchtowerAutomations()).toEqual([automation]);
    expect(countEnabledAutomations()).toBe(1);

    const checked = updateWatchtowerState(automation.id, {
      sourceId: 'github-pr:42',
      sourceLabel: 'PR #42 · Ship it',
      status: 'open',
      observedAt: '2026-08-10T10:00:00.000Z',
    });
    expect(checked?.watchState?.status).toBe('open');

    const event = {
      id: `${automation.id}:pull_request.merged:github-pr:42`,
      type: 'pull_request.merged' as const,
      workspaceId: 'ws-1',
      repoIds: ['repo-1'],
      sourceId: 'github-pr:42',
      sourceLabel: 'PR #42 · Ship it',
      occurredAt: '2026-08-10T10:05:00.000Z',
    };
    const pending = enqueueWatchtowerEvent(automation.id, event);
    enqueueWatchtowerEvent(automation.id, event);

    expect(listPendingWatchtowerEvents()).toHaveLength(1);
    const run = claimPendingWatchtowerEvent(pending.id);
    expect(run).toMatchObject({ trigger: 'watchtower', triggerContext: event });
    expect(claimPendingWatchtowerEvent(pending.id)).toBeNull();
    expect(listPendingWatchtowerEvents()).toEqual([]);
  });

  it('coalesces adjacent streamed text-like events for the same run', () => {
    const automation = createAutomationRecord(
      'ws-1',
      {
        name: 'Token stream check',
        personaId: 'coder',
        prompt: 'Inspect the repo.',
        repoIds: ['repo-1'],
        scheduleCron: '0 1 * * *',
        timezone: 'UTC',
        enabled: true,
        allowRepoWrite: false,
        allowCommandRun: false,
      },
      '2026-04-30T01:00:00.000Z',
    );

    const run = createAutomationRun(automation, 'manual');
    appendAutomationRunEvent(run.id, 'text', 'Hello');
    appendAutomationRunEvent(run.id, 'text', ' world');
    appendAutomationRunEvent(run.id, 'thinking', 'Plan');
    appendAutomationRunEvent(run.id, 'thinking', ' more');
    appendAutomationRunEvent(run.id, 'system', 'Note');
    appendAutomationRunEvent(run.id, 'system', ' here');

    expect(listAutomationRunEvents(run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', content: 'Hello world' }),
        expect.objectContaining({ type: 'thinking', content: 'Plan more' }),
        expect.objectContaining({ type: 'system', content: 'Note here' }),
      ]),
    );
    expect(listAutomationRunEvents(run.id)).toHaveLength(3);
  });
});
