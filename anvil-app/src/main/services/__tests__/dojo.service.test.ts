import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => ({
    llmProvider: 'codex',
    enabledLlmProviders: ['codex', 'cursor'],
  }),
}));

const { callLlm } = vi.hoisted(() => ({ callLlm: vi.fn() }));
vi.mock('../llm.service.js', () => ({ callLlm }));

import {
  buildDojoMetrics,
  classifyDojoMessage,
  getDojoConfig,
  getDojoReport,
  listDojoReports,
  processDueDojoReviews,
  runDojoReview,
  updateDojoConfig,
  type DojoMessageRow,
} from '../dojo.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM dojo_reports');
  inMemoryDb.exec('DELETE FROM dojo_configs');
  inMemoryDb.exec('DELETE FROM chat_messages');
  inMemoryDb.exec('DELETE FROM chat_sessions');
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM workspace_preferences');
  inMemoryDb.exec('DELETE FROM workspace_repos');
  inMemoryDb.exec('DELETE FROM workspaces');
  inMemoryDb.exec('DELETE FROM repos');
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES ('ws-1', 'Workspace', datetime('now'), datetime('now'))`,
    )
    .run();
  callLlm.mockReset();
});

describe('Dojo signal classification', () => {
  it('counts frustration, profanity, and corrections independently', () => {
    expect(
      classifyDojoMessage('Seriously, this is fucking wrong. I asked you not to do that.'),
    ).toEqual({ frustration: true, profanity: true, correction: true });
    expect(classifyDojoMessage('Please add a focused test.')).toEqual({
      frustration: false,
      profanity: false,
      correction: false,
    });
  });

  it('builds provider coverage and approximate token totals', () => {
    const messages: DojoMessageRow[] = [
      {
        id: 'one',
        threadId: 'thread-1',
        sessionId: 'session-1',
        role: 'user',
        content: 'No, do not change that.',
        timestamp: '2026-09-01T10:00:00.000Z',
        provider: 'codex',
      },
      {
        id: 'two',
        threadId: 'thread-1',
        sessionId: 'session-1',
        role: 'assistant',
        content: 'Understood.',
        timestamp: '2026-09-01T10:00:01.000Z',
        provider: 'codex',
      },
    ];

    const metrics = buildDojoMetrics(messages, ['codex', 'cursor']);

    expect(metrics.correctionCount).toBe(1);
    expect(metrics.estimatedInputTokens).toBe(Math.ceil(messages[0].content.length / 4));
    expect(metrics.providers).toEqual([
      expect.objectContaining({ provider: 'codex', status: 'covered', sessionCount: 1 }),
      expect.objectContaining({ provider: 'cursor', status: 'no-activity', sessionCount: 0 }),
    ]);
  });
});

describe('Dojo scheduling and reports', () => {
  it('starts disabled and validates review settings', () => {
    const config = getDojoConfig('ws-1');
    expect(config.enabled).toBe(false);
    expect(config.lookbackDays).toBe(30);
    expect(() => runDojoReview('ws-1')).toThrow(/Enable Dojo/i);

    const updated = updateDojoConfig('ws-1', {
      enabled: true,
      lookbackDays: 14,
      scheduleCron: '0 9 * * 5',
      timezone: 'UTC',
    });
    expect(updated.enabled).toBe(true);
    expect(updated.nextRunAt).toBeTruthy();
    expect(() =>
      updateDojoConfig('ws-1', {
        enabled: true,
        lookbackDays: 0,
        scheduleCron: '0 9 * * 5',
        timezone: 'UTC',
      }),
    ).toThrow(/between 1 and 365 days/i);
  });

  it('claims due scheduled reviews through the automation scheduler', async () => {
    updateDojoConfig('ws-1', {
      enabled: true,
      lookbackDays: 30,
      scheduleCron: '0 9 * * 1',
      timezone: 'UTC',
    });
    inMemoryDb.prepare("UPDATE dojo_configs SET next_run_at = '2026-09-01T09:00:00.000Z'").run();

    processDueDojoReviews('2026-09-01T09:01:00.000Z');

    await vi.waitFor(() => expect(listDojoReports('ws-1')).toHaveLength(1));
    expect(listDojoReports('ws-1')[0]).toMatchObject({
      trigger: 'schedule',
      status: 'completed',
    });
    expect(getDojoConfig('ws-1').nextRunAt).not.toBe('2026-09-01T09:00:00.000Z');
  });

  it('completes an empty review without calling the model', async () => {
    updateDojoConfig('ws-1', {
      enabled: true,
      lookbackDays: 30,
      scheduleCron: '0 9 * * 1',
      timezone: 'UTC',
    });
    const started = runDojoReview('ws-1');
    expect(['running', 'completed']).toContain(started.status);

    await vi.waitFor(() => {
      expect(getDojoReport(started.id)?.status).toBe('completed');
    });
    expect(getDojoReport(started.id)?.summary).toMatch(/No agent conversations/i);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('keeps only catalog skills and supplies their trusted source URL', async () => {
    updateDojoConfig('ws-1', {
      enabled: true,
      lookbackDays: 30,
      scheduleCron: '0 9 * * 1',
      timezone: 'UTC',
    });
    inMemoryDb
      .prepare(
        `INSERT INTO chat_threads (
           id, workspace_id, persona_id, title, repo_ids_json, created_at, updated_at
         ) VALUES ('thread-1', 'ws-1', 'coder', 'Do the work', '[]', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    inMemoryDb
      .prepare(
        `INSERT INTO chat_sessions (
           id, thread_id, persona_id, provider, started_at
         ) VALUES ('session-1', 'thread-1', 'coder', 'codex', ?)`,
      )
      .run(new Date().toISOString());
    inMemoryDb
      .prepare(
        `INSERT INTO chat_messages (
           id, thread_id, session_id, kind, role, content, timestamp
         ) VALUES ('message-1', 'thread-1', 'session-1', 'user', 'user', ?, ?)`,
      )
      .run('I asked you not to change the API again.', new Date().toISOString());
    callLlm.mockResolvedValueOnce(
      JSON.stringify({
        summary: 'You repeatedly correct scope drift.',
        observations: [],
        promptRecommendations: [
          {
            title: 'One-off request',
            prompt: 'Do the one-off thing.',
            reason: 'Only happened once.',
            evidenceCount: 1,
          },
          {
            title: 'Hold the API boundary',
            prompt: 'Do not change existing API contracts unless I explicitly ask.',
            reason: 'The same scope correction appeared twice.',
            evidenceCount: 2,
          },
        ],
        skillRecommendations: [
          {
            library: 'pstack',
            skill: 'invented-skill',
            reason: 'This is not in the reviewed catalog.',
          },
          {
            library: 'pstack',
            skill: 'automate-me',
            reason: 'Encode repeated scope corrections.',
            url: 'https://attacker.invalid',
          },
        ],
      }),
    );

    const started = runDojoReview('ws-1');
    await vi.waitFor(() => expect(getDojoReport(started.id)?.status).toBe('completed'));

    expect(getDojoReport(started.id)?.skillRecommendations).toEqual([
      {
        rank: 1,
        library: 'pstack',
        skill: 'automate-me',
        reason: 'Encode repeated scope corrections.',
        url: 'https://github.com/poteto/plugins/tree/main/pstack/skills/automate-me',
      },
    ]);
    expect(getDojoReport(started.id)?.promptRecommendations).toEqual([
      {
        title: 'Hold the API boundary',
        prompt: 'Do not change existing API contracts unless I explicitly ask.',
        reason: 'The same scope correction appeared twice.',
        evidenceCount: 2,
      },
    ]);
  });
});
