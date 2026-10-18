import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { WorkflowTargetPolicy } from '../../../shared/types.js';

const mocks = vi.hoisted(() => ({ provision: vi.fn(), dispatch: vi.fn(), cancel: vi.fn() }));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const directory = mkdtempSync(path.join(os.tmpdir(), 'anvil-delegation-cancel-'));
execFileSync('git', ['init', '--quiet', directory]);
execFileSync(
  'git',
  [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'fixture',
  ],
  { cwd: directory },
);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../notification.service.js', () => ({ notifyWorkflowDecision: vi.fn() }));
vi.mock('../automation.service.js', () => ({ triggerWatchtowerEvent: vi.fn() }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: () => ({ id: 'coder' }),
  buildSystemPrompt: () => '',
}));
vi.mock('../mesh-dispatch.service.js', () => ({
  getWorkflowDispatch: () => null,
  requestWorkflowEnvironment: mocks.provision,
  dispatchWorkflowNode: mocks.dispatch,
  cancelNodeDispatch: mocks.cancel,
}));
vi.mock('../chat-persistence.service.js', () => ({
  createChatThread: () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO chat_threads (id, workspace_id, persona_id, title) VALUES (?, 'ws', 'coder', 'Test')",
    ).run(id);
    return { id };
  },
  saveChatEntry: vi.fn(),
  createChatSession: vi.fn(),
  setChatThreadProviderThreadId: vi.fn(),
}));
import {
  cancelWorkflowRun,
  saveWorkflowTemplate,
  startWorkflowRun,
  waitForWorkflowRun,
} from '../workflow.service.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.cancel.mockResolvedValue({ state: 'cancelled' });
  db.exec(
    "DELETE FROM workflow_runs; DELETE FROM workflow_templates; DELETE FROM chat_threads; DELETE FROM workspace_repo_definitions; DELETE FROM workspaces; DELETE FROM repos; INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Test', datetime('now'), datetime('now'));",
  );
  db.prepare("INSERT INTO repos (id, name, path) VALUES ('repo', 'Test', ?)").run(directory);
  db.exec(
    "INSERT INTO workspace_repo_definitions (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at) VALUES ('ws', 'portable', 'Test', 'repo', datetime('now'), datetime('now'))",
  );
});
afterAll(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function start(target: WorkflowTargetPolicy) {
  const template = saveWorkflowTemplate({
    name: 'Cancellation check',
    nodes: [
      {
        id: 'task',
        name: 'Task',
        prompt: 'Inspect only',
        personaId: 'coder',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'medium',
        executionStrategy: 'focused',
        permissionMode: 'read-only',
        target,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  });
  return startWorkflowRun({
    templateId: template.id,
    workspaceId: 'ws',
    repoIds: ['repo'],
    kickoff: 'Inspect only',
  });
}
describe('remote delegation cancellation races', () => {
  it('does not submit a job when stopped while its environment is being prepared', async () => {
    let prepared!: () => void;
    mocks.provision.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          prepared = resolve;
        }),
    );
    const run = start({
      kind: 'provisioned-environment',
      provider: 'aws-lambda-microvm',
      connectionId: 'aws',
      ttlSeconds: 1800,
    });
    await vi.waitFor(() => expect(mocks.provision).toHaveBeenCalledOnce());
    cancelWorkflowRun(run.id);
    prepared();
    expect((await waitForWorkflowRun(run.id)).status).toBe('cancelled');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it('cancels a job accepted after the coordinator already requested stop', async () => {
    let accepted!: (dispatch: unknown) => void;
    mocks.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          accepted = resolve;
        }),
    );
    const run = start({ kind: 'device', enrollmentId: 'worker' });
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    const dispatchId = mocks.dispatch.mock.calls[0][0].dispatchId;
    cancelWorkflowRun(run.id);
    accepted({ state: 'running', jobId: 'job', output: null });
    expect((await waitForWorkflowRun(run.id)).status).toBe('cancelled');
    expect(mocks.cancel).toHaveBeenCalledWith(dispatchId);
  });
});
