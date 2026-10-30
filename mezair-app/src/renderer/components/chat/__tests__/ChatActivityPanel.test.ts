import { describe, expect, it } from 'vitest';
import { getActivitySectionForKey, getAttentionSummarySinceLastLook } from '../ChatActivityPanel';

describe('activity tab keyboard navigation', () => {
  it('moves between current activity and run history with arrow keys', () => {
    expect(getActivitySectionForKey('current', 'ArrowRight')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowRight')).toBe('current');
    expect(getActivitySectionForKey('current', 'ArrowLeft')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowLeft')).toBe('current');
    expect(getActivitySectionForKey('current', 'ArrowDown')).toBe('history');
    expect(getActivitySectionForKey('history', 'ArrowUp')).toBe('current');
  });

  it('supports Home and End and ignores unrelated keys', () => {
    expect(getActivitySectionForKey('history', 'Home')).toBe('current');
    expect(getActivitySectionForKey('current', 'End')).toBe('history');
    expect(getActivitySectionForKey('current', 'Enter')).toBeNull();
  });
});

describe('since-last-look activity summary', () => {
  it('reports persisted status changes newer than the saved view marker', () => {
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: '2026-09-24T10:00:00.000Z',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'complete',
      }),
    ).toBe('The latest run completed since your last look.');
  });

  it('stays quiet when timestamps are equal, older, missing, or invalid', () => {
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: '2026-09-24T10:05:00.000Z',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'complete',
      }),
    ).toBeNull();
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: '2026-09-24T10:10:00.000Z',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'failed',
      }),
    ).toBeNull();
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: null,
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'input',
      }),
    ).toBeNull();
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: 'invalid',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'input',
      }),
    ).toBeNull();
  });

  it('uses the persisted attention state to describe the change', () => {
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: '2026-09-24T10:00:00.000Z',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'approval',
      }),
    ).toBe('Approval requested since your last look.');
    expect(
      getAttentionSummarySinceLastLook({
        lastViewedAt: '2026-09-24T10:00:00.000Z',
        attentionUpdatedAt: '2026-09-24T10:05:00.000Z',
        attentionState: 'input',
      }),
    ).toBe('The agent asked for input since your last look.');
  });
});
