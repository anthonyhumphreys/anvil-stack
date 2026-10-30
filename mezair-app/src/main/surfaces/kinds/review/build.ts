// Pure builders for the Review payload: input normalisation, anchoring against
// the scope diff, hunk extraction, stats, verdict, and patch operations.

import {
  checkLineAnchor,
  extractHunksAroundRanges,
  findDiffFile,
  hunksSize,
  normalizeReviewPath,
  parseUnifiedDiff,
  type ParsedDiffFile,
} from '../../../../shared/surfaces/kinds/review/diff.js';
import {
  REVIEW_DECISIONS,
  REVIEW_FINDING_STATUSES,
  REVIEW_SEVERITIES,
  defaultVerdictSummary,
  describeDecisionBounds,
  formatFindingLocation,
  isDecisionConsistent,
  reconcileVerdict,
} from '../../../../shared/surfaces/kinds/review/model.js';
import type {
  ReviewChapter,
  ReviewDecision,
  ReviewFileStat,
  ReviewFinding,
  ReviewFindingStatus,
  ReviewHunk,
  ReviewRisk,
  ReviewScope,
  ReviewSeverity,
  ReviewSurfaceData,
  ReviewVerdict,
} from '../../../../shared/surfaces/kinds/review/types.js';

/** Payload budget for embedding the complete diff (characters). */
export const FULL_DIFF_BUDGET = 250_000;
export const MAX_FINDINGS = 500;

export class ReviewInputError extends Error {
  constructor(
    readonly issues: string[],
    summary?: string,
  ) {
    super(summary ? `${summary}\n- ${issues.join('\n- ')}` : issues.join('\n'));
    this.name = 'ReviewInputError';
  }
}

export interface ReviewDiffContext {
  scope: ReviewScope;
  files: readonly ParsedDiffFile[];
  repoPath?: string;
  notes?: string[];
}

type Raw = Record<string, unknown>;

const SEVERITY_ALIASES: Record<string, ReviewSeverity> = {
  critical: 'critical',
  blocker: 'critical',
  high: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  minor: 'medium',
  low: 'low',
  suggestion: 'low',
  info: 'info',
  nitpick: 'info',
  nit: 'info',
};

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function parseSeverity(value: unknown): ReviewSeverity | undefined {
  return typeof value === 'string' ? SEVERITY_ALIASES[value.trim().toLowerCase()] : undefined;
}

