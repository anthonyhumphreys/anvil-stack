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
  completeAutomationRun,
  createAutomationRecord,
  createAutomationRun,
  getAutomation,
  getAutomationRun,
  listAutomationRunEvents,
  listAutomationRuns,
  listAutomations,
  updateAutomationRecord,
  updateAutomationRunWorktrees,
} from '../automation-persistence.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM automation_run_events');
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
