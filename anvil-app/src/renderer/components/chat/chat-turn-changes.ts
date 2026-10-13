import type { CodexEvent, GitFileChange, RepoInfo } from '../../../shared/types';
import type { ChatTurnWorkItem } from './chat-turns';

/**
 * CH2 / spec §8.2 — per-turn change summary data.
 *
 * A completed turn can leave `file_edit` events scattered across `work` and
 * `trailingWork`. These helpers collect them into one deduplicated list with
 * per-file status and aggregate +N/−M stats for the `TurnChangesFooter`, and
 * decide whether "Undo turn" can safely discard exactly this turn's files.
 */

export type TurnFileStatus = 'added' | 'modified' | 'deleted';

/**
 * How trustworthy the recorded patch is:
 * - `unified`: line-level hunks (or bare +/- lines) for every edit.
 * - `raw`: at least one edit recorded whole-file content instead of a patch.
 * - `truncated`: at least one patch was cut down before reaching the renderer.
 * - `missing`: at least one edit carried no patch at all.
 */
export type TurnPatchKind = 'unified' | 'raw' | 'truncated' | 'missing';

export interface TurnFileChange {
  filePath: string;
  /** Concatenated patch text for every edit event touching this path. */
  diff: string;
  /** Number of file_edit events that touched this path. */
  editCount: number;
  status: TurnFileStatus;
  additions: number;
  deletions: number;
  patch: TurnPatchKind;
}

export interface TurnChangeSummary {
  files: TurnFileChange[];
  additions: number;
  deletions: number;
}

export type TurnStatusCounts = Record<TurnFileStatus, number>;

function isFileEditEvent(event: CodexEvent): boolean {
  return event.type === 'file_edit' && typeof event.filePath === 'string' && !!event.filePath;
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const FILE_HEADER =
  /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files)/;
/** The marker `limitMiddle` inserts in main when a patch is too large to render. */
const TRUNCATION_MARKER = /^\.\.\. truncated \d+ chars \.\.\.$/m;

/**
 * Walks the changed lines of a unified diff. Inside a hunk the header counts
 * decide what is content (so a removed line reading `-- x` isn't mistaken for
 * a `--- ` file header); outside hunks bare `+`/`-` lines still count, which
 * keeps hand-written or header-less patches useful.
 */
function walkDiffChanges(diff: string, visit: (kind: 'add' | 'remove', text: string) => void) {
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) {
        visit('add', line.slice(1));
        newLeft = Math.max(0, newLeft - 1);
      } else if (line.startsWith('-')) {
        visit('remove', line.slice(1));
        oldLeft = Math.max(0, oldLeft - 1);
      } else {
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
      }
      continue;
    }
    if (FILE_HEADER.test(line)) continue;
    if (line.startsWith('+')) visit('add', line.slice(1));
    else if (line.startsWith('-')) visit('remove', line.slice(1));
  }
}

export function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  walkDiffChanges(diff, (kind) => {
    if (kind === 'add') additions += 1;
    else deletions += 1;
  });
  return { additions, deletions };
}

/** True when the text looks like a line-level patch rather than raw file content. */
export function isLineLevelPatch(diff: string): boolean {
  return diff
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => HUNK_HEADER.test(line) || /^[+-]/.test(line));
}

export function detectDiffFileStatus(diff: string): TurnFileStatus {
  if (/^(?:--- \/dev\/null|new file mode)/m.test(diff)) return 'added';
  if (/^(?:\+\+\+ \/dev\/null|deleted file mode)/m.test(diff)) return 'deleted';
  return 'modified';
}

/**
 * Signed tally of changed lines: +1 per added copy, −1 per removed copy, with
 * zero entries dropped. A line edited twice in one turn (A→B, then B→C)
 * cancels out to the net change, so the tally of a turn's concatenated patches
 * can be compared with what `git diff` reports for the working tree.
 */
export function tallyDiffLines(diff: string): Map<string, number> {
  const tally = new Map<string, number>();
  walkDiffChanges(diff, (kind, text) => {
    const next = (tally.get(text) ?? 0) + (kind === 'add' ? 1 : -1);
    if (next === 0) tally.delete(text);
    else tally.set(text, next);
  });
  return tally;
}

/** Tally for a whole file appearing (every line added). */
export function tallyFileContent(content: string): Map<string, number> {
  const tally = new Map<string, number>();
  for (const line of splitContentLines(content)) {
    tally.set(line, (tally.get(line) ?? 0) + 1);
  }
  return tally;
}

