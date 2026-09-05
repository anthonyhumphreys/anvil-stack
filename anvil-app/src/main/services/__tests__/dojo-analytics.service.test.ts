import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL, MIGRATIONS } from '../../db/schema.js';
import type { CodexEvent } from '../../../shared/types.js';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../settings.service.js', () => ({
  getSettings: () => ({
    llmProvider: 'codex',
    enabledLlmProviders: ['codex', 'cursor', 'openai', 'azure'],
  }),
}));
vi.mock('../llm.service.js', () => ({ callLlm: vi.fn() }));
import {
  recordDojoExecutionEvent,
  getDojoAnalytics,
  saveDojoPrice,
  priceDojoUsage,
  setDojoRecommendationState,
  setDojoDelivery,
} from '../dojo-analytics.service.js';
const now = new Date('2026-09-05T12:00:00Z');
beforeEach(() => {
  db.exec(`DELETE FROM dojo_execution_events;DELETE FROM dojo_recommendation_states;DELETE FROM dojo_reports;DELETE FROM dojo_configs;DELETE FROM dojo_deliveries;DELETE FROM dojo_prices;DELETE FROM chat_messages;DELETE FROM chat_sessions;DELETE FROM chat_threads;DELETE FROM workspaces;
 INSERT INTO workspaces (id,name,created_at,updated_at) VALUES ('ws','Workspace','2026-01-01','2026-01-01'),('other','Other','2026-01-01','2026-01-01');`);
});
function session(id: string, provider: string, workspace = 'ws', start = '2026-09-04T10:00:00Z') {
  db.prepare(
    `INSERT INTO chat_threads(id,workspace_id,title,persona_id,repo_ids_json,created_at,updated_at,work_item_provider,work_item_id) VALUES (?,?,?,'coder','[]',?,?,'github','42')`,
  ).run(id, workspace, id, start, start);
  db.prepare(
    `INSERT INTO chat_sessions(id,thread_id,provider,persona_id,started_at,ended_at) VALUES (?,?,?,'coder',?,'2026-09-04T10:10:00Z')`,
  ).run(id, id, provider, start);
}
function event(session: string, id: string, event: CodexEvent, timestamp = '2026-09-04T10:09:00Z') {
  db.prepare(
    `INSERT INTO chat_messages(id,thread_id,session_id,kind,role,content,event_json,timestamp) VALUES (?,?,?,'event','system','',?,?)`,
  ).run(id, session, session, JSON.stringify(event), timestamp);
}

