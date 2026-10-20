import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn),
  },
}));

import { listActivationEvents, trackActivationEvent } from '../metrics.service.js';
import { registerMetricsHandlers } from '../../ipc/metrics.ipc.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM activation_events');
  state.handlers.clear();
});

describe('trackActivationEvent', () => {
  it('inserts a row with a serialised payload', () => {
    trackActivationEvent('onboarding_started');
    trackActivationEvent('onboarding_step_completed', { step: 'role' });

    const rows = listActivationEvents();
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe('onboarding_started');
    expect(rows[0].payload).toBeNull();
    expect(rows[1].event).toBe('onboarding_step_completed');
    expect(JSON.parse(rows[1].payload!)).toEqual({ step: 'role' });
    expect(rows[1].created_at).toBeTruthy();
    expect(rows[0].app_run_id).toBe(rows[1].app_run_id);
    expect(rows[0].journey_id).toBe(rows[1].journey_id);
  });

  it('keeps legacy diff counts but drops arbitrary content from local rows', () => {
    trackActivationEvent('diff_proposed', { files: 3, diff: 'secret patch'.repeat(10_000) });

    const rows = listActivationEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('diff_proposed');
    expect(JSON.parse(rows[0].payload!)).toEqual({ files: 3 });
    expect(rows[0].app_run_id).toBeTruthy();
    expect(rows[0].journey_id).toBeNull();
  });

  it('stores an opaque stable summary key and deduplicates repeat views across app runs', () => {
    const summary = {
      threadId: 'private-thread-id',
      turnId: 'private-turn-id',
      files: 3,
      additions: 12,
      deletions: 4,
      diff: 'private patch content',
    };
    trackActivationEvent('change_summary_viewed', summary);

    const firstRow = listActivationEvents()[0];
    const savedPayload = JSON.parse(firstRow.payload!);
    expect(firstRow.event).toBe('change_summary_viewed');
    expect(savedPayload).toMatchObject({ files: 3, additions: 12, deletions: 4 });
    expect(savedPayload.summaryKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(savedPayload)).not.toContain('private-thread-id');
    expect(JSON.stringify(savedPayload)).not.toContain('private-turn-id');
    expect(JSON.stringify(savedPayload)).not.toContain('private patch content');

    inMemoryDb
      .prepare('UPDATE activation_events SET app_run_id = ?, journey_id = ? WHERE id = ?')
      .run('previous-run', 'previous-journey', firstRow.id);
    trackActivationEvent('change_summary_viewed', { ...summary, files: 8 });
    trackActivationEvent('change_summary_viewed', { ...summary, turnId: 'another-turn-id' });

    const rows = listActivationEvents();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1].payload!).summaryKey).not.toBe(savedPayload.summaryKey);
  });

  it('never throws to the caller when the write fails', () => {
    const spy = vi.spyOn(inMemoryDb, 'prepare').mockImplementationOnce(() => {
      throw new Error('db gone');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => trackActivationEvent('onboarding_started')).not.toThrow();
    expect(warn).toHaveBeenCalled();
    spy.mockRestore();
    warn.mockRestore();
  });

  it('does not turn overlay or ChatView remounts into duplicate funnel events', () => {
    trackActivationEvent('onboarding_started');
    trackActivationEvent('onboarding_started');
    trackActivationEvent('chat_composer_enabled');
    trackActivationEvent('chat_composer_enabled');

    const rows = listActivationEvents();
    expect(rows.map((row) => row.event)).toEqual(['onboarding_started', 'chat_composer_enabled']);
    expect(rows[0].journey_id).toBe(rows[1].journey_id);
  });
});

describe('listActivationEvents', () => {
  it('filters by since timestamp', () => {
    trackActivationEvent('onboarding_started');
    const future = '2999-01-01T00:00:00.000Z';
    const past = '2000-01-01T00:00:00.000Z';

    expect(listActivationEvents(future)).toHaveLength(0);
    expect(listActivationEvents(past)).toHaveLength(1);
  });

  it('keeps one journey across app runs until a change is applied', () => {
    inMemoryDb
      .prepare(
        `INSERT INTO activation_events (event, app_run_id, journey_id, created_at)
         VALUES ('onboarding_started', 'old-run', 'journey-1', '2026-10-18T10:00:00.000Z')`,
      )
      .run();

    trackActivationEvent('chat_composer_enabled', { workspaceId: 'private-workspace-id' });
    const rows = listActivationEvents();
    expect(rows[1].journey_id).toBe('journey-1');
    expect(rows[1].app_run_id).not.toBe('old-run');
    expect(rows[1].payload).toBeNull();

    trackActivationEvent('change_applied', { fileCount: 2 });
    expect(listActivationEvents()[2].journey_id).toBe('journey-1');

    trackActivationEvent('onboarding_started');
    expect(listActivationEvents()[3].journey_id).not.toBe('journey-1');
  });

  it('attaches a confirmed PR to its kept change without attributing later PRs to an old journey', () => {
    trackActivationEvent('onboarding_started');
    trackActivationEvent('change_applied', { fileCount: 1 });
    trackActivationEvent('pull_request_opened');

    const rows = listActivationEvents();
    expect(rows[2].journey_id).toBe(rows[0].journey_id);

    trackActivationEvent('change_applied', { fileCount: 2 });
    trackActivationEvent('pull_request_opened');

    const laterRows = listActivationEvents();
    expect(laterRows[4].journey_id).toBeNull();
  });
});

describe('metrics:track IPC allowlist', () => {
  it('accepts funnel events and rejects unknown names', () => {
    registerMetricsHandlers();
    const handler = state.handlers.get('metrics:track')!;

    const rejected = handler({}, 'window_crash_horribly', {}) as { ok: boolean };
    expect(rejected.ok).toBe(false);
    expect(listActivationEvents()).toHaveLength(0);

    const accepted = handler({}, 'chat_composer_enabled', { workspaceId: 'ws-1' }) as {
      ok: boolean;
    };
    expect(accepted.ok).toBe(true);

    const rows = listActivationEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('chat_composer_enabled');
    expect(rows[0].payload).toBeNull();
    expect(rows[0].app_run_id).toBeTruthy();
  });

  it('ignores non-object payloads', () => {
    registerMetricsHandlers();
    const handler = state.handlers.get('metrics:track')!;

    const result = handler({}, 'onboarding_started', 'not-an-object') as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(listActivationEvents()[0].payload).toBeNull();
  });
});
