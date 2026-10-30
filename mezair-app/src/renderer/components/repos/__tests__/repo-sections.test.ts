import { describe, expect, it } from 'vitest';
import { resolveRepoHealthTab, resolveRepoSection } from '../repo-sections';
import { resolveWorkspaceTab } from '../../workspace/workspace-tabs';
import { resolveNotesTab } from '../../notes/notes-tabs';

describe('resolveRepoSection', () => {
  it('reads the section and Health tab from the route', () => {
    expect(resolveRepoSection('health', 'dependencies', new URLSearchParams())).toEqual({
      section: 'health',
      tab: 'dependencies',
      hint: null,
    });
    expect(resolveRepoSection('setup', undefined, new URLSearchParams()).section).toBe('setup');
    expect(resolveRepoSection(undefined, undefined, new URLSearchParams()).section).toBe(
      'overview',
    );
    expect(resolveRepoSection('bogus', 'nope', new URLSearchParams())).toEqual({
      section: 'overview',
      tab: undefined,
      hint: null,
    });
  });

  it('reads the redirect hint used when no repo is chosen yet', () => {
    expect(
      resolveRepoSection(
        undefined,
        undefined,
        new URLSearchParams('view=repositories&section=health&tab=cicd'),
      ).hint,
    ).toEqual({ section: 'health', tab: 'cicd' });
    expect(
      resolveRepoSection(undefined, undefined, new URLSearchParams('section=setup&tab=cicd')).hint,
    ).toEqual({ section: 'setup', tab: undefined });
    expect(
      resolveRepoSection(undefined, undefined, new URLSearchParams('section=overview')).hint,
    ).toBeNull();
  });
});

describe('resolveRepoHealthTab', () => {
  it('honours the requested tab when the role allows it', () => {
    expect(resolveRepoHealthTab('cicd', ['security', 'dependencies', 'cicd'])).toBe('cicd');
  });

  it('falls back to the first allowed tab', () => {
    // ba-brm: dependencies + cicd, no security.
    expect(resolveRepoHealthTab('security', ['dependencies', 'cicd'])).toBe('dependencies');
    expect(resolveRepoHealthTab(undefined, ['cicd'])).toBe('cicd');
    expect(resolveRepoHealthTab('security', [])).toBeNull();
  });
});

describe('resolveWorkspaceTab', () => {
  it('maps URLs to Overview | Repositories | Library', () => {
    expect(resolveWorkspaceTab(new URLSearchParams(), undefined)).toBe('overview');
    expect(resolveWorkspaceTab(new URLSearchParams('view=repositories'), undefined)).toBe(
      'repositories',
    );
    expect(resolveWorkspaceTab(new URLSearchParams('repo=r1'), undefined)).toBe('repositories');
    expect(resolveWorkspaceTab(new URLSearchParams(), 'r1')).toBe('repositories');
    expect(resolveWorkspaceTab(new URLSearchParams('view=library&kind=adr'), undefined)).toBe(
      'library',
    );
    // A Library repo filter must not flip to the Repositories tab.
    expect(resolveWorkspaceTab(new URLSearchParams('view=library&repo=r1'), undefined)).toBe(
      'library',
    );
  });
});

describe('resolveNotesTab', () => {
  it('opens the requested tab when available', () => {
    expect(resolveNotesTab('meeting', ['workspace', 'meeting'])).toBe('meeting');
    expect(resolveNotesTab('workspace', ['workspace', 'meeting'])).toBe('workspace');
  });

  it('falls back to the first available tab', () => {
    expect(resolveNotesTab(null, ['workspace', 'meeting'])).toBe('workspace');
    expect(resolveNotesTab('meeting', ['workspace'])).toBe('workspace');
    expect(resolveNotesTab('workspace', [])).toBeNull();
  });
});
