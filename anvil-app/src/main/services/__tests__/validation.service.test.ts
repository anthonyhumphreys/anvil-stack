import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';
import type { ChangeReview } from '../../../shared/change-review-types.js';
import type {
  ValidationCriterion,
  ValidationSurfaceData,
} from '../../../shared/surfaces/kinds/validation.js';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const state = vi.hoisted(() => ({
  mode: 'workspace-auto' as AgentToolSessionContext['mode'],
  criteria: '- Expired links are rejected.',
  approve: vi.fn(async () => true),
  command: vi.fn(async (_input: unknown) => ({
    approvalGranted: true,
    exitCode: 0 as number | null,
    timedOut: false,
    logTail: '1 test passed',
    durationMs: 2,
    repositoryId: 'repo',
    command: 'test',
  })),
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd(), getPath: () => tmpdir() } }));
vi.mock('../codex-session.service.js', () => ({
  broadcastAgentUIIntent: vi.fn(),
  deliverStructuredAgentFeedback: vi.fn(async () => true),
  getCodexSession: vi.fn(() => ({ id: 'session', mode: state.mode })),
  getAgentToolSessionContext: vi.fn(() => ({ mode: state.mode })),
  listActiveCodexSessions: vi.fn(() => []),
}));
vi.mock('../settings.service.js', () => ({
  getSettings: () => ({
    codexMode: state.mode,
    workItemConnections: [{ id: 'connection', provider: 'linear' }],
    activeWorkItemConnectionId: 'connection',
  }),
}));
vi.mock('../workitem-provider.js', () => ({
  getActiveProvider: () => ({
    getItem: async () => {
      if (state.criteria === 'offline') throw new Error('offline');
      return {
        id: 'ANV-42',
        provider: 'linear',
        title: 'Share links',
        acceptanceCriteria: state.criteria,
      };
    },
  }),
}));
vi.mock('../change-review.service.js', () => ({ getChangeReview: vi.fn() }));
vi.mock('../mesh-worktree.service.js', () => ({ runVerificationCommand: state.command }));
vi.mock('../../surfaces/core.js', async (original) => ({
  ...(await original<typeof import('../../surfaces/core.js')>()),
  requestUserApproval: state.approve,
}));

import { getSurface } from '../../surfaces/core.js';
import {
  cancelValidation,
  cleanupValidations,
  createValidationContext,
  finishThreadValidations,
  listValidationHistory,
  publishValidation,
  recordValidation,
  refreshValidation,
  startValidation,
} from '../validation.service.js';