function asArray(value: unknown, label: string, issues: string[]): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array`);
    return [];
  }
  return value;
}

export function diffFileStats(files: readonly ParsedDiffFile[]): ReviewFileStat[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

// ---------------------------------------------------------------------------
// Chapters, risks, findings
// ---------------------------------------------------------------------------

export function normalizeChapters(
  rawChapters: unknown,
  diff: ReviewDiffContext,
  issues: string[],
): ReviewChapter[] {
  const chapters: ReviewChapter[] = [];
  const ids = new Set<string>();
  asArray(rawChapters, 'chapters', issues).forEach((raw, position) => {
    if (!isRecord(raw)) {
      issues.push(`chapters[${position}] must be an object`);
      return;
    }
    const id = text(raw.id) ?? `c${position + 1}`;
    if (ids.has(id)) {
      issues.push(`chapter id "${id}" is used more than once`);
      return;
    }
    ids.add(id);
    const title = text(raw.title);
    if (!title) issues.push(`chapter ${id} needs a title`);
    const unknown: string[] = [];
    const files: ReviewChapter['files'] = [];
    const seen = new Set<string>();
    for (const entry of asArray(raw.files, `chapter ${id} files`, issues)) {
      const rawPath =
        typeof entry === 'string' ? entry : isRecord(entry) ? text(entry.path) : undefined;
      if (!rawPath) continue;
      const path = normalizeReviewPath(rawPath, diff.repoPath);
      const file = findDiffFile(diff.files, path);
      if (!file) {
        unknown.push(rawPath);
        continue;
      }
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push({ path: file.path, additions: file.additions, deletions: file.deletions });
    }
    if (unknown.length > 0) {
      issues.push(
        `chapter ${id} lists files that are not in this diff: ${unknown.slice(0, 6).join(', ')}`,
      );
    }
    chapters.push({
      id,
      index: chapters.length + 1,
      title: title ?? '',
      summary: text(raw.summary) ?? '',
      files,
    });
  });
  return chapters;
}

export function normalizeRisks(
  rawRisks: unknown,
  chapters: readonly ReviewChapter[],
  issues: string[],
): ReviewRisk[] {
  const chapterIds = new Set(chapters.map((chapter) => chapter.id));
  const risks: ReviewRisk[] = [];
  const list = asArray(rawRisks, 'risks', issues);
  if (list.length > 10) issues.push('risks: publish at most 10 (only 3 are shown inline)');
  list.slice(0, 10).forEach((raw, position) => {
    if (!isRecord(raw)) {
      issues.push(`risks[${position}] must be an object`);
      return;
    }
    const id = text(raw.id) ?? `r${position + 1}`;
    const title = text(raw.title);
    if (!title) {
      issues.push(`risk ${id} needs a title`);
      return;
    }
    const chapterId = text(raw.chapterId);
    if (chapterId && !chapterIds.has(chapterId)) {
      issues.push(`risk ${id} references unknown chapter "${chapterId}"`);
    }
    risks.push({
      id,
      title,
      severity: parseSeverity(raw.severity) ?? 'medium',
      ...(chapterId ? { chapterId } : {}),
    });
  });
  return risks;
}

export interface NormalizeFindingOptions {
  diff: ReviewDiffContext;
  chapters: readonly ReviewChapter[];
  fallbackId: string;
  /** Trust the existing anchor (updates that don't move the finding). */
  skipAnchor?: boolean;
}

export interface NormalizedFinding {
  finding?: ReviewFinding;
  issues: string[];
  /** Anchoring failures, reported together so the agent can fix them in one go. */
  anchorIssue?: string;
}

function validateSuggestedPatch(patch: string, filePath: string): string | null {
  const files = parseUnifiedDiff(patch);
  if (files.length === 0 || files.every((file) => file.hunks.length === 0)) {
    return 'suggestedPatch must be a unified diff with at least one @@ hunk';
  }
  const foreign = files.map((file) => file.path).filter((path) => path && path !== filePath);
  if (foreign.length > 0) {
    return `suggestedPatch may only touch ${filePath} (it touches ${foreign.join(', ')})`;
  }
  return null;
}

export function normalizeFinding(
  raw: unknown,
  options: NormalizeFindingOptions,
): NormalizedFinding {
  const issues: string[] = [];
  if (!isRecord(raw)) return { issues: ['finding must be an object'] };
  const id = text(raw.id) ?? options.fallbackId;
  const where = `finding ${id}`;
  const title = text(raw.title);
  if (!title) issues.push(`${where} needs a one-line title`);
  const rationale = text(raw.rationale) ?? text(raw.description);
  if (!rationale) issues.push(`${where} needs a rationale`);
  const severity = parseSeverity(raw.severity);
  if (!severity) issues.push(`${where} severity must be one of ${REVIEW_SEVERITIES.join(', ')}`);
  const statusRaw = raw.status === undefined ? 'open' : raw.status;
  const status = REVIEW_FINDING_STATUSES.includes(statusRaw as ReviewFindingStatus)
    ? (statusRaw as ReviewFindingStatus)
    : undefined;
  if (!status) issues.push(`${where} status must be one of ${REVIEW_FINDING_STATUSES.join(', ')}`);

  const rawPath = text(raw.filePath) ?? text(raw.path);
  const lineStart = toInt(raw.lineStart) ?? toInt(raw.line);
  const lineEnd = toInt(raw.lineEnd) ?? lineStart;
  let anchorIssue: string | undefined;
  let filePath = rawPath ? normalizeReviewPath(rawPath, options.diff.repoPath) : '';
  if (options.skipAnchor && rawPath && lineStart !== undefined && lineEnd !== undefined) {
    // Already anchored (unmoved update): keep as is.
  } else if (!rawPath) {
    anchorIssue = `${id}: needs a filePath — every finding must be pinned to a changed file`;
  } else if (lineStart === undefined || lineEnd === undefined) {
    anchorIssue = `${id} (${filePath}): needs lineStart/lineEnd — unanchored line claims are not accepted`;
  } else {
    const file = findDiffFile(options.diff.files, filePath);
    if (!file) {
      anchorIssue = `${id} (${filePath}): file is not part of this diff`;
    } else {
      filePath = file.path;
      const reason = checkLineAnchor(file, lineStart, lineEnd);
      if (reason) anchorIssue = `${id} (${filePath}:${lineStart}-${lineEnd}): ${reason}`;
    }
  }

  const suggestedPatch =
    typeof raw.suggestedPatch === 'string' && raw.suggestedPatch.trim()
      ? raw.suggestedPatch
      : undefined;
  if (suggestedPatch && filePath) {
    const patchIssue = validateSuggestedPatch(suggestedPatch, filePath);
    if (patchIssue) issues.push(`${where}: ${patchIssue}`);
  }

  let chapterId = text(raw.chapterId);
  if (chapterId && !options.chapters.some((chapter) => chapter.id === chapterId)) {
    issues.push(`${where} references unknown chapter "${chapterId}"`);
  }
  if (!chapterId && filePath) {
    chapterId = options.chapters.find((chapter) =>
      chapter.files.some((file) => file.path === filePath),
    )?.id;
  }

  if (issues.length > 0 || anchorIssue || !severity || !status || !title || !rationale) {
    return { issues, anchorIssue };
  }
  const finding: ReviewFinding = {
    id,
    severity,
    category: text(raw.category) ?? 'General',
    title,
    rationale,
    filePath,
    lineStart: lineStart as number,
    lineEnd: lineEnd as number,
    status,
  };
  const suggestion = text(raw.suggestion);
  if (suggestion) finding.suggestion = suggestion;
  if (suggestedPatch) finding.suggestedPatch = suggestedPatch;
  if (chapterId) finding.chapterId = chapterId;
  const dismissReason = text(raw.dismissReason);
  if (dismissReason) finding.dismissReason = dismissReason;
  const fixedInSurfaceId = text(raw.fixedInSurfaceId);
  if (fixedInSurfaceId) finding.fixedInSurfaceId = fixedInSurfaceId;
  const fixNote = text(raw.fixNote);
  if (fixNote) finding.fixNote = fixNote;
  return { finding, issues };
}

function anchorSummary(anchorIssues: string[], scope: ReviewScope): string {
  return (
    `${anchorIssues.length} finding(s) are not anchored to the ${scope.type} diff. ` +
    'Line numbers are new-file lines inside a changed hunk (see the @@ headers in review_context). ' +
    'Fix the ranges, or drop claims you cannot pin to the diff, then call again:'
  );
}

export function normalizeFindings(
  rawFindings: unknown,
  diff: ReviewDiffContext,
  chapters: readonly ReviewChapter[],
  issues: string[],
  anchorIssues: string[],
  existingIds: Iterable<string> = [],
): ReviewFinding[] {
  const ids = new Set(existingIds);
  const findings: ReviewFinding[] = [];
  const list = asArray(rawFindings, 'findings', issues);
  if (list.length + ids.size > MAX_FINDINGS) {
    issues.push(`a review holds at most ${MAX_FINDINGS} findings`);
  }
  let counter = ids.size;
  list.forEach((raw) => {
    counter += 1;
    let fallback = `f${counter}`;
    while (ids.has(fallback)) fallback = `${fallback}_`;
    const result = normalizeFinding(raw, { diff, chapters, fallbackId: fallback });
    issues.push(...result.issues);
    if (result.anchorIssue) anchorIssues.push(result.anchorIssue);
    if (!result.finding) return;
    if (ids.has(result.finding.id)) {
      issues.push(`finding id "${result.finding.id}" is used more than once`);
      return;
    }
    ids.add(result.finding.id);
    findings.push(result.finding);
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Hunks, verdict, full payload
// ---------------------------------------------------------------------------

export function buildFindingHunks(
  files: readonly ParsedDiffFile[],
  findings: readonly Pick<ReviewFinding, 'filePath' | 'lineStart' | 'lineEnd'>[],
): Record<string, ReviewHunk[]> {
  const byPath = new Map<string, Array<[number, number]>>();
  for (const finding of findings) {
    const ranges = byPath.get(finding.filePath) ?? [];
    ranges.push([finding.lineStart, finding.lineEnd]);
    byPath.set(finding.filePath, ranges);
  }
  const hunks: Record<string, ReviewHunk[]> = {};
  for (const [path, ranges] of byPath) {
    const file = findDiffFile(files, path);
    if (!file) continue;
    const extracted = extractHunksAroundRanges(file, ranges);
    if (extracted.length > 0) hunks[file.path] = extracted;
  }
  return hunks;
}

export function buildFullDiff(files: readonly ParsedDiffFile[]): {
  fullDiff?: Record<string, ReviewHunk[]>;
  omitted: boolean;
} {
  const fullDiff: Record<string, ReviewHunk[]> = {};
  for (const file of files) {
    if (file.hunks.length > 0) fullDiff[file.path] = file.hunks;
  }
  return hunksSize(fullDiff) <= FULL_DIFF_BUDGET ? { fullDiff, omitted: false } : { omitted: true };
}

function parseVerdict(
  raw: unknown,
  findings: readonly ReviewFinding[],
  issues: string[],
): ReviewVerdict {
  if (raw === undefined || raw === null) return reconcileVerdict(undefined, findings);
  if (!isRecord(raw)) {
    issues.push('verdict must be an object with decision and summary');
    return reconcileVerdict(undefined, findings);
  }
  const summary = text(raw.summary);
  const decisionRaw = raw.decision;
  if (decisionRaw === undefined) {
    const computed = reconcileVerdict(undefined, findings);
    return summary ? { ...computed, summary, source: 'agent' } : computed;
  }
  if (!REVIEW_DECISIONS.includes(decisionRaw as ReviewDecision)) {
    issues.push(`verdict.decision must be one of ${REVIEW_DECISIONS.join(', ')}`);
    return reconcileVerdict(undefined, findings);
  }
  const decision = decisionRaw as ReviewDecision;
  if (!isDecisionConsistent(decision, findings)) {
    issues.push(
      `verdict.decision '${decision}' is inconsistent with the findings' severities; use ${describeDecisionBounds(findings)} (or omit decision to let Mezair compute it)`,
    );
  }
  return {
    decision,
    summary: summary ?? defaultVerdictSummary(decision, findings),
    source: 'agent',
  };
}