export function tallyEquals(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [line, count] of left) {
    if (right.get(line) !== count) return false;
  }
  return true;
}

function splitContentLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline terminates the last line; it isn't an extra empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** First new-side line a patch touches, for "Open in editor". */
export function firstChangedLine(diff: string): number | undefined {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[index]);
    if (!match) continue;
    let line = Number(match[1]);
    for (let next = index + 1; next < lines.length; next += 1) {
      const text = lines[next];
      if (text.startsWith('+') || text.startsWith('-')) return Math.max(1, line);
      if (text.startsWith('@@') || !(text.startsWith(' ') || text === '')) break;
      line += 1;
    }
    return Math.max(1, Number(match[1]));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface FileAccumulator {
  filePath: string;
  diffs: string[];
  firstStatus: TurnFileStatus;
  lastStatus: TurnFileStatus;
  missing: boolean;
  truncated: boolean;
  raw: boolean;
}

function resolveTurnFileStatus(first: TurnFileStatus, last: TurnFileStatus): TurnFileStatus {
  if (last === 'deleted') return first === 'added' ? 'modified' : 'deleted';
  if (first === 'added') return 'added';
  return last;
}

export function collectTurnFileChanges(workItems: ChatTurnWorkItem[]): TurnFileChange[] {
  const byPath = new Map<string, FileAccumulator>();
  for (const item of workItems) {
    if (item.kind !== 'event' || !isFileEditEvent(item.event)) continue;
    const filePath = item.event.filePath as string;
    const diff = item.event.diff ?? '';
    const status = detectDiffFileStatus(diff);
    const accumulator = byPath.get(filePath) ?? {
      filePath,
      diffs: [],
      firstStatus: status,
      lastStatus: status,
      missing: false,
      truncated: false,
      raw: false,
    };
    accumulator.diffs.push(diff);
    accumulator.lastStatus = status;
    if (!diff.trim()) accumulator.missing = true;
    else if (TRUNCATION_MARKER.test(diff)) accumulator.truncated = true;
    else if (!isLineLevelPatch(diff)) accumulator.raw = true;
    byPath.set(filePath, accumulator);
  }

  return [...byPath.values()].map((entry) => {
    const diff = entry.diffs.filter(Boolean).join('\n');
    const stats = countDiffStats(diff);
    const patch: TurnPatchKind = entry.missing
      ? 'missing'
      : entry.truncated
        ? 'truncated'
        : entry.raw
          ? 'raw'
          : 'unified';
    return {
      filePath: entry.filePath,
      diff,
      editCount: entry.diffs.length,
      status: resolveTurnFileStatus(entry.firstStatus, entry.lastStatus),
      additions: stats.additions,
      deletions: stats.deletions,
      patch,
    };
  });
}

export function summarizeTurnChanges(workItems: ChatTurnWorkItem[]): TurnChangeSummary | null {
  const files = collectTurnFileChanges(workItems);
  if (files.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files, additions, deletions };
}

export function formatTurnChangeSummary(summary: TurnChangeSummary): string {
  const filePart = `${summary.files.length} file${summary.files.length === 1 ? '' : 's'} changed`;
  return `${filePart} · +${summary.additions} −${summary.deletions}`;
}

export function countTurnStatuses(files: readonly TurnFileChange[]): TurnStatusCounts {
  const counts: TurnStatusCounts = { added: 0, modified: 0, deleted: 0 };
  for (const file of files) counts[file.status] += 1;
  return counts;
}

export const TURN_FILE_STATUS_LABEL: Record<TurnFileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

/** Splits a path into a muted directory prefix and the file name. */
export function splitDisplayPath(filePath: string): { dir: string; name: string } {
  const index = filePath.lastIndexOf('/');
  if (index < 0) return { dir: '', name: filePath };
  return { dir: filePath.slice(0, index + 1), name: filePath.slice(index + 1) };
}

// ---------------------------------------------------------------------------
// Repo resolution
// ---------------------------------------------------------------------------

/**
 * Best-effort repo resolution for a turn's changes: prefer the thread's
 * active repo, then the repo whose path prefixes the changed files, then the
 * first available repo. Returns null when nothing can host a commit.
 */
export function resolveChangesRepoId(
  filePaths: string[],
  repos: RepoInfo[],
  preferredRepoId?: string | null,
): string | null {
  if (repos.length === 0) return null;
  if (preferredRepoId && repos.some((repo) => repo.id === preferredRepoId)) {
    return preferredRepoId;
  }
  const absolutePaths = filePaths.filter((path) => path.startsWith('/'));
  if (absolutePaths.length > 0) {
    const match = repos.find((repo) =>
      absolutePaths.some((path) => path === repo.path || path.startsWith(`${repo.path}/`)),
    );
    if (match) return match.id;
  }
  return repos[0]?.id ?? null;
}

