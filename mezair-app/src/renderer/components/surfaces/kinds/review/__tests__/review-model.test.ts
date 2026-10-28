import { describe, expect, it } from 'vitest';
import { numberHunkLines } from '../../../../../../shared/surfaces/kinds/review/diff';
import {
  actionTargets,
  chapterFindings,
  countFindingsByFile,
  defaultCollapsedGroups,
  diffRangeAnchor,
  findingAnchor,
  groupFindingsBySeverity,
  initialStageState,
  keyToStageCommand,
  orderedFilePaths,
  pairSplitRows,
  rangeSelection,
  readReviewData,
  reduceReviewStage,
  stageFindingOrder,
  toggleSelection,
  type ReviewStageAction,
  type ReviewStageNav,
  type ReviewStageState,
} from '../review-model';
import { finding, reviewData, reviewIntent } from './review-fixture';

describe('review renderer model', () => {
  it('reads payloads defensively', () => {
    const intent = reviewIntent(reviewData());
    expect(readReviewData(intent)?.findings).toHaveLength(3);
    expect(
      readReviewData({ ...intent, payload: { ...intent.payload, data: { nope: true } } }),
    ).toBeNull();
    const partial = readReviewData({
      ...intent,
      payload: {
        ...intent.payload,
        data: { scope: reviewData().scope, verdict: reviewData().verdict },
      },
    });
    expect(partial).toMatchObject({ findings: [], chapters: [], hunks: {} });
  });

  it('groups by severity in order and collapses quiet groups by default', () => {
    const groups = groupFindingsBySeverity(reviewData().findings);
    expect(
      groups.map((group) => [group.severity, group.findings.length, group.activeCount]),
    ).toEqual([
      ['high', 1, 1],
      ['medium', 1, 0],
      ['low', 1, 1],
    ]);
    expect(defaultCollapsedGroups(groups)).toEqual(['medium', 'low']);
  });

  it('orders files by chapter narrative and findings by file then line', () => {
    const data = reviewData({
      findings: [
        finding({ id: 'b', filePath: 'src/gateway/route.ts', lineStart: 2, lineEnd: 2 }),
        finding({ id: 'a2', lineStart: 13, lineEnd: 13 }),
        finding({ id: 'a1', lineStart: 11, lineEnd: 11 }),
      ],
    });
    expect(orderedFilePaths(data)).toEqual(['src/auth/refresh.ts', 'src/gateway/route.ts']);
    expect(stageFindingOrder(data).map((ref) => ref.id)).toEqual(['a1', 'a2', 'b']);
  });

  it('counts active findings per file and per chapter', () => {
    const data = reviewData();
    expect(countFindingsByFile(data.findings).get('src/auth/refresh.ts')).toBe(1);
    expect(chapterFindings(data, 'c1').map((entry) => entry.id)).toEqual(['f1', 'f3']);
  });

  it('builds comment anchors for findings and line ranges', () => {
    expect(findingAnchor(finding())).toEqual({
      type: 'finding',
      targetId: 'f1',
      filePath: 'src/auth/refresh.ts',
      lineStart: 11,
      lineEnd: 12,
      label: 'f1 · src/auth/refresh.ts:11-12',
    });
    expect(diffRangeAnchor({ filePath: 'a.ts', start: 4, end: 4 })).toMatchObject({
      type: 'diff-range',
      lineStart: 4,
      lineEnd: 4,
      label: 'a.ts:4',
    });
  });

  it('selects with toggle, range and falls back to the focused finding', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
    expect(rangeSelection([], ['a', 'b', 'c', 'd'], 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeSelection(['a'], ['a', 'b', 'c', 'd'], 'c', 'b')).toEqual(['a', 'b', 'c']);
    expect(actionTargets([], 'x')).toEqual(['x']);
    expect(actionTargets(['a'], 'x')).toEqual(['a']);
    expect(actionTargets([], null)).toEqual([]);
  });

  it('pairs deletions with their replacement additions for split view', () => {
    const rows = pairSplitRows(numberHunkLines(reviewData().hunks['src/auth/refresh.ts'][0]));
    expect(rows.map((row) => [row.left?.oldLine ?? null, row.right?.newLine ?? null])).toEqual([
      [10, 10],
      [11, 11],
      [null, 12],
      [12, 13],
      [13, 14],
    ]);
  });

  it('maps keys to stage commands and ignores modified keys', () => {
    expect(keyToStageCommand({ key: 'j' })).toBe('next-finding');
    expect(keyToStageCommand({ key: ']' })).toBe('next-file');
    expect(keyToStageCommand({ key: '?' })).toBe('help');
    expect(keyToStageCommand({ key: ' ' })).toBe('toggle-select');
    expect(keyToStageCommand({ key: 'a', metaKey: true })).toBeNull();
    expect(keyToStageCommand({ key: 'x' })).toBeNull();
  });
});