const root = mkdtempSync(join(tmpdir(), 'anvil-validation-'));
let repo: string;
let counter = 0;
const ctx: AgentToolSessionContext = {
  sessionId: 'session',
  appThreadId: 'thread',
  workspaceId: 'workspace',
  repoIds: ['repo'],
  provider: 'codex',
  mode: 'workspace-auto',
  features: ['codereview'],
};
const ref = { connectionId: 'connection', provider: 'linear' as const, id: 'ANV-42' };
const checks: ValidationCriterion[] = [
  {
    id: 'expired',
    text: 'Expired links are rejected.',
    method: 'command',
    instruction: 'Run the link validation tests.',
    command: 'node --version',
  },
  {
    id: 'keyboard',
    text: 'The link can be opened with the keyboard.',
    method: 'browser',
    instruction: 'Open the link with keyboard input and inspect the result.',
  },
];
function git(path: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
}
async function plan(criteria = checks) {
  const context = await createValidationContext(ctx, { repoId: 'repo', workItemRef: ref });
  return publishValidation(ctx, {
    contextId: context.contextId,
    title: 'Validate share links',
    criteria,
  });
}
function data(id: string) {
  return getSurface(id)!.payload.data as ValidationSurfaceData;
}
async function settled(id: string) {
  await vi.waitFor(() =>
    expect(data(id).criteria.some((criterion) => criterion.result?.status === 'running')).toBe(
      false,
    ),
  );
  // The last freshness check and cleanup run after result persistence.
  await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
  vi.clearAllMocks();
  cleanupValidations();
  db.exec(
    'DELETE FROM agent_ui_intent_events; DELETE FROM agent_ui_intents; DELETE FROM chat_messages; DELETE FROM workflow_runs; DELETE FROM chat_threads; DELETE FROM workspace_repos; DELETE FROM workspaces; DELETE FROM repos;',
  );
  repo = join(root, `repo-${++counter}`);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base');
  db.prepare(
    "INSERT INTO repos (id, name, path, status, created_at, updated_at) VALUES ('repo', 'Links', ?, 'connected', datetime('now'), datetime('now'))",
  ).run(repo);
  db.prepare(
    "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('workspace', 'Work', datetime('now'), datetime('now'))",
  ).run();
  db.prepare(
    "INSERT INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread', 'workspace', 'coder', 'Share links')",
  ).run();
  db.prepare(
    "INSERT INTO chat_messages (id, thread_id, role, content) VALUES ('request', 'thread', 'user', 'Reject expired links and preserve the draft.')",
  ).run();
  state.mode = 'workspace-auto';
  state.criteria = '- Expired links are rejected.';
  state.approve.mockReset().mockResolvedValue(true);
  state.command.mockReset().mockResolvedValue({
    approvalGranted: true,
    exitCode: 0,
    timedOut: false,
    logTail: '1 test passed',
    durationMs: 2,
    repositoryId: 'repo',
    command: 'test',
  });
});
afterAll(() => {
  cleanupValidations();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('conversational validation', () => {
  it('pins the source and criteria without changing the index or running a command', async () => {
    writeFileSync(join(repo, 'file.txt'), 'working change\n');
    const before = git(repo, 'status', '--porcelain');
    const context = await createValidationContext(ctx, { repoId: 'repo', workItemRef: ref });
    expect(context.request).toContain('preserve the draft');
    expect(context.data.source).toMatchObject({
      kind: 'work-item',
      text: state.criteria,
      workItemRef: ref,
    });
    const intent = publishValidation(ctx, {
      contextId: context.contextId,
      title: 'Links',
      criteria: checks,
    });
    expect(data(intent.id).criteria.every((criterion) => !criterion.result)).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    expect(state.command).not.toHaveBeenCalled();
  });
  it('uses the prompt when no work item is linked and scopes contexts to their session', async () => {
    const context = await createValidationContext(ctx, { repoId: 'repo' });
    expect(context.data.source).toMatchObject({
      kind: 'prompt',
      text: expect.stringContaining('Reject expired links'),
    });
    expect(() =>
      publishValidation(
        { ...ctx, sessionId: 'other' },
        { contextId: context.contextId, title: 'x', criteria: checks },
      ),
    ).toThrow(/validation_context/);
    await expect(createValidationContext(ctx, { repoId: 'outside' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('rejects a source changed during planning and fabricated initial results', async () => {
    const context = await createValidationContext(ctx, { repoId: 'repo' });
    writeFileSync(join(repo, 'file.txt'), 'changed\n');
    expect(() =>
      publishValidation(ctx, { contextId: context.contextId, title: 'x', criteria: checks }),
    ).toThrow(/Source changed/);
    const next = await createValidationContext(ctx, { repoId: 'repo' });
    expect(() =>
      publishValidation(ctx, {
        contextId: next.contextId,
        title: 'x',
        criteria: [
          {
            ...checks[0]!,
            result: {
              status: 'passed',
              summary: 'claimed',
              evidence: 'claimed',
              provenance: 'runner-observed',
              recordedAt: new Date().toISOString(),
            },
          },
        ],
      }),
    ).toThrow(/start unchecked/);
  });
  it('executes saved checks under existing access and records receipts separately from browser observations', async () => {
    const intent = await plan();
    await startValidation(ctx, intent.id);
    await settled(intent.id);
    expect(state.approve).not.toHaveBeenCalled();
    expect(state.command).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: repo,
        command: 'node --version',
        permissionMode: 'workspace-auto',
      }),
    );
    expect(data(intent.id).criteria[0]!.result).toMatchObject({
      status: 'passed',
      provenance: 'runner-observed',
      evidence: expect.stringContaining('1 test passed'),
    });
    expect(data(intent.id).criteria[1]!.result).toBeUndefined();
  });
  it('requires on-request approval and respects denial and read-only access', async () => {
    const intent = await plan();
    state.mode = 'on-request';
    state.approve.mockResolvedValue(false);
    await expect(startValidation({ ...ctx, mode: 'on-request' }, intent.id)).rejects.toThrow(
      /not approved/,
    );
    expect(state.command).not.toHaveBeenCalled();
    state.mode = 'read-only';
    await expect(startValidation(ctx, intent.id)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects an outdated criteria version before executing commands', async () => {
    const intent = await plan();
    await expect(startValidation(ctx, intent.id, undefined, 'old-version')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(state.command).not.toHaveBeenCalled();
    await startValidation(ctx, intent.id, undefined, data(intent.id).criteriaVersion);
    await settled(intent.id);
    expect(state.command).toHaveBeenCalledOnce();
  });
  it('rejects a historical review outside the current workspace before reading it', async () => {
    const { getChangeReview } = await import('../change-review.service.js');
    await expect(
      createValidationContext(ctx, { repoId: 'repo', reviewId: 'outside' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(getChangeReview).not.toHaveBeenCalled();
  });
  it('keeps saved evidence accessible when its work-item provider is offline', async () => {
    const { getChangeReview } = await import('../change-review.service.js');
    vi.mocked(getChangeReview).mockReturnValue({
      id: 'saved',
      workspaceId: 'workspace',
      repoId: 'repo',
      workItemRef: ref,
      criteria: [{ sourceText: 'Archived expectation' }],
      runs: [],
    } as unknown as ChangeReview);
    db.prepare(
      "INSERT INTO change_reviews VALUES ('saved', 'workspace', 'repo', '{}', datetime('now'))",
    ).run();
    state.criteria = 'offline';
    const context = await createValidationContext(ctx, { repoId: 'repo', reviewId: 'saved' });
    expect(context.data).toMatchObject({
      source: { text: 'Archived expectation', workItemRef: ref },
      freshness: 'unknown',
      legacyReviewId: 'saved',
    });
    const intent = publishValidation(ctx, {
      contextId: context.contextId,
      title: 'Saved evidence',
      criteria: checks,
    });
    await expect(startValidation(ctx, intent.id)).rejects.toMatchObject({ code: 'conflict' });
    expect(state.command).not.toHaveBeenCalled();
    db.prepare("DELETE FROM change_reviews WHERE id = 'saved'").run();
  });
  it('rejects overlapping starts while approval is pending', async () => {
    const intent = await plan();
    state.mode = 'on-request';
    let approve!: (answer: boolean) => void;
    state.approve.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const first = startValidation({ ...ctx, mode: 'on-request' }, intent.id);
    await vi.waitFor(() => expect(state.approve).toHaveBeenCalled());
    await expect(startValidation({ ...ctx, mode: 'on-request' }, intent.id)).rejects.toThrow(
      /already running/,
    );
    approve(false);
    await expect(first).rejects.toThrow(/not approved/);
  });
  it('invalidates results when a check changes source or acceptance criteria change', async () => {
    const intent = await plan();
    state.command.mockImplementation(async () => {
      writeFileSync(join(repo, 'file.txt'), 'modified by test\n');
      return {
        approvalGranted: true,
        exitCode: 0,
        timedOut: false,
        logTail: 'test changed source',
        durationMs: 1,
        repositoryId: 'repo',
        command: 'test',
      };
    });
    await startValidation(ctx, intent.id);
    await settled(intent.id);
    expect(data(intent.id).freshness).toBe('stale');
    await expect(startValidation(ctx, intent.id)).rejects.toMatchObject({ code: 'conflict' });
    state.criteria = '- Different expectation';
    expect((await refreshValidation(intent.id)).payload.data).toMatchObject({
      freshness: 'stale',
      freshnessDetail: expect.stringContaining('criteria changed'),
    });
  });
  it('records browser observations honestly and rejects command claims, empty evidence and stale revisions', async () => {
    const intent = await plan();
    const input = {
      surfaceId: intent.id,
      baseRevision: intent.revision,
      criterionId: 'keyboard',
      status: 'passed' as const,
      summary: 'Opened with Enter',
      evidence: 'Browser tool observed the document after keyboard activation.',
    };
    await expect(recordValidation(ctx, { ...input, criterionId: 'expired' })).rejects.toThrow(
      /Command results/,
    );
    await expect(recordValidation(ctx, { ...input, evidence: '' })).rejects.toThrow(
      /Attach observed/,
    );
    const recorded = await recordValidation(ctx, input);
    expect(data(intent.id).criteria[1]!.result).toMatchObject({
      status: 'passed',
      provenance: 'agent-reported',
    });
    await expect(recordValidation(ctx, input)).rejects.toMatchObject({ code: 'conflict' });
    const context = await createValidationContext(ctx, { repoId: 'repo', workItemRef: ref });
    const revised = publishValidation(ctx, {
      contextId: context.contextId,
      title: 'Refined',
      criteria: [{ ...checks[1]!, text: 'Keyboard activation preserves focus.' }],
      surfaceId: intent.id,
      baseRevision: recorded.revision,
    });
    expect((revised.payload.data as ValidationSurfaceData).criteria[0]!.result).toBeUndefined();
  });
  it('stops cancelled checks and does not execute later commands', async () => {
    const intent = await plan([checks[0]!, { ...checks[0]!, id: 'second' }]);
    let complete!: (result: Awaited<ReturnType<typeof state.command>>) => void;
    state.command.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await startValidation(ctx, intent.id);
    await vi.waitFor(() => expect(state.command).toHaveBeenCalledTimes(1));
    cancelValidation(intent.id);
    complete({
      approvalGranted: true,
      exitCode: null,
      timedOut: false,
      logTail: '',
      durationMs: 1,
      repositoryId: 'repo',
      command: 'test',
    });
    await settled(intent.id);
    expect(
      data(intent.id).criteria.every((criterion) => criterion.result?.status === 'blocked'),
    ).toBe(true);
    expect(state.command).toHaveBeenCalledTimes(1);
  });
  it('retains workflow checkout identity and rejects conflicting work-item scope', async () => {
    const checkout = join(root, `workflow-${counter}`);
    git(repo, 'worktree', 'add', '--detach', checkout, 'HEAD');
    writeFileSync(join(checkout, 'file.txt'), 'workflow candidate\n');
    db.prepare(
      "INSERT INTO workflow_runs (id, template_id, template_name, workspace_id, repo_ids_json, graph_json, kickoff, status, supervisor_thread_id, node_runs_json, created_at) VALUES ('run', 'template', 'Validate', 'workspace', '[\"repo\"]', ?, 'Validate', 'running', 'thread', '[{\"threadId\":\"thread\"}]', datetime('now'))",
    ).run(JSON.stringify({ executionPaths: [{ id: 'repo', path: checkout }], workItemRef: ref }));
    const intent = await plan();
    expect(data(intent.id).workflowRunId).toBe('run');
    await startValidation(ctx, intent.id);
    await settled(intent.id);
    expect(state.command).toHaveBeenCalledWith(expect.objectContaining({ cwd: checkout }));
    await expect(
      createValidationContext(ctx, { repoId: 'repo', workItemRef: { ...ref, id: 'other' } }),
    ).rejects.toThrow(/must match/);
  });
  it('waits for running workflow checks and reports unchecked criteria as incomplete', async () => {
    const intent = await plan();
    let complete!: (result: Awaited<ReturnType<typeof state.command>>) => void;
    state.command.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await startValidation(ctx, intent.id);
    await vi.waitFor(() => expect(state.command).toHaveBeenCalled());
    let finished = false;
    const result = finishThreadValidations('thread', new AbortController().signal).then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    complete({
      approvalGranted: true,
      exitCode: 0,
      timedOut: false,
      logTail: 'done',
      durationMs: 1,
      repositoryId: 'repo',
      command: 'test',
    });
    expect(await result).toMatchObject({
      complete: false,
      summary: expect.stringContaining('[unchecked]'),
    });
  });
  it('lists evidence only for the selected workspace and work-item connection', async () => {
    const intent = await plan();
    expect(listValidationHistory('workspace', ref)).toMatchObject([
      { surfaceId: intent.id, threadId: 'thread' },
    ]);
    expect(listValidationHistory('other', ref)).toEqual([]);
    expect(listValidationHistory('workspace', { ...ref, connectionId: 'other' })).toEqual([]);
  });
  it('does not complete an explicit validation workflow without evidence', async () => {
    expect(
      await finishThreadValidations('thread', new AbortController().signal, true),
    ).toMatchObject({ complete: false });
    expect(await finishThreadValidations('thread', new AbortController().signal)).toBeNull();
  });
});
