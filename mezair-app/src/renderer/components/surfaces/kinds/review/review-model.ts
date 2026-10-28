// Pure renderer helpers for the Review surface: payload access, grouping,
// navigation order, selection, split-view pairing and the stage keyboard model.

import type { AgentUISurfaceIntent } from '../../../../../shared/agent-ui-intents';
import {
  REVIEW_SEVERITIES,
  formatFindingLocation,
  isActiveFinding,
} from '../../../../../shared/surfaces/kinds/review/model';
import type { NumberedDiffLine } from '../../../../../shared/surfaces/kinds/review/diff';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import type {
  ReviewChapter,
  ReviewFinding,
  ReviewHunk,
  ReviewSeverity,
  ReviewSurfaceData,
} from '../../../../../shared/surfaces/kinds/review/types';

/** Reads the payload defensively; renders nothing rather than crashing on a malformed intent. */
export function readReviewData(intent: AgentUISurfaceIntent): ReviewSurfaceData | null {
  const data = intent.payload?.data as Partial<ReviewSurfaceData> | undefined;
  if (!data || typeof data !== 'object' || !data.scope || !data.verdict) return null;
  return {
    scope: data.scope,
    verdict: data.verdict,
    stats: data.stats ?? { files: 0, additions: 0, deletions: 0 },
    risks: Array.isArray(data.risks) ? data.risks : [],
    chapters: Array.isArray(data.chapters) ? data.chapters : [],
    findings: Array.isArray(data.findings) ? data.findings : [],
    files: Array.isArray(data.files) ? data.files : [],
    hunks: data.hunks ?? {},
    ...(data.fullDiff ? { fullDiff: data.fullDiff } : {}),
    ...(data.fullDiffOmitted ? { fullDiffOmitted: true } : {}),
    ...(data.notes ? { notes: data.notes } : {}),
    ...(data.prComments ? { prComments: data.prComments } : {}),
  };
}

export function compareFindingPosition(a: ReviewFinding, b: ReviewFinding): number {
  return (
    a.filePath.localeCompare(b.filePath) || a.lineStart - b.lineStart || a.id.localeCompare(b.id)
  );
}

export interface SeverityGroup {
  severity: ReviewSeverity;
  findings: ReviewFinding[];
  activeCount: number;
}

export function groupFindingsBySeverity(findings: readonly ReviewFinding[]): SeverityGroup[] {
  return REVIEW_SEVERITIES.map((severity) => {
    const group = findings
      .filter((finding) => finding.severity === severity)
      .sort(compareFindingPosition);
    return { severity, findings: group, activeCount: group.filter(isActiveFinding).length };
  }).filter((group) => group.findings.length > 0);
}

/** Severity groups that start collapsed inline: low/info, and groups with nothing active. */
export function defaultCollapsedGroups(groups: readonly SeverityGroup[]): ReviewSeverity[] {
  return groups
    .filter(
      (group) => group.severity === 'low' || group.severity === 'info' || group.activeCount === 0,
    )
    .map((group) => group.severity);
}

/** File tree order: chapter files in narrative order, then anything else that changed. */
export function orderedFilePaths(
  data: Pick<ReviewSurfaceData, 'chapters' | 'files' | 'findings'>,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const push = (path: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    order.push(path);
  };
  for (const chapter of [...data.chapters].sort((a, b) => a.index - b.index)) {
    for (const file of chapter.files) push(file.path);
  }
  for (const file of data.files) push(file.path);
  for (const finding of data.findings) push(finding.filePath);
  return order;
}

export interface FindingRef {
  id: string;
  filePath: string;
}

/** Stage reading order for j/k: file tree order, then line. */
export function stageFindingOrder(
  data: Pick<ReviewSurfaceData, 'chapters' | 'files' | 'findings'>,
): FindingRef[] {
  const files = orderedFilePaths(data);
  const rank = new Map(files.map((path, index) => [path, index]));
  return [...data.findings]
    .sort(
      (a, b) =>
        (rank.get(a.filePath) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.filePath) ?? Number.MAX_SAFE_INTEGER) ||
        a.lineStart - b.lineStart ||
        a.id.localeCompare(b.id),
    )
    .map((finding) => ({ id: finding.id, filePath: finding.filePath }));
}

