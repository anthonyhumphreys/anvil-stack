import type { CodexEvent, RepoInfo } from '../../../shared/types';
import type { ChatTurnWorkItem } from './chat-turns';

/**
 * CH2 — per-turn change summary data.
 *
 * A completed turn can leave `file_edit` events scattered across `work` and
 * `trailingWork`. These helpers collect them into one deduplicated list with
 * aggregate +N/−M stats for the `TurnChangesFooter`.
 */

export interface TurnFileChange {
  filePath: string;
  /** Concatenated patch text for every edit event touching this file. */
  diff: string;
  /** Number of file_edit events that touched this path. */
  editCount: number;
}

export interface TurnChangeSummary {
  files: TurnFileChange[];
  additions: number;
  deletions: number;
}

function isFileEditEvent(event: CodexEvent): boolean {
  return event.type === 'file_edit' && typeof event.filePath === 'string' && !!event.filePath;
}

export function collectTurnFileChanges(workItems: ChatTurnWorkItem[]): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const item of workItems) {
    if (item.kind !== 'event' || !isFileEditEvent(item.event)) continue;
    const filePath = item.event.filePath as string;
    const diff = item.event.diff ?? '';
    const existing = byPath.get(filePath);
    if (existing) {
      existing.editCount += 1;
      existing.diff = existing.diff ? `${existing.diff}\n${diff}` : diff;
    } else {
      byPath.set(filePath, { filePath, diff, editCount: 1 });
    }
  }
  return [...byPath.values()];
}

const DIFF_ADDED_LINE = /^\+(?!\+\+)/;
const DIFF_REMOVED_LINE = /^-(?!--)/;

export function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (DIFF_ADDED_LINE.test(line)) additions += 1;
    else if (DIFF_REMOVED_LINE.test(line)) deletions += 1;
  }
  return { additions, deletions };
}

export function summarizeTurnChanges(workItems: ChatTurnWorkItem[]): TurnChangeSummary | null {
  const files = collectTurnFileChanges(workItems);
  if (files.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    const stats = countDiffStats(file.diff);
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { files, additions, deletions };
}

export function formatTurnChangeSummary(summary: TurnChangeSummary): string {
  const filePart = `${summary.files.length} file${summary.files.length === 1 ? '' : 's'} changed`;
  return `${filePart} · +${summary.additions} −${summary.deletions}`;
}

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
  if (!filePath.startsWith('/')) return filePath;
  return null;
}
