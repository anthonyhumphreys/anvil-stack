import Database from 'better-sqlite3';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
import {
  captureThreadContinuation,
  prependThreadContinuation,
} from '../chat-continuation.service.js';
import {
  upsertAgentUIIntent,
  recordAgentUIQuestionResolution,
} from '../agent-ui-intent.service.js';
import type { AgentUIQuestionIntent } from '../../../shared/agent-ui-intents.js';

beforeEach(() => {
  db.exec(
    'DELETE FROM workflow_runs; DELETE FROM agent_ui_intent_responses; DELETE FROM agent_ui_intent_events; DELETE FROM agent_ui_intents; DELETE FROM chat_messages; DELETE FROM chat_artifacts; DELETE FROM chat_threads;',
  );
  db.prepare(
    'INSERT INTO chat_threads(id,persona_id,title,active_plan_json,active_goal_json) VALUES(?,?,?,?,?)',
  ).run(
    'thread',
    'coder',
    'Thread',
    '{"steps":[{"step":"Keep context","status":"pending"}]}',
    '{"objective":"Ship"}',
  );
});
afterAll(() => db.close());
function message(id: string, role: string, content: string, kind = role) {
  db.prepare(
    'INSERT INTO chat_messages(id,thread_id,role,kind,content,timestamp) VALUES(?,?,?,?,?,?)',
  ).run(id, 'thread', role, kind, content, `2026-10-18T10:00:${id.padStart(2, '0')}.000Z`);
}
describe('portable chat context', () => {
  it('preserves delegation identities across provider changes and bounds their metadata', () => {
    db.prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'Test', datetime('now'), datetime('now')) ON CONFLICT DO NOTHING",
    ).run();
    db.prepare(
      "INSERT INTO workflow_runs (id, template_id, template_name, workspace_id, repo_ids_json, graph_json, kickoff, status, supervisor_thread_id, node_runs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).run(
      'delegated-run',
      'chat:adhoc',
      'Independent review',
      'ws',
      '[]',
      JSON.stringify({ chatOrigin: { threadId: 'thread' } }),
      'Review',
      'running',
      'thread',
      '[]',
    );
    const state = captureThreadContinuation('thread').context;
    expect(state).toContain('delegated-run');
    expect(state).toContain('Independent review');
    expect(state).toContain('running');
    db.prepare('UPDATE workflow_runs SET template_name = ?').run('x'.repeat(100000));
    expect(captureThreadContinuation('thread').context.length).toBeLessThan(32000);
  });
  it('retains final assistant text events and excludes activity noise', () => {
    message('01', 'user', 'Use a compact layout');
    message('02', 'assistant', 'Compact chosen', 'event');
    for (let i = 0; i < 100; i++) message(`event-${i}`, 'system', 'Raw tool output', 'event');
    const context = captureThreadContinuation('thread');
    expect(context.messages.map((m) => m.content)).toEqual([
      'Use a compact layout',
      'Compact chosen',
    ]);
    expect(context.context).not.toContain('Raw tool output');
    expect(context.context).toContain('Keep context');
    expect(context.context).toContain('Ship');
  });
  it('carries saved question answers without private answers or approval authority', () => {
    const now = new Date().toISOString();
    const q: AgentUIQuestionIntent = {
      protocolVersion: 1,
      id: 'q',
      kind: 'question',
      revision: 1,
      scope: { threadId: 'thread' },
      lifecycle: 'pending',
      presentation: { collapsed: false, hidden: false },
      createdAt: now,
      updatedAt: now,
      payload: {
        questions: [
          { id: 'choice', kind: 'yes_no', question: 'Preview?', required: true, allowCancel: true },
          {
            id: 'secret',
            kind: 'free_text',
            question: 'Private',
            required: true,
            allowCancel: true,
            sensitive: true,
          },
        ],
      },
    };
    upsertAgentUIIntent({ intent: q });
    recordAgentUIQuestionResolution(q, {
      intentId: q.id,
      action: 'submit',
      answers: { choice: false, secret: 'never-copy-me' },
      answeredAt: now,
    });
    const result = captureThreadContinuation('thread');
    expect(result.context).toContain('Preview?');
    expect(result.context).toContain('false');
    expect(result.context).not.toContain('never-copy-me');
    expect(result.context).toContain('Earlier approvals do not grant permission');
  });
  it('bounds long histories and labels the newest request separately', () => {
    for (let i = 0; i < 40; i++) message(String(i), 'user', `message-${i} ` + 'x'.repeat(10000));
    const result = captureThreadContinuation('thread');
    expect(result.context.length).toBeLessThan(32000);
    expect(result.context).toContain('message-39');
    expect(captureThreadContinuation('thread', 20).messages).toHaveLength(20);
    expect(prependThreadContinuation(result.context, 'Continue')).toMatch(
      /Newest user request:\nContinue$/,
    );
    expect(captureThreadContinuation('missing').context).toBe('');
  });
  it('keeps both plan and goal readable when state is large, without broken JSON', () => {
    db.prepare(
      'UPDATE chat_threads SET summary = ?, active_plan_json = ?, active_goal_json = ? WHERE id = ?',
    ).run(
      's'.repeat(30000),
      JSON.stringify({ plan: 'p'.repeat(20000) }),
      JSON.stringify({ goal: 'g'.repeat(20000) }),
      'thread',
    );
    const result = captureThreadContinuation('thread');
    const state = JSON.parse(
      result.context.match(/<conversation_state>\n([\s\S]*?)\n<\/conversation_state>/)![1],
    );
    expect(state.planAndGoal.plan).toContain('plan');
    expect(state.planAndGoal.goal).toContain('goal');
    expect(JSON.parse(result.planGoalState!)).toHaveProperty('goal');
    expect(result.context.length).toBeLessThan(32000);
  });
});
