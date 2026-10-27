import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeReview } from '../../../shared/change-review-types.js';
const records = vi.hoisted(() => new Map<string, string>());
vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (id: string) => (records.has(id) ? { record_json: records.get(id) } : undefined),
      run: (json: string, id: string) => records.set(id, json),
    }),
  }),
}));
import {
  mergePersistedReviewAttention,
  recordReviewAttention,
} from '../change-review-attention.service.js';
function setup(id: string) {
  records.set(id, JSON.stringify({ id, updatedAt: 'unchanged', findings: [] }));
  return {
    pulse: (active = true, sessionId = 'session') =>
      recordReviewAttention(id, { sessionId, active }),
    read: () => JSON.parse(records.get(id)!) as ChangeReview,
  };
}
afterEach(() => vi.useRealTimers());
describe('persisted review attention', () => {
  it('counts adjacent observations and persists identity without updating evidence timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { pulse, read } = setup('adjacent');
    pulse();
    vi.advanceTimersByTime(5000);
    pulse();
    expect(read().attentionSessions![0]).toMatchObject({
      activeMs: 5000,
      provenance: 'foreground-interaction',
      startedAt: new Date(100000).toISOString(),
      lastObservedAt: new Date(105000).toISOString(),
    });
    expect(read().attentionSessions![0].reviewer).toBeTruthy();
    expect(read().updatedAt).toBe('unchanged');
  });
  it('excludes pause, sleep, clock reversal and session changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { pulse, read } = setup('gaps');
    pulse();
    vi.advanceTimersByTime(5000);
    pulse(false);
    vi.advanceTimersByTime(5000);
    pulse();
    vi.advanceTimersByTime(20000);
    pulse();
    vi.setSystemTime(100000);
    pulse();
    vi.advanceTimersByTime(5000);
    pulse(true, 'other-session');
    expect(read().attentionSessions!.map((s) => s.activeMs)).toEqual([0, 0]);
  });
  it('does not let a previous panel stop the current session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
    const { pulse, read } = setup('panels');
    pulse();
    pulse(true, 'new');
    pulse(false);
    vi.advanceTimersByTime(5000);
    pulse(true, 'new');
    expect(read().attentionSessions![1].activeMs).toBe(5000);
  });
  it('merges attention into a stale review without overwriting the pending review edits', () => {
    const { pulse, read } = setup('merge');
    const stale = read();
    stale.title = 'Pending title';
    pulse();
    mergePersistedReviewAttention(stale);
    expect(stale.title).toBe('Pending title');
    expect(stale.attentionSessions).toHaveLength(1);
  });
  it('rejects missing reviews and malformed observations', () => {
    expect(() => recordReviewAttention('missing', { sessionId: 'session', active: true })).toThrow(
      'Review not found',
    );
    expect(() => recordReviewAttention('missing', { sessionId: '', active: true })).toThrow(
      'Invalid',
    );
  });
});
