import { describe, expect, it } from 'vitest';
import { getToolWindowTitle, shouldIgnoreShellShortcut } from '../Shell';

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

describe('getToolWindowTitle', () => {
  it('uses the matching nav destination for the detached-window title', () => {
    expect(getToolWindowTitle('/browser')).toBe('Browser');
    expect(getToolWindowTitle('/chat', '?toolWindow=1')).toBe('Chat');
    expect(getToolWindowTitle('/notes', '?tab=meeting')).toBe('Notes');
    expect(getToolWindowTitle('/settings/providers')).toBe('Settings');
  });

  it('titles workspace views by their tab, not the route segment', () => {
    expect(getToolWindowTitle('/workspace', '?view=library&kind=adr&toolWindow=1')).toBe('Library');
    expect(getToolWindowTitle('/workspace', '?view=repositories')).toBe('Repositories');
    expect(getToolWindowTitle('/workspace', '?repo=r1')).toBe('Repositories');
    expect(getToolWindowTitle('/workspace')).toBe('Workspace overview');
    expect(getToolWindowTitle('/overview')).toBe('Home');
    expect(getToolWindowTitle('/workspace/repos/r1/health/security')).toBe('Health');
    expect(getToolWindowTitle('/workspace/repos/r1/setup')).toBe('Setup');
  });

  it('follows removed routes to their new home', () => {
    expect(getToolWindowTitle('/meeting-notes')).toBe('Notes');
    expect(getToolWindowTitle('/security/repo-1')).toBe('Health');
    expect(getToolWindowTitle('/adrs')).toBe('Library');
  });

  it('falls back to the first path segment', () => {
    expect(getToolWindowTitle('/some-tool/x')).toBe('Some Tool');
    expect(getToolWindowTitle('/')).toBe('Tool');
  });
});