describe('review stage reducer', () => {
  const data = reviewData();
  const nav: ReviewStageNav = { findings: stageFindingOrder(data), files: orderedFilePaths(data) };
  const run = (state: ReviewStageState, ...actions: ReviewStageAction[]) =>
    actions.reduce((current, action) => reduceReviewStage(current, action, nav), state);

  it('starts on the target finding (or the first)', () => {
    expect(initialStageState(nav)).toMatchObject({
      focusedId: 'f1',
      activeFile: 'src/auth/refresh.ts',
    });
    expect(initialStageState(nav, 'f2')).toMatchObject({
      focusedId: 'f2',
      activeFile: 'src/gateway/route.ts',
    });
  });

  it('moves between findings with j/k, following their files and clamping at the ends', () => {
    const start = initialStageState(nav);
    expect(nav.findings.map((ref) => ref.id)).toEqual(['f1', 'f3', 'f2']);
    const moved = run(start, { type: 'next-finding' }, { type: 'next-finding' });
    expect(moved).toMatchObject({ focusedId: 'f2', activeFile: 'src/gateway/route.ts' });
    expect(run(moved, { type: 'next-finding' }).focusedId).toBe('f2');
    expect(run(start, { type: 'prev-finding' }).focusedId).toBe('f1');
  });

  it('moves between files with ]/[ and focuses their first finding', () => {
    const start = initialStageState(nav);
    const next = run(start, { type: 'next-file' });
    expect(next).toMatchObject({ activeFile: 'src/gateway/route.ts', focusedId: 'f2' });
    expect(run(next, { type: 'next-file' })).toBe(run(next, { type: 'next-file' }));
    expect(run(next, { type: 'prev-file' })).toMatchObject({
      activeFile: 'src/auth/refresh.ts',
      focusedId: 'f1',
    });
  });

  it('supports multi-select with space, cmd-click and shift-click', () => {
    const start = initialStageState(nav);
    const toggled = run(start, { type: 'toggle-select' });
    expect(toggled.selected).toEqual(['f1']);
    const ranged = run(toggled, { type: 'focus-finding', id: 'f2', mode: 'range' });
    expect(ranged.selected).toEqual(['f1', 'f3', 'f2']);
    const cmd = run(ranged, { type: 'focus-finding', id: 'f3', mode: 'toggle' });
    expect(cmd.selected).toEqual(['f1', 'f2']);
    expect(run(cmd, { type: 'clear-selection' }).selected).toEqual([]);
  });

  it('selects line ranges for comments and extends with shift', () => {
    const start = initialStageState(nav);
    const one = run(start, { type: 'select-lines', filePath: 'src/auth/refresh.ts', line: 14 });
    const range = run(one, {
      type: 'select-lines',
      filePath: 'src/auth/refresh.ts',
      line: 11,
      extend: true,
    });
    expect(range.lineSelection).toEqual({ filePath: 'src/auth/refresh.ts', start: 11, end: 14 });
    expect(run(range, { type: 'next-file' }).lineSelection).toBeNull();
  });

  it('toggles split and help, and syncs when findings disappear', () => {
    const start = initialStageState(nav);
    expect(run(start, { type: 'toggle-split' }).split).toBe(true);
    expect(run(start, { type: 'set-help', open: true }).helpOpen).toBe(true);
    const selected = run(
      start,
      { type: 'toggle-select', id: 'f2' },
      { type: 'focus-finding', id: 'f2' },
    );
    const shrunk: ReviewStageNav = {
      findings: nav.findings.filter((ref) => ref.id !== 'f2'),
      files: nav.files,
    };
    const synced = reduceReviewStage(selected, { type: 'sync' }, shrunk);
    expect(synced.selected).toEqual([]);
    expect(synced.focusedId).toBe('f1');
    expect(reduceReviewStage(synced, { type: 'sync' }, shrunk)).toBe(synced);
  });
});