export interface ReviewPublishInput {
  verdict?: unknown;
  chapters?: unknown;
  findings?: unknown;
  risks?: unknown;
}

export function buildReviewSurfaceData(
  input: ReviewPublishInput,
  diff: ReviewDiffContext,
): ReviewSurfaceData {
  const issues: string[] = [];
  const anchorIssues: string[] = [];
  const chapters = normalizeChapters(input.chapters, diff, issues);
  const risks = normalizeRisks(input.risks, chapters, issues);
  const findings = normalizeFindings(input.findings, diff, chapters, issues, anchorIssues);
  if (anchorIssues.length > 0)
    throw new ReviewInputError(anchorIssues, anchorSummary(anchorIssues, diff.scope));
  const verdict = parseVerdict(input.verdict, findings, issues);
  if (issues.length > 0) throw new ReviewInputError(issues, 'The review payload is invalid:');

  const files = diffFileStats(diff.files);
  const { fullDiff, omitted } = buildFullDiff(diff.files);
  const data: ReviewSurfaceData = {
    scope: diff.scope,
    verdict,
    stats: {
      files: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    },
    risks,
    chapters,
    findings,
    files,
    hunks: buildFindingHunks(diff.files, findings),
  };
  if (fullDiff) data.fullDiff = fullDiff;
  if (omitted) data.fullDiffOmitted = true;
  if (diff.notes?.length) data.notes = [...diff.notes];
  return data;
}

