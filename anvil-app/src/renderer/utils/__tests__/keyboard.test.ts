import { describe, expect, it } from 'vitest';
import { isEditableShortcutTarget, isShellShortcutOptInTarget } from '../keyboard';

const target = (options: {
  editable?: boolean;
  closestEditable?: boolean;
  shellShortcutOptIn?: boolean;
}): EventTarget =>
  ({
    isContentEditable: options.editable ?? false,
    closest: (selector: string) => {
      if (selector === '[data-shell-shortcuts]') {
        return options.shellShortcutOptIn ? {} : null;
      }
      return options.closestEditable ? {} : null;
    },
  }) as unknown as EventTarget;

describe('isEditableShortcutTarget', () => {
  it('detects editable targets and ancestors', () => {
    expect(isEditableShortcutTarget(target({ editable: true }))).toBe(true);
    expect(isEditableShortcutTarget(target({ closestEditable: true }))).toBe(true);
  });

  it('allows ordinary targets and non-elements', () => {
    expect(isEditableShortcutTarget(target({}))).toBe(false);
    expect(isEditableShortcutTarget({} as EventTarget)).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);
  });
});

describe('isShellShortcutOptInTarget', () => {
  it('detects targets that explicitly opt in to shell shortcuts', () => {
    expect(isShellShortcutOptInTarget(target({ shellShortcutOptIn: true }))).toBe(true);
  });

  it('ignores ordinary targets and non-elements', () => {
    expect(isShellShortcutOptInTarget(target({}))).toBe(false);
    expect(isShellShortcutOptInTarget({} as EventTarget)).toBe(false);
    expect(isShellShortcutOptInTarget(null)).toBe(false);
  });
});
