import { describe, expect, it } from 'vitest';
import { getThreadActionVisibilityClass, shouldSelectThreadFromKey } from '../ChatThreadRail';

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
