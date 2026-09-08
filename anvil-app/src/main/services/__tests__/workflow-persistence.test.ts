import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowRun } from '../../../shared/types';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../automation.service.js', () => ({ triggerWatchtowerEvent: vi.fn() }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('../chat-persistence.service.js', () => ({
  createChatThread: () => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO chat_threads (id, workspace_id, persona_id, title, repo_ids_json, created_at, updated_at) VALUES (?, 'ws', 'coder', 'Test', '[]', datetime('now'), datetime('now'))",
    ).run(id);
    return { id };
  },
  saveChatEntry: vi.fn(),
  createChatSession: vi.fn(),
  setChatThreadProviderThreadId: vi.fn(),
}));
import {
  cancelWorkflowRun,
  decideWorkflowNode,
  getWorkflowRun,
  getWorkflowTemplate,
  recoverInterruptedWorkflowRuns,
  resumeWorkflowRun,
  retryWorkflowNode,
  saveWorkflowTemplate,
  startWorkflowRun,
  waitForWorkflowRun,
} from '../workflow.service';

beforeEach(() => {
  db.exec(
    "DELETE FROM workflow_runs; DELETE FROM workflow_templates; DELETE FROM chat_threads; DELETE FROM workspaces; INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Test', datetime('now'), datetime('now'));",
  );
});
function template() {
  return saveWorkflowTemplate({
    name: 'Human gate',
    orchestration: { ...DEFAULT_ORCHESTRATION, maxConcurrency: 3 },
    nodes: [
      {
        id: 'gate',
        name: 'Accept',
        prompt: 'Inspect the handoff',
        kind: 'human',
        personaId: 'coder',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        executionStrategy: 'focused',
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  });
}
async function pausedRun() {
  const saved = template();
  const started = startWorkflowRun({
    templateId: saved.id,
    workspaceId: 'ws',
    repoIds: [],
    kickoff: 'Test',
  });
  return waitForWorkflowRun(started.id);
}
function store(run: WorkflowRun) {
  db.prepare(
    'UPDATE workflow_runs SET graph_json = ?, node_runs_json = ?, status = ? WHERE id = ?',
  ).run(JSON.stringify(run), JSON.stringify(run.nodeRuns), run.status, run.id);
}

describe('workflow persistence and commands', () => {
  it('round trips configuration and durable human decisions', async () => {
    const paused = await pausedRun();
    expect(paused.status).toBe('paused');
    expect(paused.orchestration?.maxConcurrency).toBe(3);
    expect(getWorkflowTemplate(paused.templateId)?.orchestration?.maxConcurrency).toBe(3);
    decideWorkflowNode(paused.id, 'gate', true, 'Inspected the candidate');
    expect(getWorkflowRun(paused.id)?.nodeRuns[0].decision?.note).toBe('Inspected the candidate');
    resumeWorkflowRun(paused.id);
    const completed = await waitForWorkflowRun(paused.id);
    expect(completed.status).toBe('completed');
    expect(completed.events?.some((event) => event.type === 'decision')).toBe(true);
    expect(() => decideWorkflowNode(paused.id, 'gate', true, 'duplicate')).toThrow('not waiting');
  });
  it('keeps rejected decisions and fails the resumed run', async () => {
    const paused = await pausedRun();
    decideWorkflowNode(paused.id, 'gate', false, 'Missing evidence');
    resumeWorkflowRun(paused.id);
    expect((await waitForWorkflowRun(paused.id)).status).toBe('failed');
    expect(getWorkflowRun(paused.id)?.nodeRuns[0].decision?.approved).toBe(false);
  });
  it('cancels a queued run before its scheduler starts', async () => {
    const saved = template();
    const started = startWorkflowRun({
      templateId: saved.id,
      workspaceId: 'ws',
      repoIds: [],
      kickoff: 'Test',
    });
    cancelWorkflowRun(started.id);
    expect((await waitForWorkflowRun(started.id)).status).toBe('cancelled');
  });
  it('recovers uncertain attempts without replay and requires explicit retry', async () => {
    const current = await pausedRun();
    current.status = 'running';
    current.runtimeOwnerPid = undefined;
    current.nodes[0].kind = 'agent';
    current.nodeRuns[0].status = 'running';
    current.nodeRuns[0].attempts = [
      {
        id: 'attempt',
        status: 'running',
        startedAt: current.createdAt,
        provider: 'codex',
        model: 'model',
        reasoningEffort: 'high',
      },
    ];
    store(current);
    recoverInterruptedWorkflowRuns();
    const recovered = getWorkflowRun(current.id)!;
    expect(recovered.status).toBe('paused');
    expect(recovered.nodeRuns[0].status).toBe('interrupted');
    expect(recovered.nodeRuns[0].attempts?.[0].status).toBe('interrupted');
    expect(() => resumeWorkflowRun(current.id)).toThrow('Inspect interrupted');
    retryWorkflowNode(current.id, 'gate');
    expect(getWorkflowRun(current.id)?.nodeRuns[0].status).toBe('queued');
    expect(getWorkflowRun(current.id)?.nodeRuns[0].attempts).toHaveLength(1);
  });
  it('does not reclaim a run from a live owner', async () => {
    const current = await pausedRun();
    current.status = 'running';
    current.runtimeOwnerPid = process.pid;
    store(current);
    recoverInterruptedWorkflowRuns();
    expect(getWorkflowRun(current.id)?.status).toBe('running');
  });
  it('does not reset an expired deadline on resume', async () => {
    const current = await pausedRun();
    current.deadlineAt = '2000-01-01T00:00:00.000Z';
    current.nodeRuns[0].status = 'completed';
    store(current);
    expect(() => resumeWorkflowRun(current.id)).toThrow('wall-clock budget');
  });
  it('upgrades an existing automation schema without changing its records', () => {
    const legacy = new Database(':memory:');
    legacy.exec(
      "CREATE TABLE automation_definitions (id TEXT PRIMARY KEY, name TEXT); INSERT INTO automation_definitions VALUES ('existing', 'Daily');",
    );
    legacy.exec(MIGRATIONS[64]);
    expect(legacy.prepare('SELECT * FROM automation_definitions').get()).toEqual({
      id: 'existing',
      name: 'Daily',
      workflow_template_id: null,
    });
    legacy.close();
  });
});
