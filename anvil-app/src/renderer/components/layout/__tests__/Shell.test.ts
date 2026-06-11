import { describe, expect, it } from 'vitest';
import { shouldIgnoreShellShortcut } from '../Shell';

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

describe('shouldIgnoreShellShortcut', () => {
  it('ignores shell shortcuts from editable controls', () => {
    expect(shouldIgnoreShellShortcut(target({ closestEditable: true }))).toBe(true);
  });

  it('ignores shell shortcuts from nested content inside editable controls', () => {
    expect(shouldIgnoreShellShortcut(target({ closestEditable: true }))).toBe(true);
  });

  it('ignores contenteditable regions', () => {
    expect(shouldIgnoreShellShortcut(target({ editable: true }))).toBe(true);
  });

  it('allows explicit shell shortcut opt-in inside editable controls', () => {
    expect(
      shouldIgnoreShellShortcut(target({ closestEditable: true, shellShortcutOptIn: true })),
    ).toBe(false);
  });

  it('keeps shortcuts active for ordinary elements and non-elements', () => {
    expect(shouldIgnoreShellShortcut(target({ closestEditable: false }))).toBe(false);
    expect(shouldIgnoreShellShortcut({} as EventTarget)).toBe(false);
    expect(shouldIgnoreShellShortcut(null)).toBe(false);
  });
});