describe('Dojo analytics', () => {
  it('applies the new migration to an existing schema', () => {
    const legacy = new Database(':memory:');
    legacy.exec(
      'CREATE TABLE workspaces(id TEXT PRIMARY KEY);CREATE TABLE dojo_reports(id TEXT PRIMARY KEY);CREATE TABLE chat_sessions(id TEXT PRIMARY KEY);',
    );
    expect(() => legacy.exec(MIGRATIONS[61])).not.toThrow();
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'dojo_%'").all(),
    ).toHaveLength(5);
    legacy.close();
  });
  it.each(['codex', 'cursor', 'openai', 'azure'])(
    'uses the same outcome and usage accounting for %s',
    (provider) => {
      session('s', provider);
      recordDojoExecutionEvent(
        's',
        { type: 'turn_outcome', turnOutcome: 'interrupted' },
        '2026-09-04T10:09:00Z',
      );
      const usage = {
        type: 'usage' as const,
        usageId: 'one-observation',
        model: 'model-x',
        usage: { input: 100, cachedInput: 50, output: 20 },
      };
      event('s', 'u1', usage);
      event('s', 'u2', usage);
      const a = getDojoAnalytics('ws', 30, now);
      expect(a.current.interrupted).toBe(1);
      expect(a.current.tokens).toBe(120);
      expect(a.current.cost).toBeNull();
      expect(a.runs[0].provider).toBe(provider);
    },
  );
  it('isolates workspaces, keeps closed unknown outcomes unknown, and excludes previous-period runs', () => {
    session('current', 'cursor');
    session('secret', 'codex', 'other');
    session('prior', 'azure', 'ws', '2026-07-20T10:00:00Z');
    const a = getDojoAnalytics('ws', 30, now);
    expect(a.runs.map((r) => r.id)).toEqual(['current']);
    expect(a.current.unknown).toBe(1);
    expect(a.current.completed).toBe(0);
    expect(a.previous.runs).toBe(1);
  });
  it('prices cached input once and preserves historical rate snapshots', () => {
    session('s', 'openai');
    const [price] = saveDojoPrice({
      provider: 'openai',
      model: 'model-x',
      input: 10,
      cachedInput: 1,
      output: 20,
    });
    const usage = { input: 1_000_000, cachedInput: 500_000, output: 100_000 };
    expect(priceDojoUsage(usage, price)).toBe(7.5);
    event('s', 'usage', { type: 'usage', usageId: 'priced', usage, usagePrice: price });
    saveDojoPrice({ ...price, input: 100 });
    expect(getDojoAnalytics('ws', 30, now).current.cost).toBe(7.5);
    expect(() => saveDojoPrice({ ...price, input: NaN })).toThrow();
  });
  it('counts retries after failed commands and tool failures without counting streamed updates twice', () => {
    session('s', 'cursor');
    event('s', 'tool1', {
      type: 'tool_call',
      itemId: 'one',
      toolName: 'Test',
      toolStatus: 'running',
    });
    event('s', 'tool2', {
      type: 'tool_call',
      itemId: 'one',
      toolName: 'Test',
      toolStatus: 'failed',
    });
    event('s', 'cmd1', { type: 'command_exec', command: 'pnpm test', exitCode: 1 });
    event('s', 'cmd2', { type: 'command_exec', command: 'pnpm test', exitCode: 0 });
    event('s', 'cmd3', { type: 'command_exec', command: 'pnpm test', exitCode: 0 });
    const r = getDojoAnalytics('ws', 30, now).runs[0];
    expect(r.tools).toBe(4);
    expect(r.failures).toHaveLength(2);
    expect(r.retries).toBe(1);
  });
  it('keeps context size separate from consumed tokens and accepts reported cost deltas', () => {
    session('s', 'cursor');
    event('s', 'ctx', {
      type: 'usage_context',
      contextUsage: { used: 500, size: 1000 },
      observedCostUsd: 0.25,
    });
    const r = getDojoAnalytics('ws', 30, now).runs[0];
    expect(r.contextPercent).toBe(50);
    expect(r.usage).toBeNull();
    expect(r.cost).toBe(0.25);
  });
  it('records recommendation state only for real recommendations in the right workspace', () => {
    db.prepare(
      `INSERT INTO dojo_reports(id,workspace_id,status,trigger,window_start,window_end,metrics_json,analysis_json,started_at) VALUES ('r','ws','completed','manual','2026-08-01','2026-09-01','{}',?,'2026-09-01')`,
    ).run(
      JSON.stringify({
        promptRecommendations: [
          { title: 'Scope', prompt: 'Hold scope', reason: 'Repeated', evidenceCount: 2 },
        ],
      }),
    );
    expect(() => setDojoRecommendationState('other', 'r', 'prompt:0', 'applied')).toThrow();
    expect(() => setDojoRecommendationState('ws', 'r', 'prompt:9', 'applied')).toThrow();
    const applied = setDojoRecommendationState('ws', 'r', 'prompt:0', 'applied');
    expect(applied.appliedAt).not.toBeNull();
    expect(setDojoRecommendationState('ws', 'r', 'prompt:0', 'applied').appliedAt).toBe(
      applied.appliedAt,
    );
    expect(setDojoRecommendationState('ws', 'r', 'prompt:0', 'dismissed').appliedAt).toBeNull();
  });
  it('allows explicit delivery marking only for linked work items in the workspace', () => {
    session('s', 'azure');
    expect(() => setDojoDelivery('other', 'github:42', true)).toThrow();
    setDojoDelivery('ws', 'github:42', true);
    expect(getDojoAnalytics('ws', 30, now).deliveries).toHaveLength(1);
    setDojoDelivery('ws', 'github:42', false);
    expect(getDojoAnalytics('ws', 30, now).deliveries).toHaveLength(0);
  });
});
