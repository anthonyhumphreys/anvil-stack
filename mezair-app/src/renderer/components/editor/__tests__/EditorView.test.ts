import { describe, expect, it } from 'vitest';
import {
  buildEditorFileSearchOptionId,
  buildEditorFileReference,
  buildEditorLineReference,
  isEmbeddedEditorStatusForWorkspace,
  shouldFocusEditorFileSearchFromKey,
  shouldRestartEmbeddedEditorForWorkspace,
  shouldShowEditorFileSearchEmptyState,
} from '../EditorView';
import type { EmbeddedEditorFileSnapshot, EmbeddedEditorStatus } from '../../../../shared/types';

describe('shouldShowEditorFileSearchEmptyState', () => {
  it('shows the empty state for completed searches with no results', () => {
    expect(
      shouldShowEditorFileSearchEmptyState({
        query: 'missing-file',
        loading: false,
        error: null,
        resultCount: 0,
      }),
    ).toBe(true);
  });

  it('hides the empty state for short, loading, errored, or populated searches', () => {
    expect(
      shouldShowEditorFileSearchEmptyState({
        query: 'm',
        loading: false,
        error: null,
        resultCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowEditorFileSearchEmptyState({
        query: 'missing-file',
        loading: true,
        error: null,
        resultCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowEditorFileSearchEmptyState({
        query: 'missing-file',
        loading: false,
        error: 'Search failed',
        resultCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowEditorFileSearchEmptyState({
        query: 'missing-file',
        loading: false,
        error: null,
        resultCount: 1,
      }),
    ).toBe(false);
  });
});

describe('buildEditorFileReference', () => {
  it('uses relative path plus focus line when available', () => {
    expect(
      buildEditorFileReference(
        snapshotFixture({
          relativePath: 'src/main.ts',
          absolutePath: '/repo/src/main.ts',
          focusLine: 42,
        }),
      ),
    ).toBe('src/main.ts:42');
  });

  it('falls back to absolute path without a focus line', () => {
    expect(buildEditorFileReference(snapshotFixture({ absolutePath: '/repo/src/main.ts' }))).toBe(
      '/repo/src/main.ts',
    );
  });

  it('builds references for any visible line', () => {
    expect(
      buildEditorLineReference(
        snapshotFixture({ relativePath: 'src/main.ts', absolutePath: '/repo/src/main.ts' }),
        7,
      ),
    ).toBe('src/main.ts:7');
  });
});

describe('buildEditorFileSearchOptionId', () => {
  it('builds stable DOM-safe ids for file search options', () => {
    expect(
      buildEditorFileSearchOptionId({
        repoId: 'repo 1',
        repoName: 'App',
        name: 'Thing.tsx',
        path: 'src/components/Thing.tsx',
        relativePath: 'src/components/Thing.tsx',
        size: 123,
      }),
    ).toBe('editor-file-search-option-repo-1-src-components-Thing-tsx');
  });
});

const keyTarget = (closestEditable: boolean, editable = false): EventTarget =>
  ({
    isContentEditable: editable,
    closest: () => (closestEditable ? {} : null),
  }) as unknown as EventTarget;

describe('shouldFocusEditorFileSearchFromKey', () => {
  it('uses Cmd/Ctrl+P to focus editor file search outside editable controls', () => {
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'p',
        metaKey: true,
        ctrlKey: false,
        target: keyTarget(false),
      }),
    ).toBe(true);
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'P',
        metaKey: false,
        ctrlKey: true,
        target: keyTarget(false),
      }),
    ).toBe(true);
  });

  it('ignores other keys and editable targets', () => {
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'k',
        metaKey: true,
        ctrlKey: false,
        target: keyTarget(false),
      }),
    ).toBe(false);
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'p',
        metaKey: false,
        ctrlKey: false,
        target: keyTarget(false),
      }),
    ).toBe(false);
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'p',
        metaKey: true,
        ctrlKey: false,
        target: keyTarget(true),
      }),
    ).toBe(false);
    expect(
      shouldFocusEditorFileSearchFromKey({
        key: 'p',
        metaKey: true,
        ctrlKey: false,
        target: keyTarget(false, true),
      }),
    ).toBe(false);
  });
});

describe('embedded editor workspace status helpers', () => {
  it('only treats a running editor as current when the runtime workspace matches', () => {
    expect(
      isEmbeddedEditorStatusForWorkspace(
        statusFixture({ workspaceId: 'workspace-a' }),
        'workspace-a',
      ),
    ).toBe(true);
    expect(
      isEmbeddedEditorStatusForWorkspace(
        statusFixture({ workspaceId: 'workspace-a' }),
        'workspace-b',
      ),
    ).toBe(false);
    expect(
      isEmbeddedEditorStatusForWorkspace(
        statusFixture({ running: false, workspaceId: 'workspace-a', url: undefined }),
        'workspace-a',
      ),
    ).toBe(false);
  });

  it('requests a restart when the running runtime belongs to another workspace', () => {
    expect(
      shouldRestartEmbeddedEditorForWorkspace(
        statusFixture({ workspaceId: 'workspace-a' }),
        'workspace-b',
      ),
    ).toBe(true);
    expect(
      shouldRestartEmbeddedEditorForWorkspace(
        statusFixture({ workspaceId: 'workspace-a' }),
        'workspace-a',
      ),
    ).toBe(false);
  });
});

function snapshotFixture(
  overrides: Partial<EmbeddedEditorFileSnapshot>,
): EmbeddedEditorFileSnapshot {
  return {
    kind: 'text',
    content: '',
    totalLines: 1,
    displayStartLine: 1,
    displayEndLine: 1,
    truncated: false,
    ...overrides,
  };
}

function statusFixture(overrides: Partial<EmbeddedEditorStatus> = {}): EmbeddedEditorStatus {
  return {
    availability: 'available',
    mode: 'browser',
    running: true,
    workspaceId: 'workspace-a',
    url: 'http://127.0.0.1:1234/?workspace=demo',
    ...overrides,
  };
}
