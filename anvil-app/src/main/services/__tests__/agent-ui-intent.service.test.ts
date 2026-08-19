import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentUIPlanIntent, AgentUIQuestionIntent } from '../../../shared/agent-ui-intents.js';
import { SCHEMA_SQL } from '../../db/schema.js';

const database = new Database(':memory:');
database.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => database }));

import {
  AgentUIIntentConflictError,
  dismissAgentUIIntent,
  expireAgentUIIntentForRequest,
  restoreAgentUIIntent,
  listAgentUIIntents,
  patchAgentUIPlan,
  recordAgentUIQuestionResolution,
  updateAgentUIIntentPresentation,
  upsertAgentUIIntent,
  validateAgentUIIntent,
  validateAgentUIQuestionResolution,
} from '../agent-ui-intent.service.js';

beforeEach(() => {
  database.exec('DELETE FROM agent_ui_intent_responses');
  database.exec('DELETE FROM agent_ui_intent_events');
  database.exec('DELETE FROM agent_ui_intents');
  database.exec('DELETE FROM chat_threads');
  database.exec('DELETE FROM workspaces');
  database
    .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('workspace-1', 'Workspace', '2026-08-19T10:00:00.000Z', '2026-08-19T10:00:00.000Z');
  database
    .prepare(
      `INSERT INTO chat_threads
       (id, workspace_id, persona_id, title, repo_ids_json, created_at, updated_at)
       VALUES (?, ?, 'coder', 'Agent UI', '[]', ?, ?)`,
    )
    .run('thread-1', 'workspace-1', '2026-08-19T10:00:00.000Z', '2026-08-19T10:00:00.000Z');
});

function makePlan(): AgentUIPlanIntent {
  return {
    protocolVersion: 1,
    id: 'plan:thread-1',
    kind: 'plan',
    revision: 1,
    scope: { workspaceId: 'workspace-1', threadId: 'thread-1' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      planId: 'plan:thread-1',
      title: 'Implementation plan',
      description: 'Ship the intent protocol.',
      lifecycle: 'active',
      phases: [{ id: 'phase-build', title: 'Build' }],
      steps: [
        { id: 'step-1', phaseId: 'phase-build', title: 'Add protocol', status: 'in_progress' },
        {
          id: 'step-2',
          phaseId: 'phase-build',
          title: 'Add UI',
          status: 'todo',
          dependsOn: ['step-1'],
        },
      ],
    },
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
  };
}

function makeQuestion(): AgentUIQuestionIntent {
  return {
    protocolVersion: 1,
    id: 'question-1',
    kind: 'question',
    revision: 1,
    scope: { workspaceId: 'workspace-1', threadId: 'thread-1' },
    lifecycle: 'pending',
    presentation: { collapsed: false, hidden: false },
    payload: {
      title: 'Choose settings',
      questions: [
        {
          id: 'single',
          kind: 'single_choice',
          question: 'Which target?',
          required: true,
          allowCancel: false,
          options: [
            { id: 'preview', label: 'Preview', value: 'preview', recommended: true },
            { id: 'production', label: 'Production', value: 'production' },
          ],
        },
        {
          id: 'multi',
          kind: 'multiple_choice',
          question: 'Which checks?',
          required: true,
          allowCancel: false,
          options: [
            { id: 'test', label: 'Tests', value: 'test' },
            { id: 'lint', label: 'Lint', value: 'lint' },
          ],
        },
        { id: 'note', kind: 'free_text', question: 'Notes?', required: false, allowCancel: true },
        {
          id: 'approve',
          kind: 'approval',
          question: 'Proceed?',
          required: true,
          allowCancel: false,
        },
        {
          id: 'secret',
          kind: 'free_text',
          question: 'Token?',
          required: true,
          allowCancel: false,
          sensitive: true,
        },
      ],
    },
    createdAt: '2026-08-19T10:00:00.000Z',
    updatedAt: '2026-08-19T10:00:00.000Z',
  };
}