export function countFindingsByFile(findings: readonly ReviewFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    if (!isActiveFinding(finding)) continue;
    counts.set(finding.filePath, (counts.get(finding.filePath) ?? 0) + 1);
  }
  return counts;
}

export function chapterFindings(
  data: Pick<ReviewSurfaceData, 'findings' | 'chapters'>,
  chapterId: string,
): ReviewFinding[] {
  const chapter = data.chapters.find((entry) => entry.id === chapterId);
  const paths = new Set(chapter?.files.map((file) => file.path) ?? []);
  return data.findings.filter(
    (finding) =>
      finding.chapterId === chapterId || (!finding.chapterId && paths.has(finding.filePath)),
  );
}

/** Full diff when embedded, otherwise the hunks around findings. */
export function hunksForFile(
  data: Pick<ReviewSurfaceData, 'fullDiff' | 'hunks'>,
  path: string,
): ReviewHunk[] {
  return data.fullDiff?.[path] ?? data.hunks[path] ?? [];
}

export function findingsForFile(findings: readonly ReviewFinding[], path: string): ReviewFinding[] {
  return findings.filter((finding) => finding.filePath === path).sort(compareFindingPosition);
}

export function findingAnchor(finding: ReviewFinding): SurfaceAnchor {
  return {
    type: 'finding',
    targetId: finding.id,
    filePath: finding.filePath,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    label: `${finding.id} · ${formatFindingLocation(finding)}`,
  };
}

export function chapterAnchor(chapter: ReviewChapter): SurfaceAnchor {
  return {
    type: 'chapter',
    targetId: chapter.id,
    label: `Chapter ${chapter.index} · ${chapter.title}`,
  };
}

export function diffRangeAnchor(selection: LineSelection): SurfaceAnchor {
  return {
    type: 'diff-range',
    filePath: selection.filePath,
    lineStart: selection.start,
    lineEnd: selection.end,
    label:
      selection.end > selection.start
        ? `${selection.filePath}:${selection.start}-${selection.end}`
        : `${selection.filePath}:${selection.start}`,
  };
}

/** Targets for a bulk action: the selection, else the focused finding. */
export function actionTargets(selected: readonly string[], focusedId: string | null): string[] {
  if (selected.length > 0) return [...selected];
  return focusedId ? [focusedId] : [];
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function toggleSelection(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id];
}

/** Shift-click: everything between the anchor and the clicked id in `order`, merged into the selection. */
export function rangeSelection(
  selected: readonly string[],
  order: readonly string[],
  anchorId: string | null,
  id: string,
): string[] {
  const to = order.indexOf(id);
  const from = anchorId ? order.indexOf(anchorId) : -1;
  if (to < 0) return [...selected];
  if (from < 0) return toggleSelection(selected, id);
  const [start, end] = from <= to ? [from, to] : [to, from];
  const next = new Set(selected);
  for (const entry of order.slice(start, end + 1)) next.add(entry);
  return order.filter((entry) => next.has(entry));
}

// ---------------------------------------------------------------------------
// Split view
// ---------------------------------------------------------------------------

export interface SplitRow {
  left: NumberedDiffLine | null;
  right: NumberedDiffLine | null;
}

