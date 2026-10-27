import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../../../../shared/library-ipc';
import type { Feature } from '../../../../shared/types';
import {
  availableLibraryChips,
  formatLibraryUpdatedAt,
  libraryEmptyCopy,
  libraryItemOpenAction,
  libraryListFilter,
  librarySubtypeLabel,
  resolveLibraryFilter,
  visibleLibraryItems,
} from '../library-model';

const item = (overrides: Partial<LibraryItem>): LibraryItem => ({
  id: 'x',
  kind: 'artifact',
  title: 'Title',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...overrides,
});

const allowOnly =
  (...features: Feature[]) =>
  (feature?: Feature) =>
    !feature || features.includes(feature);

describe('library chips', () => {
  it('shows every chip in spec order when all features are allowed', () => {
    expect(availableLibraryChips(() => true).map((chip) => chip.label)).toEqual([
      'All',
      'Artifacts',
      'Reviews & reports',
      'ADRs',
      'Diagrams',
      'Compliance',
      'Docs',
      'Shared',
    ]);
  });

  it('hides knowledge chips the role cannot use', () => {
    // design role: diagrams, docs, compliance — no ADRs.
    const chips = availableLibraryChips(allowOnly('diagrams', 'docs', 'compliance'));
    expect(chips.map((chip) => chip.key)).toEqual([
      'all',
      'artifact',
      'surface',
      'diagram',
      'compliance',
      'doc',
      'shared',
    ]);
  });

  it('resolves the kind param against available chips', () => {
    const chips = availableLibraryChips(allowOnly('diagrams'));
    expect(resolveLibraryFilter('diagram', chips)).toBe('diagram');
    expect(resolveLibraryFilter('adr', chips)).toBe('all');
    expect(resolveLibraryFilter('nonsense', chips)).toBe('all');
    expect(resolveLibraryFilter(null, chips)).toBe('all');
  });
});

describe('libraryListFilter', () => {
  it('maps chips to main-process filters', () => {
    expect(libraryListFilter('all')).toEqual({});
    expect(libraryListFilter('surface', { repoId: 'r1', query: '  auth ' })).toEqual({
      kind: 'surface',
      repoId: 'r1',
      query: 'auth',
    });
    expect(libraryListFilter('adr', { repoId: null, query: '' })).toEqual({ kind: 'adr' });
  });

  it('returns null for embedded views (docs, shared links)', () => {
    expect(libraryListFilter('doc')).toBeNull();
    expect(libraryListFilter('shared')).toBeNull();
  });
});

describe('visibleLibraryItems', () => {
  it('drops knowledge items whose feature the role lacks', () => {
    const items = [
      item({ id: 'a', kind: 'artifact' }),
      item({ id: 's', kind: 'surface' }),
      item({ id: 'adr', kind: 'adr' }),
      item({ id: 'd', kind: 'diagram' }),
    ];
    expect(visibleLibraryItems(items, allowOnly('diagrams')).map((entry) => entry.id)).toEqual([
      'a',
      's',
      'd',
    ]);
  });
});

describe('libraryItemOpenAction', () => {
  it('opens artifacts and surfaces on their thread’s stage', () => {
    expect(libraryItemOpenAction(item({ id: 'a1', kind: 'artifact', threadId: 't1' }))).toEqual({
      type: 'navigate',
      to: '/chat?thread=t1&artifact=a1',
    });
    expect(libraryItemOpenAction(item({ id: 's1', kind: 'surface', threadId: 't1' }))).toEqual({
      type: 'navigate',
      to: '/chat?thread=t1&surface=s1',
    });
  });

  it('opens repo knowledge in the detail pane', () => {
    expect(libraryItemOpenAction(item({ kind: 'adr' }))).toEqual({ type: 'detail' });
    expect(libraryItemOpenAction(item({ kind: 'diagram' }))).toEqual({ type: 'detail' });
    expect(libraryItemOpenAction(item({ kind: 'compliance' }))).toEqual({ type: 'detail' });
    // An artifact without a thread has nowhere to navigate to.
    expect(libraryItemOpenAction(item({ kind: 'artifact' }))).toEqual({ type: 'detail' });
  });

  it('sends docs to the Docs chip', () => {
    expect(libraryItemOpenAction(item({ kind: 'doc' }))).toEqual({
      type: 'navigate',
      to: '/workspace?view=library&kind=doc',
    });
  });
});

describe('row labels', () => {
  it('describes kind, subtype and version', () => {
    expect(librarySubtypeLabel(item({ kind: 'artifact', subtype: 'markdown', version: 3 }))).toBe(
      'Artifact · Markdown v3',
    );
    expect(librarySubtypeLabel(item({ kind: 'artifact', subtype: 'pdf', version: 1 }))).toBe(
      'Artifact · PDF',
    );
    expect(librarySubtypeLabel(item({ kind: 'surface', subtype: 'review' }))).toBe(
      'Report · Review',
    );
    expect(librarySubtypeLabel(item({ kind: 'adr', subtype: 'Accepted' }))).toBe('ADR · Accepted');
    expect(librarySubtypeLabel(item({ kind: 'compliance', subtype: 'dpia' }))).toBe(
      'Compliance · DPIA',
    );
    expect(librarySubtypeLabel(item({ kind: 'diagram' }))).toBe('Diagram');
  });

  it('formats relative update times', () => {
    const now = Date.parse('2026-09-01T12:00:00.000Z');
    expect(formatLibraryUpdatedAt('2026-09-01T11:59:40.000Z', now)).toBe('just now');
    expect(formatLibraryUpdatedAt('2026-09-01T11:15:00.000Z', now)).toBe('45m ago');
    expect(formatLibraryUpdatedAt('2026-09-01T07:00:00.000Z', now)).toBe('5h ago');
    expect(formatLibraryUpdatedAt('2026-08-29T12:00:00.000Z', now)).toBe('3d ago');
    expect(formatLibraryUpdatedAt('not a date', now)).toBe('');
  });

  it('has filter-specific empty states', () => {
    expect(libraryEmptyCopy('all', false).title).toBe('The Library is empty');
    expect(libraryEmptyCopy('surface', false).title).toMatch(/reviews or reports/);
    expect(libraryEmptyCopy('adr', true).title).toBe('Nothing matches');
  });
});