describe('Agent UI intent service', () => {
  it('creates, lists, and incrementally updates plans while maintaining compatibility state', () => {
    const created = upsertAgentUIIntent({ intent: makePlan(), binding: { provider: 'codex' } });
    expect(listAgentUIIntents('thread-1')).toEqual([created]);

    const updated = patchAgentUIPlan(created.id, {
      planId: created.payload.planId,
      baseRevision: created.revision,
      operationId: 'patch-1',
      actor: 'user',
      operations: [
        { type: 'set_plan_metadata', title: 'Edited plan', description: 'User-owned wording.' },
        { type: 'set_step_status', stepId: 'step-1', status: 'done' },
        {
          type: 'update_step',
          stepId: 'step-2',
          changes: { title: 'Build native UI', owner: 'Codex' },
        },
      ],
    });

    expect(updated.revision).toBe(2);
    expect(updated.payload).toMatchObject({
      title: 'Edited plan',
      description: 'User-owned wording.',
      steps: [
        { id: 'step-1', status: 'done' },
        { id: 'step-2', title: 'Build native UI', owner: 'Codex' },
      ],
    });
    const thread = database
      .prepare('SELECT active_plan_json FROM chat_threads WHERE id = ?')
      .get('thread-1') as { active_plan_json: string };
    expect(JSON.parse(thread.active_plan_json)).toMatchObject({
      explanation: 'User-owned wording.',
      steps: [{ status: 'completed' }, { step: 'Build native UI', status: 'pending' }],
    });
  });

  it('rejects stale plan patches with the current revision', () => {
    upsertAgentUIIntent({ intent: makePlan() });
    expect(() =>
      patchAgentUIPlan('plan:thread-1', {
        planId: 'plan:thread-1',
        baseRevision: 0,
        operationId: 'stale',
        actor: 'user',
        operations: [{ type: 'set_step_status', stepId: 'step-1', status: 'done' }],
      }),
    ).toThrow(AgentUIIntentConflictError);
  });

  it('collapses completed plans and lets users hide, restore, and archive them', () => {
    upsertAgentUIIntent({ intent: makePlan() });
    const mostlyDone = patchAgentUIPlan('plan:thread-1', {
      planId: 'plan:thread-1',
      baseRevision: 1,
      operationId: 'complete-1',
      actor: 'user',
      operations: [{ type: 'set_step_status', stepId: 'step-1', status: 'done' }],
    });
    const completed = patchAgentUIPlan('plan:thread-1', {
      planId: 'plan:thread-1',
      baseRevision: mostlyDone.revision,
      operationId: 'complete-2',
      actor: 'user',
      operations: [{ type: 'set_step_status', stepId: 'step-2', status: 'done' }],
    });
    expect(completed.payload.lifecycle).toBe('completed');
    expect(completed.presentation.collapsed).toBe(true);

    const hidden = updateAgentUIIntentPresentation(completed.id, { hidden: true });
    expect(hidden.presentation.hidden).toBe(true);
    const restored = updateAgentUIIntentPresentation(completed.id, {
      hidden: false,
      collapsed: false,
    });
    expect(restored.presentation).toEqual({ hidden: false, collapsed: false });

    const archived = dismissAgentUIIntent(completed.id);
    expect(archived).toMatchObject({
      lifecycle: 'dismissed',
      presentation: { hidden: true },
      payload: { lifecycle: 'archived' },
    });
    expect(listAgentUIIntents('thread-1')).toEqual([]);
    expect(listAgentUIIntents('thread-1', { includeInactive: true })).toHaveLength(1);
    const unarchived = restoreAgentUIIntent(completed.id);
    expect(unarchived).toMatchObject({
      lifecycle: 'presented',
      presentation: { hidden: false, collapsed: false },
      payload: { lifecycle: 'completed' },
    });
  });

  it('validates and records all initial question answer kinds without persisting secrets', () => {
    const question = makeQuestion();
    upsertAgentUIIntent({ intent: question, binding: { provider: 'codex' } });
    const resolution = {
      intentId: question.id,
      action: 'submit' as const,
      answers: {
        single: 'preview',
        multi: ['test', 'lint'],
        note: 'Keep it focused.',
        approve: true,
        secret: 'never-store-this',
      },
      answeredAt: '2026-08-19T10:01:00.000Z',
    };
    expect(() => validateAgentUIQuestionResolution(question, resolution)).not.toThrow();
    const resolved = recordAgentUIQuestionResolution(question, resolution);
    expect(resolved.lifecycle).toBe('resolved');

    const row = database
      .prepare('SELECT response_json FROM agent_ui_intent_responses WHERE intent_id = ?')
      .get(question.id) as { response_json: string };
    expect(row.response_json).not.toContain('never-store-this');
    expect(JSON.parse(row.response_json).answers.secret).toBe('[redacted]');
  });

  it('expires a pending question when its provider request is withdrawn', () => {
    const question = makeQuestion();
    upsertAgentUIIntent({
      intent: question,
      binding: {
        provider: 'codex',
        sessionId: 'session-1',
        requestId: 'request-1',
        responseKind: 'user_input',
      },
    });

    expect(expireAgentUIIntentForRequest('session-1', 'request-1')).toMatchObject({
      id: question.id,
      lifecycle: 'expired',
    });
    expect(expireAgentUIIntentForRequest('session-1', 'request-1')).toBeNull();
  });

  it('rejects invalid payloads and unsupported answers at the trust boundary', () => {
    expect(validateAgentUIIntent({ kind: 'diff' })).toMatchObject({ ok: false });
    upsertAgentUIIntent({ intent: makePlan() });
    expect(() =>
      patchAgentUIPlan('plan:thread-1', {
        planId: 'plan:thread-1',
        baseRevision: 1,
        operationId: 'invalid-status',
        actor: 'user',
        operations: [{ type: 'set_step_status', stepId: 'step-1', status: 'invalid' as 'todo' }],
      }),
    ).toThrow('invalid step status');
    const question = makeQuestion();
    expect(() =>
      validateAgentUIQuestionResolution(question, {
        intentId: question.id,
        action: 'submit',
        answers: {
          single: 'unknown',
          multi: ['test'],
          approve: 'yes',
          secret: 'provided',
        },
        answeredAt: '2026-08-19T10:01:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      validateAgentUIQuestionResolution(question, {
        intentId: question.id,
        action: 'submit',
        answers: {},
        answeredAt: 'not-a-date',
      }),
    ).toThrow('answeredAt');
  });

  it('migrates an existing thread plan lazily so stuck plans gain lifecycle controls', () => {
    database.prepare('UPDATE chat_threads SET active_plan_json = ? WHERE id = ?').run(
      JSON.stringify({
        explanation: 'Legacy plan',
        steps: [{ step: 'Already done', status: 'completed' }],
        updatedAt: '2026-08-19T09:00:00.000Z',
      }),
      'thread-1',
    );

    const [intent] = listAgentUIIntents('thread-1', { includeInactive: true });
    expect(intent).toMatchObject({
      id: 'plan:thread-1',
      kind: 'plan',
      presentation: { collapsed: true, hidden: false },
      payload: { lifecycle: 'completed', steps: [{ status: 'done' }] },
    });
  });
});