/** Pairs deletions with the additions that replace them; context sits on both sides. */
export function pairSplitRows(lines: readonly NumberedDiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    if (line.kind === 'note') {
      index += 1;
      continue;
    }
    const dels: NumberedDiffLine[] = [];
    const adds: NumberedDiffLine[] = [];
    while (index < lines.length && (lines[index].kind === 'del' || lines[index].kind === 'note')) {
      if (lines[index].kind === 'del') dels.push(lines[index]);
      index += 1;
    }
    while (index < lines.length && (lines[index].kind === 'add' || lines[index].kind === 'note')) {
      if (lines[index].kind === 'add') adds.push(lines[index]);
      index += 1;
    }
    for (let pair = 0; pair < Math.max(dels.length, adds.length); pair += 1) {
      rows.push({ left: dels[pair] ?? null, right: adds[pair] ?? null });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Stage state + keyboard
// ---------------------------------------------------------------------------

export interface LineSelection {
  filePath: string;
  start: number;
  end: number;
}

export interface ReviewStageState {
  focusedId: string | null;
  activeFile: string | null;
  selected: string[];
  anchorId: string | null;
  split: boolean;
  helpOpen: boolean;
  lineSelection: LineSelection | null;
}

export interface ReviewStageNav {
  findings: readonly FindingRef[];
  files: readonly string[];
}

export type ReviewStageAction =
  | { type: 'next-finding' }
  | { type: 'prev-finding' }
  | { type: 'next-file' }
  | { type: 'prev-file' }
  | { type: 'focus-finding'; id: string; mode?: 'replace' | 'toggle' | 'range' }
  | { type: 'select-file'; path: string }
  | { type: 'toggle-select'; id?: string }
  | { type: 'set-selection'; ids: string[] }
  | { type: 'clear-selection' }
  | { type: 'toggle-split' }
  | { type: 'set-help'; open: boolean }
  | { type: 'select-lines'; filePath: string; line: number; extend?: boolean }
  | { type: 'clear-lines' }
  | { type: 'sync' };

export function initialStageState(nav: ReviewStageNav, focusTargetId?: string): ReviewStageState {
  const target =
    nav.findings.find((finding) => finding.id === focusTargetId) ?? nav.findings[0] ?? null;
  return {
    focusedId: target?.id ?? null,
    activeFile: target?.filePath ?? nav.files[0] ?? null,
    selected: [],
    anchorId: target?.id ?? null,
    split: false,
    helpOpen: false,
    lineSelection: null,
  };
}

function focusFinding(state: ReviewStageState, ref: FindingRef | undefined): ReviewStageState {
  if (!ref) return state;
  return {
    ...state,
    focusedId: ref.id,
    activeFile: ref.filePath,
    lineSelection: state.lineSelection?.filePath === ref.filePath ? state.lineSelection : null,
  };
}

function moveFile(state: ReviewStageState, nav: ReviewStageNav, delta: number): ReviewStageState {
  if (nav.files.length === 0) return state;
  const current = state.activeFile ? nav.files.indexOf(state.activeFile) : -1;
  const index = Math.min(Math.max(current + delta, 0), nav.files.length - 1);
  if (current < 0 && delta < 0) return state;
  const path = nav.files[current < 0 ? 0 : index];
  if (path === state.activeFile) return state;
  const first = nav.findings.find((finding) => finding.filePath === path);
  return { ...state, activeFile: path, focusedId: first?.id ?? null, lineSelection: null };
}

export function reduceReviewStage(
  state: ReviewStageState,
  action: ReviewStageAction,
  nav: ReviewStageNav,
): ReviewStageState {
  const order = nav.findings.map((finding) => finding.id);
  const focusedIndex = state.focusedId ? order.indexOf(state.focusedId) : -1;
  switch (action.type) {
    case 'next-finding':
      return focusFinding(
        state,
        nav.findings[focusedIndex < 0 ? 0 : Math.min(focusedIndex + 1, order.length - 1)],
      );
    case 'prev-finding':
      return focusFinding(
        state,
        nav.findings[focusedIndex < 0 ? 0 : Math.max(focusedIndex - 1, 0)],
      );
    case 'next-file':
      return moveFile(state, nav, 1);
    case 'prev-file':
      return moveFile(state, nav, -1);
    case 'focus-finding': {
      const ref = nav.findings.find((finding) => finding.id === action.id);
      if (!ref) return state;
      const focused = focusFinding(state, ref);
      if (action.mode === 'toggle') {
        return {
          ...focused,
          selected: toggleSelection(state.selected, action.id),
          anchorId: action.id,
        };
      }
      if (action.mode === 'range') {
        return {
          ...focused,
          selected: rangeSelection(state.selected, order, state.anchorId, action.id),
        };
      }
      return { ...focused, anchorId: action.id };
    }
    case 'select-file': {
      if (!nav.files.includes(action.path) && !nav.findings.some((f) => f.filePath === action.path))
        return state;
      if (action.path === state.activeFile) return state;
      const first = nav.findings.find((finding) => finding.filePath === action.path);
      return {
        ...state,
        activeFile: action.path,
        focusedId: first?.id ?? null,
        lineSelection: null,
      };
    }
    case 'toggle-select': {
      const id = action.id ?? state.focusedId;
      if (!id || !order.includes(id)) return state;
      return { ...state, selected: toggleSelection(state.selected, id), anchorId: id };
    }
    case 'set-selection':
      return { ...state, selected: action.ids.filter((id) => order.includes(id)) };
    case 'clear-selection':
      return state.selected.length === 0 && !state.lineSelection
        ? state
        : { ...state, selected: [], lineSelection: null };
    case 'toggle-split':
      return { ...state, split: !state.split };
    case 'set-help':
      return { ...state, helpOpen: action.open };
    case 'select-lines': {
      const current = state.lineSelection;
      if (action.extend && current && current.filePath === action.filePath) {
        return {
          ...state,
          lineSelection: {
            filePath: action.filePath,
            start: Math.min(current.start, action.line),
            end: Math.max(current.start, action.line),
          },
        };
      }
      return {
        ...state,
        lineSelection: { filePath: action.filePath, start: action.line, end: action.line },
      };
    }
    case 'clear-lines':
      return state.lineSelection ? { ...state, lineSelection: null } : state;
    case 'sync': {
      // Data changed (patch/stream): drop ids that vanished, keep focus valid.
      const selected = state.selected.filter((id) => order.includes(id));
      const focusedValid = state.focusedId && order.includes(state.focusedId);
      const focusedId = focusedValid ? state.focusedId : (nav.findings[0]?.id ?? null);
      const activeFile =
        state.activeFile &&
        (nav.files.includes(state.activeFile) ||
          nav.findings.some((f) => f.filePath === state.activeFile))
          ? state.activeFile
          : (nav.findings.find((finding) => finding.id === focusedId)?.filePath ??
            nav.files[0] ??
            null);
      if (
        selected.length === state.selected.length &&
        focusedId === state.focusedId &&
        activeFile === state.activeFile
      ) {
        return state;
      }
      return { ...state, selected, focusedId, activeFile };
    }
  }
}

export type ReviewStageCommand =
  | 'next-finding'
  | 'prev-finding'
  | 'next-file'
  | 'prev-file'
  | 'accept'
  | 'dismiss'
  | 'ask-fix'
  | 'comment'
  | 'toggle-split'
  | 'help'
  | 'toggle-select'
  | 'clear';

export interface ShortcutKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export function keyToStageCommand(event: ShortcutKeyEvent): ReviewStageCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case 'j':
      return 'next-finding';
    case 'k':
      return 'prev-finding';
    case ']':
      return 'next-file';
    case '[':
      return 'prev-file';
    case 'a':
      return 'accept';
    case 'd':
      return 'dismiss';
    case 'f':
      return 'ask-fix';
    case 'c':
      return 'comment';
    case 's':
      return 'toggle-split';
    case '?':
      return 'help';
    case ' ':
      return 'toggle-select';
    case 'Escape':
      return 'clear';
    default:
      return null;
  }
}

export const REVIEW_SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ['j', 'k'], label: 'Next / previous finding' },
  { keys: [']', '['], label: 'Next / previous file' },
  { keys: ['Space'], label: 'Select or deselect the focused finding' },
  { keys: ['⇧ click', '⌘ click'], label: 'Select a range / add to selection' },
  { keys: ['a'], label: 'Accept' },
  { keys: ['d'], label: 'Dismiss (asks for a reason)' },
  { keys: ['f'], label: 'Ask the agent to fix' },
  { keys: ['c'], label: 'Comment on the selected lines or finding' },
  { keys: ['s'], label: 'Toggle split / unified diff' },
  { keys: ['?'], label: 'Show these shortcuts' },
  { keys: ['Esc'], label: 'Clear selection' },
];
