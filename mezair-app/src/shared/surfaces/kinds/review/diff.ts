// Unified diff parsing, line numbering, anchoring and hunk extraction for the
// Review surface. Pure and process-neutral: main validates finding anchors
// against it, the renderer numbers gutter lines with it.

import type { ReviewFileStatus, ReviewHunk } from './types.js';

export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseHunkHeader(header: string): HunkHeader | null {
  const match = HUNK_HEADER.exec(header);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    section: match[5] ?? '',
  };
}

export type DiffLineKind = 'add' | 'del' | 'context' | 'note';

export interface NumberedDiffLine {
  kind: DiffLineKind;
  /** Line text without its diff prefix. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
  /** Old-side cursor: the old line this sits at (or before, for additions). */
  oldPos: number;
  /** New-side cursor: the new line this sits at (or before, for deletions). */
  newPos: number;
  /** Index into `hunk.lines`. */
  index: number;
}

export function numberHunkLines(hunk: ReviewHunk): NumberedDiffLine[] {
  const header = parseHunkHeader(hunk.header);
  let oldCursor = header?.oldCount === 0 ? (header?.oldStart ?? 0) + 1 : (header?.oldStart ?? 1);
  let newCursor = header?.newCount === 0 ? (header?.newStart ?? 0) + 1 : (header?.newStart ?? 1);
  const numbered: NumberedDiffLine[] = [];
  hunk.lines.forEach((raw, index) => {
    const prefix = raw.charAt(0);
    const text = raw.slice(1);
    if (prefix === '+') {
      numbered.push({
        kind: 'add',
        text,
        oldLine: null,
        newLine: newCursor,
        oldPos: oldCursor,
        newPos: newCursor,
        index,
      });
      newCursor += 1;
    } else if (prefix === '-') {
      numbered.push({
        kind: 'del',
        text,
        oldLine: oldCursor,
        newLine: null,
        oldPos: oldCursor,
        newPos: newCursor,
        index,
      });
      oldCursor += 1;
    } else if (prefix === '\\') {
      numbered.push({
        kind: 'note',
        text: raw,
        oldLine: null,
        newLine: null,
        oldPos: Math.max(oldCursor - 1, 0),
        newPos: Math.max(newCursor - 1, 0),
        index,
      });
    } else {
      numbered.push({
        kind: 'context',
        text,
        oldLine: oldCursor,
        newLine: newCursor,
        oldPos: oldCursor,
        newPos: newCursor,
        index,
      });
      oldCursor += 1;
      newCursor += 1;
    }
  });
  return numbered;
}

export interface ParsedDiffFile {
  path: string;
  previousPath?: string;
  status: ReviewFileStatus;
  binary: boolean;
  hunks: ReviewHunk[];
  additions: number;
  deletions: number;
}

function stripDiffPath(raw: string): string | null {
  let value = raw.replace(/\t.*$/, '').trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

/** Parses a (multi-file) unified diff; tolerates patches without `diff --git` headers. */
export function parseUnifiedDiff(diff: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let file: (ParsedDiffFile & { oldPath?: string | null }) | null = null;
  let hunk: ReviewHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  const startFile = (path = ''): ParsedDiffFile & { oldPath?: string | null } => {
    const next = {
      path,
      status: 'modified' as ReviewFileStatus,
      binary: false,
      hunks: [],
      additions: 0,
      deletions: 0,
    };
    files.push(next);
    return next;
  };

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (hunk && file && (oldRemaining > 0 || newRemaining > 0)) {
      const prefix = line.charAt(0);
      if (prefix === ' ' || line === '') {
        hunk.lines.push(line === '' ? ' ' : line);
        oldRemaining -= 1;
        newRemaining -= 1;
        continue;
      }
      if (prefix === '+') {
        hunk.lines.push(line);
        newRemaining -= 1;
        file.additions += 1;
        continue;
      }
      if (prefix === '-') {
        hunk.lines.push(line);
        oldRemaining -= 1;
        file.deletions += 1;
        continue;
      }
      if (prefix === '\\') {
        hunk.lines.push(line);
        continue;
      }
    } else if (hunk && line.startsWith('\\')) {
      hunk.lines.push(line);
      continue;
    }
    hunk = null;

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      file = startFile(match?.[2] ?? '');
      if (match && match[1] !== match[2]) file.previousPath = match[1];
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!file || file.hunks.length > 0) file = startFile();
      file.oldPath = stripDiffPath(line.slice(4));
      if (file.oldPath === null) file.status = 'added';
      continue;
    }
    if (line.startsWith('+++ ') && file) {
      const nextPath = stripDiffPath(line.slice(4));
      if (nextPath === null) {
        file.status = 'deleted';
        file.path = file.oldPath ?? file.path;
      } else {
        file.path = nextPath;
        if (file.oldPath && file.oldPath !== nextPath && file.status === 'modified') {
          file.status = 'renamed';
          file.previousPath = file.oldPath;
        }
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      if (!header) continue;
      if (!file) file = startFile();
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldRemaining = header.oldCount;
      newRemaining = header.newCount;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.previousPath = line.slice('rename from '.length);
      file.status = 'renamed';
    } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
  }

  return files.map((entry) => {
    const rest: ParsedDiffFile & { oldPath?: string | null } = { ...entry };
    delete rest.oldPath;
    if (rest.status !== 'renamed') delete rest.previousPath;
    return rest;
  });
}

