import { describe, expect, it } from 'vitest';
import {
  checkLineAnchor,
  extractHunksAroundRanges,
  hunkSpans,
  normalizeReviewPath,
  numberHunkLines,
  parseHunkHeader,
  parseUnifiedDiff,
  patchTouchedPaths,
  sliceHunk,
} from '../../../../shared/surfaces/kinds/review/diff.js';
import { REVIEW_FIXTURE_FILES } from './review-fixture.js';

describe('review diff parsing', () => {
  it('parses files, statuses and stats from a multi-file diff', () => {
    expect(REVIEW_FIXTURE_FILES.map((file) => [file.path, file.status])).toEqual([
      ['src/auth/refresh.ts', 'modified'],
      ['src/gateway/new.ts', 'added'],
      ['src/old/legacy.ts', 'deleted'],
    ]);
    const [refresh, added, deleted] = REVIEW_FIXTURE_FILES;
    expect(refresh.hunks).toHaveLength(2);
    expect([refresh.additions, refresh.deletions]).toEqual([4, 2]);
    expect(added.additions).toBe(62);
    expect(deleted.deletions).toBe(3);
  });

  it('keeps content lines that look like headers inside a hunk', () => {
    const [file] = parseUnifiedDiff(
      ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,2 @@', '--- old rule', '+++ new rule', ' tail'].join(
        '\n',
      ),
    );
    expect(file.path).toBe('x.md');
    expect(file.hunks[0].lines).toEqual(['--- old rule', '+++ new rule', ' tail']);
  });

  it('handles renames and header-less patches', () => {
    const [renamed] = parseUnifiedDiff(
      [
        'diff --git a/a.ts b/b.ts',
        'similarity index 90%',
        'rename from a.ts',
        'rename to b.ts',
      ].join('\n'),
    );
    expect(renamed).toMatchObject({ path: 'b.ts', previousPath: 'a.ts', status: 'renamed' });
    expect(patchTouchedPaths('--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n')).toEqual([
      'src/x.ts',
    ]);
  });

  it('numbers old and new lines through additions and deletions', () => {
    const numbered = numberHunkLines(REVIEW_FIXTURE_FILES[0].hunks[0]);
    expect(numbered.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 10, 10],
      ['context', 11, 11],
      ['del', 12, null],
      ['add', null, 12],
      ['add', null, 13],
      ['add', null, 14],
      ['context', 13, 15],
      ['context', 14, 16],
      ['context', 15, 17],
    ]);
    expect(parseHunkHeader('@@ -3 +4,0 @@ fn')).toEqual({
      oldStart: 3,
      oldCount: 1,
      newStart: 4,
      newCount: 0,
      section: 'fn',
    });
  });
});

describe('review anchoring', () => {
  const [refresh, added, deleted] = REVIEW_FIXTURE_FILES;

  it('accepts ranges that overlap a changed hunk', () => {
    expect(hunkSpans(refresh)).toEqual([
      [10, 17],
      [42, 44],
    ]);
    expect(checkLineAnchor(refresh, 13, 14)).toBeNull();
    expect(checkLineAnchor(refresh, 44, 50)).toBeNull();
    expect(checkLineAnchor(added, 30, 30)).toBeNull();
  });

  it('rejects ranges outside the hunks with the changed spans listed', () => {
    expect(checkLineAnchor(refresh, 100, 110)).toBe(
      'lines are outside the changed hunks (changed lines: 10-17, 42-44)',
    );
    expect(checkLineAnchor(refresh, 14, 13)).toBe('lineEnd is before lineStart');
    expect(checkLineAnchor(refresh, 0, 2)).toBe('line numbers must be positive integers');
  });

  it('anchors deleted files on the old side', () => {
    expect(checkLineAnchor(deleted, 2, 2)).toBeNull();
    expect(checkLineAnchor(deleted, 9, 9)).not.toBeNull();
  });

  it('normalises absolute and dotted paths to repo-relative', () => {
    expect(normalizeReviewPath('/Users/dev/app/src/x.ts', '/Users/dev/app')).toBe('src/x.ts');
    expect(normalizeReviewPath('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeReviewPath('src\\win\\y.ts')).toBe('src/win/y.ts');
  });
});

describe('review hunk extraction', () => {
  const [refresh, added] = REVIEW_FIXTURE_FILES;

  it('keeps short hunks whole and skips hunks without findings', () => {
    const hunks = extractHunksAroundRanges(refresh, [[13, 13]]);
    expect(hunks).toEqual([refresh.hunks[0]]);
  });

  it('trims long hunks to a window around the finding with a recomputed header', () => {
    const [slice] = extractHunksAroundRanges(added, [[30, 31]], { context: 2 });
    expect(slice.header).toBe('@@ -0,0 +28,6 @@');
    expect(slice.lines).toHaveLength(6);
    expect(slice.lines[0]).toBe('+  const line27 = 27;');
    expect(numberHunkLines(slice)[0].newLine).toBe(28);
  });

  it('slices mixed hunks keeping deletions next to their position', () => {
    const slice = sliceHunk(refresh.hunks[0], 12, 13);
    expect(slice?.lines).toEqual([
      '-  const next = rotate(session);',
      '+  const next = await rotate(session);',
      '+  cache.set(token, next);',
    ]);
    expect(slice?.header.startsWith('@@ -12,1 +12,2 @@')).toBe(true);
  });
});
