import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../../../../shared/types';
import {
  canSettleThread,
  getThreadActionVisibilityClass,
  getThreadDisplayState,
  partitionThreads,
  shouldSelectThreadFromKey,
} from '../ChatThreadRail';

const keyTarget = (closestEditable: boolean, editable = false): EventTarget =>
  ({
    isContentEditable: editable,
    closest: () => (closestEditable ? {} : null),
  }) as unknown as EventTarget;

describe('shouldSelectThreadFromKey', () => {
  it('selects a thread from Enter or Space on the thread row', () => {
    expect(shouldSelectThreadFromKey({ key: 'Enter', target: keyTarget(false) })).toBe(true);
    expect(shouldSelectThreadFromKey({ key: ' ', target: keyTarget(false) })).toBe(true);
  });

  it('ignores unrelated keys and editable targets', () => {
    expect(shouldSelectThreadFromKey({ key: 'ArrowDown', target: keyTarget(false) })).toBe(false);
    expect(shouldSelectThreadFromKey({ key: 'Enter', target: keyTarget(true) })).toBe(false);
    expect(shouldSelectThreadFromKey({ key: ' ', target: keyTarget(false, true) })).toBe(false);
  });
});

describe('getThreadActionVisibilityClass', () => {
  it('reveals thread actions for both pointer hover and keyboard focus', () => {
    const className = getThreadActionVisibilityClass();

    expect(className).toContain('group-hover:opacity-100');
    expect(className).toContain('group-focus-within:opacity-100');
  });
});

const makeThread = (overrides: Partial<ChatThread> = {}): ChatThread => ({
  id: 'thread-1',
  personaId: 'coder',
  title: 'Ship the inbox',
  repoIds: [],
  createdAt: '2026-07-24T10:00:00.000Z',
  updatedAt: '2026-07-24T10:00:00.000Z',
  messageCount: 1,
  attentionState: 'idle',
  ...overrides,
});

describe('work inbox lifecycle', () => {
  it('keeps active work separate from the compact settled tail', () => {
    const active = makeThread();
    const settled = makeThread({
      id: 'thread-2',
      settledAt: '2026-07-24T11:00:00.000Z',
    });

    expect(partitionThreads([active, settled])).toEqual({
      activeThreads: [active],
      settledThreads: [settled],
    });
  });

  it('prioritises Codex approval and input states over generic live status', () => {
    expect(getThreadDisplayState(makeThread({ attentionState: 'approval' }), 'busy', false)).toBe(
      'approval',
    );
    expect(getThreadDisplayState(makeThread({ attentionState: 'input' }), 'busy', false)).toBe(
      'input',
    );
    expect(canSettleThread(makeThread({ attentionState: 'approval' }), 'ready')).toBe(false);
    expect(canSettleThread(makeThread({ attentionState: 'complete' }), 'ready')).toBe(true);
  });

  it('only highlights a completion until the thread has been viewed', () => {
    const completed = makeThread({
      attentionState: 'complete',
      attentionUpdatedAt: '2026-07-24T11:00:00.000Z',
    });
    expect(getThreadDisplayState(completed, 'ready', false)).toBe('complete');
    expect(
      getThreadDisplayState(
        { ...completed, lastViewedAt: '2026-07-24T11:01:00.000Z' },
        'ready',
        false,
      ),
    ).toBe('idle');
  });
});
