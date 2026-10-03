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
  });

  it('drops payloads over the size cap but still records the event', () => {
    trackActivationEvent('diff_proposed', { diff: 'x'.repeat(10_000) });

    const rows = listActivationEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('diff_proposed');
    expect(rows[0].payload).toBeNull();
  });

  it('keeps payloads just under the cap', () => {
    trackActivationEvent('diff_proposed', { diff: 'x'.repeat(4_000) });

    const rows = listActivationEvents();
    expect(rows[0].payload).not.toBeNull();
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
});

describe('listActivationEvents', () => {
  it('filters by since timestamp', () => {
    trackActivationEvent('onboarding_started');
    const future = '2999-01-01T00:00:00.000Z';
    const past = '2000-01-01T00:00:00.000Z';

    expect(listActivationEvents(future)).toHaveLength(0);
    expect(listActivationEvents(past)).toHaveLength(1);
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
    expect(JSON.parse(rows[0].payload!)).toEqual({ workspaceId: 'ws-1' });
  });

  it('ignores non-object payloads', () => {
    registerMetricsHandlers();
    const handler = state.handlers.get('metrics:track')!;

    const result = handler({}, 'onboarding_started', 'not-an-object') as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(listActivationEvents()[0].payload).toBeNull();
  });
});