// ---------------------------------------------------------------------------
// Status changes and patch operations
// ---------------------------------------------------------------------------

export interface StatusExtras {
  dismissReason?: string;
  fixedInSurfaceId?: string;
  fixNote?: string;
}

export function setFindingStatus(
  data: ReviewSurfaceData,
  findingIds: readonly string[],
  status: ReviewFindingStatus,
  extras: StatusExtras = {},
): ReviewSurfaceData {
  const ids = new Set(findingIds);
  const findings = data.findings.map((finding) => {
    if (!ids.has(finding.id)) return finding;
    const next: ReviewFinding = { ...finding, status };
    if (status === 'dismissed') {
      if (extras.dismissReason) next.dismissReason = extras.dismissReason;
    } else {
      delete next.dismissReason;
    }
    if (status === 'fixed') {
      if (extras.fixedInSurfaceId) next.fixedInSurfaceId = extras.fixedInSurfaceId;
      if (extras.fixNote) next.fixNote = extras.fixNote;
    } else if (status === 'open') {
      delete next.fixedInSurfaceId;
      delete next.fixNote;
    }
    return next;
  });
  return { ...data, findings, verdict: reconcileVerdict(data.verdict, findings) };
}

export type ReviewPatchOp =
  | { op: 'add_finding'; finding: unknown }
  | { op: 'set_status'; findingIds: string[]; status: ReviewFindingStatus; reason?: string }
  | { op: 'update_finding'; findingId: string; changes: Raw }
  | { op: 'link_fix'; findingIds: string[]; surfaceId?: string; note?: string }
  | { op: 'set_verdict'; decision?: ReviewDecision; summary?: string }
  | { op: 'add_chapter'; chapter: unknown }
  | { op: 'set_risks'; risks: unknown };