/** Convert an absolute or already-relative path into a repo-relative path. */
export function repoRelativePath(filePath: string, repoPath: string): string | null {
  if (!filePath) return null;
  if (filePath === repoPath) return filePath;
  if (filePath.startsWith(`${repoPath}/`)) return filePath.slice(repoPath.length + 1);
  if (!filePath.startsWith('/')) return filePath.replace(/^\.\//, '');
  return null;
}

// ---------------------------------------------------------------------------
// Undo eligibility
// ---------------------------------------------------------------------------

export interface TurnUndoTarget {
  file: TurnFileChange;
  /** Repo-relative path handed to `git.discard`. */
  path: string;
}

export type TurnUndoPlan = { ok: true; targets: TurnUndoTarget[] } | { ok: false; reason: string };

export type TurnUndoEligibility =
  { eligible: true; paths: string[] } | { eligible: false; reason: string };

/** What the working tree says about one target file right now. */
export interface TurnUndoProbe {
  /** `git diff -- <path>` against the index (unstaged changes). */
  workingDiff: string;
  /** Current file content on disk (empty when the file is gone). */
  currentContent: string;
}

/**
 * Static checks that need no git round-trip: every file must map into the
 * repo, carry a complete line-level patch, and not have been edited again by a
 * later turn in the thread.
 */
export function planTurnUndo(
  files: readonly TurnFileChange[],
  repoPath: string | null | undefined,
  laterTurnEditedPaths?: readonly string[],
): TurnUndoPlan {
  if (!repoPath) return { ok: false, reason: 'No repository is attached to these changes.' };
  if (files.length === 0) return { ok: false, reason: 'This turn changed no files.' };

  const later = new Set(
    (laterTurnEditedPaths ?? [])
      .map((path) => repoRelativePath(path, repoPath))
      .filter((path): path is string => Boolean(path)),
  );
  const targets: TurnUndoTarget[] = [];
  for (const file of files) {
    const path = repoRelativePath(file.filePath, repoPath);
    if (!path || path === repoPath) {
      return { ok: false, reason: `${file.filePath} is outside the repository.` };
    }
    if (later.has(path)) {
      return { ok: false, reason: `${path} was edited again in a later turn.` };
    }
    if (file.patch === 'missing') {
      return {
        ok: false,
        reason: `No patch was recorded for ${path}, so the change can't be verified.`,
      };
    }
    if (file.patch === 'truncated') {
      return { ok: false, reason: `The recorded patch for ${path} was truncated.` };
    }
    targets.push({ file, path });
  }
  return { ok: true, targets };
}

/** Finds the status entry for a repo-relative path. */
export function findStatusEntry(
  statusFiles: readonly GitFileChange[],
  path: string,
): GitFileChange | 'untracked-folder' | null {
  const exact = statusFiles.find((entry) => entry.path === path);
  if (exact) return exact;
  const folder = statusFiles.find(
    (entry) =>
      entry.status === 'untracked' && entry.path.endsWith('/') && path.startsWith(entry.path),
  );
  return folder ? 'untracked-folder' : null;
}

/** True when the target needs a `git.diff` probe before it can be judged. */
export function targetNeedsProbe(
  target: TurnUndoTarget,
  statusFiles: readonly GitFileChange[],
): boolean {
  const entry = findStatusEntry(statusFiles, target.path);
  return (
    entry !== null &&
    entry !== 'untracked-folder' &&
    !entry.staged &&
    (entry.status === 'modified' || entry.status === 'deleted' || entry.status === 'untracked')
  );
}

/**
 * Returns null when discarding `target.path` restores exactly the pre-turn
 * state, otherwise a plain-language reason. Conservative by design: any
 * uncommitted change that isn't this turn's (earlier user edits, later agent
 * edits, staged hunks) blocks the undo.
 */
export function checkTurnUndoTarget(
  target: TurnUndoTarget,
  statusFiles: readonly GitFileChange[],
  probe: TurnUndoProbe | undefined,
): string | null {
  const { file, path } = target;
  const entry = findStatusEntry(statusFiles, path);
  const turnTally = file.patch === 'raw' ? null : tallyDiffLines(file.diff);

  if (entry === null) {
    // Net-zero turn edits leave nothing to restore.
    if (turnTally && turnTally.size === 0) return null;
    return `${path} has no uncommitted changes — it was committed or already reverted.`;
  }
  if (entry === 'untracked-folder') {
    return `${path} is in a new folder Git doesn't track file by file yet.`;
  }
  if (entry.staged) return `${path} has staged changes.`;
  if (entry.status !== 'modified' && entry.status !== 'deleted' && entry.status !== 'untracked') {
    return `${path} is ${entry.status}.`;
  }
  if (!probe) return `Couldn't read the current changes for ${path}.`;

  if (entry.status === 'untracked') {
    // Discarding an untracked file deletes it, so the turn must have created it.
    if (file.patch === 'raw') {
      const recorded = file.diff.replace(/\r\n/g, '\n').replace(/\n$/, '');
      const current = probe.currentContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
      return file.editCount === 1 && recorded === current
        ? null
        : `${path} has changes from outside this turn.`;
    }
    if (file.status !== 'added')
      return `${path} existed before this turn and isn't tracked by Git.`;
    return tallyEquals(turnTally!, tallyFileContent(probe.currentContent))
      ? null
      : `${path} has changes from outside this turn.`;
  }

  if (!turnTally) return `The recorded change for ${path} isn't a line-level patch.`;
  return tallyEquals(turnTally, tallyDiffLines(probe.workingDiff))
    ? null
    : `${path} has changes from outside this turn.`;
}

/** Combines the static plan with live git state into one verdict. */
export function evaluateTurnUndo(
  plan: TurnUndoPlan,
  statusFiles: readonly GitFileChange[],
  probes: ReadonlyMap<string, TurnUndoProbe>,
): TurnUndoEligibility {
  if (!plan.ok) return { eligible: false, reason: plan.reason };
  const paths: string[] = [];
  for (const target of plan.targets) {
    const reason = checkTurnUndoTarget(target, statusFiles, probes.get(target.path));
    if (reason) return { eligible: false, reason };
    if (findStatusEntry(statusFiles, target.path) !== null) paths.push(target.path);
  }
  if (paths.length === 0) {
    return { eligible: false, reason: 'Nothing from this turn is left to undo.' };
  }
  return { eligible: true, paths };
}

// ---------------------------------------------------------------------------
// Review prompt
// ---------------------------------------------------------------------------

const REVIEW_PROMPT_FILE_LIMIT = 20;

/**
 * Drafts the composer prompt behind "Review these changes". The Review tool's
 * `turn` scope covers the latest editing turn only, so older turns name their
 * files and fall back to a working-tree scope limited to them.
 */
export function buildTurnReviewPrompt(input: {
  repoId: string | null;
  paths: readonly string[];
  /** True when no later turn has edited files; undefined when unknown. */
  isLatestEditingTurn?: boolean;
}): string {
  const { repoId, paths, isLatestEditingTurn } = input;
  const count = `${paths.length} file${paths.length === 1 ? '' : 's'}`;
  const listed = paths.slice(0, REVIEW_PROMPT_FILE_LIMIT).map((path) => `- \`${path}\``);
  if (paths.length > REVIEW_PROMPT_FILE_LIMIT) {
    listed.push(`- …and ${paths.length - REVIEW_PROMPT_FILE_LIMIT} more`);
  }
  const repoPart = repoId ? `, repoId: "${repoId}"` : '';
  const scopeLine =
    isLatestEditingTurn === true
      ? `Call review_context with scope { type: "turn"${repoPart} } to load the diff.`
      : isLatestEditingTurn === false
        ? `These aren't the latest edits in this thread, so call review_context with scope { type: "working-tree"${repoPart} } and review only these files.`
        : `Call review_context with scope { type: "turn"${repoPart} } to load the diff; if it doesn't cover these files, use scope "working-tree" and review only these files.`;
  return [
    `Review the changes from this turn (${count}):`,
    ...listed,
    '',
    scopeLine,
    'Then publish the review with review_publish so it renders as a Review surface: a verdict, the change told as chapters, and findings anchored to the changed lines.',
  ].join('\n');
}

/**
 * Structural equality for summaries. Transcript renders rebuild a turn's work
 * items on every pass; comparing content lets the footer keep one stable
 * summary so effects (like the undo check) don't re-run on unrelated renders.
 */
export function sameTurnChangeSummary(
  left: TurnChangeSummary | null,
  right: TurnChangeSummary | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.files.length !== right.files.length) return false;
  return left.files.every((file, index) => {
    const other = right.files[index];
    return (
      file.filePath === other.filePath &&
      file.editCount === other.editCount &&
      file.diff === other.diff
    );
  });
}