/** Repo-relative, forward-slash path. Absolute paths under `repoRoot` are made relative. */
export function normalizeReviewPath(path: string, repoRoot?: string): string {
  let value = path.trim().replace(/\\/g, '/');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (value === root) return '';
    if (value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  }
  while (value.startsWith('./')) value = value.slice(2);
  return value.replace(/^\/+/, '');
}

export function findDiffFile(
  files: readonly ParsedDiffFile[],
  path: string,
): ParsedDiffFile | undefined {
  return (
    files.find((file) => file.path === path) ?? files.find((file) => file.previousPath === path)
  );
}

/** Changed-hunk spans for anchoring: new side, or old side for deleted files. */
export function hunkSpans(file: Pick<ParsedDiffFile, 'hunks' | 'status'>): Array<[number, number]> {
  const useOld = file.status === 'deleted';
  const spans: Array<[number, number]> = [];
  for (const hunk of file.hunks) {
    const header = parseHunkHeader(hunk.header);
    if (!header) continue;
    const start = useOld ? header.oldStart : header.newStart;
    const count = useOld ? header.oldCount : header.newCount;
    spans.push(count === 0 ? [Math.max(start, 1), Math.max(start, 1)] : [start, start + count - 1]);
  }
  return spans;
}

export function formatSpans(spans: Array<[number, number]>, limit = 6): string {
  const shown = spans
    .slice(0, limit)
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`));
  return spans.length > limit ? `${shown.join(', ')}, …` : shown.join(', ');
}

/** Null when the range sits on a changed hunk; otherwise a plain reason. */
export function checkLineAnchor(
  file: Pick<ParsedDiffFile, 'hunks' | 'status' | 'binary'>,
  lineStart: number,
  lineEnd: number,
): string | null {
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1) {
    return 'line numbers must be positive integers';
  }
  if (lineEnd < lineStart) return 'lineEnd is before lineStart';
  if (file.binary || file.hunks.length === 0) return 'file has no textual hunks to anchor to';
  const spans = hunkSpans(file);
  const overlaps = spans.some(([start, end]) => lineStart <= end && lineEnd >= start);
  if (overlaps) return null;
  return `lines are outside the changed hunks (changed lines: ${formatSpans(spans)})`;
}

function buildHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  section: string,
): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section ? ` ${section}` : ''}`;
}

/** Narrows a hunk to the lines whose new-side position falls within [from, to]. */
export function sliceHunk(
  hunk: ReviewHunk,
  from: number,
  to: number,
  useOld = false,
): ReviewHunk | null {
  const numbered = numberHunkLines(hunk);
  const selected = numbered.filter((line, position) => {
    if (line.kind === 'note') {
      const previous = numbered[position - 1];
      if (!previous) return false;
      const pos = useOld ? previous.oldPos : previous.newPos;
      return pos >= from && pos <= to;
    }
    const pos = useOld ? line.oldPos : line.newPos;
    return pos >= from && pos <= to;
  });
  if (selected.length === 0) return null;
  const first = selected[0];
  const oldCount = selected.filter((line) => line.kind === 'context' || line.kind === 'del').length;
  const newCount = selected.filter((line) => line.kind === 'context' || line.kind === 'add').length;
  const section = parseHunkHeader(hunk.header)?.section ?? '';
  return {
    header: buildHunkHeader(
      oldCount === 0 ? Math.max(first.oldPos - 1, 0) : first.oldPos,
      oldCount,
      newCount === 0 ? Math.max(first.newPos - 1, 0) : first.newPos,
      newCount,
      section,
    ),
    lines: selected.map((line) => hunk.lines[line.index]),
  };
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export interface ExtractHunksOptions {
  /** Context lines kept around each finding range when a hunk is trimmed. */
  context?: number;
  /** Hunks up to this many lines are kept whole. */
  maxWholeHunkLines?: number;
}

/** Hunks (or windows of long hunks) that overlap the given line ranges. */
export function extractHunksAroundRanges(
  file: Pick<ParsedDiffFile, 'hunks' | 'status'>,
  ranges: Array<[number, number]>,
  options: ExtractHunksOptions = {},
): ReviewHunk[] {
  const context = options.context ?? 4;
  const maxWhole = options.maxWholeHunkLines ?? 48;
  const useOld = file.status === 'deleted';
  const spans = hunkSpans(file);
  const result: ReviewHunk[] = [];
  file.hunks.forEach((hunk, index) => {
    const span = spans[index];
    if (!span) return;
    const overlapping = ranges.filter(([start, end]) => start <= span[1] && end >= span[0]);
    if (overlapping.length === 0) return;
    if (hunk.lines.length <= maxWhole) {
      result.push(hunk);
      return;
    }
    for (const [from, to] of mergeRanges(
      overlapping.map(([start, end]) => [start - context, end + context]),
    )) {
      const slice = sliceHunk(hunk, from, to, useOld);
      if (slice) result.push(slice);
    }
  });
  return result;
}

export function countHunkChanges(hunks: readonly ReviewHunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

export function hunksSize(hunks: Record<string, readonly ReviewHunk[]>): number {
  let size = 0;
  for (const list of Object.values(hunks)) {
    for (const hunk of list) {
      size += hunk.header.length + 1;
      for (const line of hunk.lines) size += line.length + 1;
    }
  }
  return size;
}

/** Paths a patch touches (new side, or old side for deletions). */
export function patchTouchedPaths(patch: string): string[] {
  return parseUnifiedDiff(patch)
    .map((file) => file.path)
    .filter(Boolean);
}