export const REVIEW_PATCH_OPS = [
  'add_finding',
  'set_status',
  'update_finding',
  'link_fix',
  'set_verdict',
  'add_chapter',
  'set_risks',
] as const;

/** Whether applying these ops needs the scope diff (anchoring new or moved findings). */
export function opsNeedDiff(ops: readonly unknown[]): boolean {
  return ops.some(
    (op) =>
      isRecord(op) &&
      (op.op === 'add_finding' ||
        op.op === 'add_chapter' ||
        (op.op === 'update_finding' &&
          isRecord(op.changes) &&
          ['filePath', 'lineStart', 'lineEnd', 'suggestedPatch'].some(
            (key) => (op.changes as Raw)[key] !== undefined,
          ))),
  );
}

function stringIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim());
  return ids.length === value.length && ids.length > 0 ? ids : undefined;
}

const UPDATABLE_FIELDS = [
  'severity',
  'category',
  'title',
  'rationale',
  'filePath',
  'lineStart',
  'lineEnd',
  'suggestion',
  'suggestedPatch',
  'chapterId',
] as const;

export function applyReviewOps(
  data: ReviewSurfaceData,
  ops: readonly unknown[],
  diff?: ReviewDiffContext,
): ReviewSurfaceData {
  const issues: string[] = [];
  const anchorIssues: string[] = [];
  let next: ReviewSurfaceData = {
    ...data,
    findings: [...data.findings],
    chapters: [...data.chapters],
  };
  const touchedPaths = new Set<string>();
  let explicitVerdict: ReviewDecision | undefined;
  const diffContext: ReviewDiffContext = diff ?? { scope: data.scope, files: [] };

  const requireIds = (ids: string[] | undefined, label: string): string[] | null => {
    if (!ids) {
      issues.push(`${label}: findingIds must be a non-empty array of ids`);
      return null;
    }
    const unknown = ids.filter((id) => !next.findings.some((finding) => finding.id === id));
    if (unknown.length > 0) {
      issues.push(`${label}: unknown finding id(s) ${unknown.join(', ')}`);
      return null;
    }
    return ids;
  };

  ops.forEach((rawOp, position) => {
    const label = `ops[${position}]`;
    if (!isRecord(rawOp) || typeof rawOp.op !== 'string') {
      issues.push(`${label} must be an object with an "op" field`);
      return;
    }
    switch (rawOp.op) {
      case 'add_finding': {
        const added = normalizeFindings(
          [rawOp.finding],
          diffContext,
          next.chapters,
          issues,
          anchorIssues,
          next.findings.map((finding) => finding.id),
        );
        for (const finding of added) {
          next.findings.push(finding);
          touchedPaths.add(finding.filePath);
        }
        break;
      }
      case 'set_status': {
        const ids = requireIds(stringIds(rawOp.findingIds), label);
        const status = rawOp.status as ReviewFindingStatus;
        if (!REVIEW_FINDING_STATUSES.includes(status)) {
          issues.push(`${label}: status must be one of ${REVIEW_FINDING_STATUSES.join(', ')}`);
          break;
        }
        if (ids) next = setFindingStatus(next, ids, status, { dismissReason: text(rawOp.reason) });
        break;
      }
      case 'link_fix': {
        const ids = requireIds(stringIds(rawOp.findingIds), label);
        if (ids) {
          next = setFindingStatus(next, ids, 'fixed', {
            fixedInSurfaceId: text(rawOp.surfaceId),
            fixNote: text(rawOp.note),
          });
        }
        break;
      }
      case 'update_finding': {
        const id = text(rawOp.findingId);
        const index = next.findings.findIndex((finding) => finding.id === id);
        if (!id || index < 0) {
          issues.push(`${label}: unknown findingId ${String(rawOp.findingId)}`);
          break;
        }
        if (!isRecord(rawOp.changes)) {
          issues.push(`${label}: changes must be an object`);
          break;
        }
        const current = next.findings[index];
        const merged: Raw = { ...current };
        for (const key of UPDATABLE_FIELDS) {
          if (rawOp.changes[key] !== undefined) merged[key] = rawOp.changes[key];
        }
        const moved = ['filePath', 'lineStart', 'lineEnd', 'suggestedPatch'].some(
          (key) => rawOp.changes && (rawOp.changes as Raw)[key] !== undefined,
        );
        const result = normalizeFinding(merged, {
          diff: diffContext,
          chapters: next.chapters,
          fallbackId: id,
          skipAnchor: !moved,
        });
        issues.push(...result.issues);
        if (result.anchorIssue) anchorIssues.push(result.anchorIssue);
        if (!result.finding) break;
        const updated: ReviewFinding = {
          ...result.finding,
          ...(current.workItem ? { workItem: current.workItem } : {}),
          ...(current.prCommentUrl ? { prCommentUrl: current.prCommentUrl } : {}),
        };
        next.findings[index] = updated;
        touchedPaths.add(current.filePath);
        touchedPaths.add(updated.filePath);
        break;
      }
      case 'set_verdict': {
        const decision = rawOp.decision as ReviewDecision | undefined;
        if (decision !== undefined && !REVIEW_DECISIONS.includes(decision)) {
          issues.push(`${label}: decision must be one of ${REVIEW_DECISIONS.join(', ')}`);
          break;
        }
        const summary = text(rawOp.summary);
        if (decision) explicitVerdict = decision;
        const base = decision ?? next.verdict.decision;
        next.verdict = {
          decision: base,
          summary: summary ?? defaultVerdictSummary(base, next.findings),
          source: decision || summary ? 'agent' : 'computed',
        };
        break;
      }
      case 'add_chapter': {
        const [chapter] = normalizeChapters([rawOp.chapter], diffContext, issues);
        if (!chapter) break;
        const id =
          text(isRecord(rawOp.chapter) ? rawOp.chapter.id : undefined) ??
          `c${next.chapters.length + 1}`;
        if (next.chapters.some((existing) => existing.id === id)) {
          issues.push(`${label}: chapter id "${id}" already exists`);
          break;
        }
        next.chapters.push({ ...chapter, id, index: next.chapters.length + 1 });
        break;
      }
      case 'set_risks': {
        next.risks = normalizeRisks(rawOp.risks, next.chapters, issues);
        break;
      }
      default:
        issues.push(`${label}: unknown op "${rawOp.op}" (use ${REVIEW_PATCH_OPS.join(', ')})`);
    }
  });

  if (anchorIssues.length > 0)
    throw new ReviewInputError(anchorIssues, anchorSummary(anchorIssues, data.scope));
  if (explicitVerdict && !isDecisionConsistent(explicitVerdict, next.findings)) {
    issues.push(
      `verdict '${explicitVerdict}' is inconsistent with the findings' severities; use ${describeDecisionBounds(next.findings)}`,
    );
  }
  if (issues.length > 0) throw new ReviewInputError(issues, 'The review patch was rejected:');

  next.verdict = reconcileVerdict(next.verdict, next.findings);
  if (touchedPaths.size > 0 && diff && diff.files.length > 0) {
    const hunks = { ...next.hunks };
    for (const path of touchedPaths) delete hunks[path];
    const rebuilt = buildFindingHunks(
      diff.files,
      next.findings.filter((finding) => touchedPaths.has(finding.filePath)),
    );
    next.hunks = { ...hunks, ...rebuilt };
  }
  return next;
}

export function describeFindingForAgent(finding: ReviewFinding): string {
  return `${finding.id} [${finding.severity}] ${formatFindingLocation(finding)} — ${finding.title}`;
}
