// Pure review rules shared by main (validation, digest) and the renderer
// (labels, grouping). The verdict is computed from severities, never free text.

import type {
  ReviewDecision,
  ReviewFinding,
  ReviewFindingStatus,
  ReviewScope,
  ReviewSeverity,
  ReviewSurfaceData,
  ReviewVerdict,
} from './types.js';

export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export const REVIEW_DECISIONS: readonly ReviewDecision[] = [
  'ship',
  'ship-with-fixes',
  'needs-work',
  'blocked',
];

export const REVIEW_FINDING_STATUSES: readonly ReviewFindingStatus[] = [
  'open',
  'accepted',
  'dismissed',
  'fix-requested',
  'fixed',
];

export const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export const STATUS_LABEL: Record<ReviewFindingStatus, string> = {
  open: 'Open',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  'fix-requested': 'Fix requested',
  fixed: 'Fixed',
};

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  ship: 'Ship',
  'ship-with-fixes': 'Ship with fixes',
  'needs-work': 'Needs work',
  blocked: 'Blocked',
};

export function severityRank(severity: ReviewSeverity): number {
  return REVIEW_SEVERITIES.indexOf(severity);
}

export function decisionRank(decision: ReviewDecision): number {
  return REVIEW_DECISIONS.indexOf(decision);
}

/** Findings that still bear on the verdict (dismissed and fixed ones don't). */
export function isActiveFinding(finding: Pick<ReviewFinding, 'status'>): boolean {
  return finding.status !== 'dismissed' && finding.status !== 'fixed';
}

export type SeverityCounts = Record<ReviewSeverity, number>;

export function countSeverities(
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
  options: { activeOnly?: boolean } = {},
): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    if (options.activeOnly && !isActiveFinding(finding)) continue;
    counts[finding.severity] += 1;
  }
  return counts;
}

/** Active findings that must be fixed before shipping (critical, high, medium). */
export function countBlockingFixes(
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): number {
  const counts = countSeverities(findings, { activeOnly: true });
  return counts.critical + counts.high + counts.medium;
}

export interface DecisionBounds {
  min: ReviewDecision;
  max: ReviewDecision;
  suggested: ReviewDecision;
}

/**
 * Which decisions the active findings support:
 * - any critical → needs work … blocked (suggest blocked)
 * - any high → ship with fixes … needs work (suggest needs work from 3 highs)
 * - any medium → ship … ship with fixes (suggest ship with fixes)
 * - only low/info → ship … ship with fixes (suggest ship)
 * - nothing active → ship
 */
export function decisionBounds(
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): DecisionBounds {
  const counts = countSeverities(findings, { activeOnly: true });
  if (counts.critical > 0) return { min: 'needs-work', max: 'blocked', suggested: 'blocked' };
  if (counts.high > 0) {
    return {
      min: 'ship-with-fixes',
      max: 'needs-work',
      suggested: counts.high > 2 ? 'needs-work' : 'ship-with-fixes',
    };
  }
  if (counts.medium > 0)
    return { min: 'ship', max: 'ship-with-fixes', suggested: 'ship-with-fixes' };
  if (counts.low + counts.info > 0)
    return { min: 'ship', max: 'ship-with-fixes', suggested: 'ship' };
  return { min: 'ship', max: 'ship', suggested: 'ship' };
}

export function computeDecision(
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): ReviewDecision {
  return decisionBounds(findings).suggested;
}

export function isDecisionConsistent(
  decision: ReviewDecision,
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): boolean {
  const bounds = decisionBounds(findings);
  const rank = decisionRank(decision);
  return rank >= decisionRank(bounds.min) && rank <= decisionRank(bounds.max);
}

export function clampDecision(
  decision: ReviewDecision,
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): ReviewDecision {
  const bounds = decisionBounds(findings);
  const rank = decisionRank(decision);
  if (rank < decisionRank(bounds.min)) return bounds.min;
  if (rank > decisionRank(bounds.max)) return bounds.max;
  return decision;
}

export function describeDecisionBounds(
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): string {
  const bounds = decisionBounds(findings);
  return bounds.min === bounds.max
    ? `'${bounds.min}'`
    : REVIEW_DECISIONS.slice(decisionRank(bounds.min), decisionRank(bounds.max) + 1)
        .map((decision) => `'${decision}'`)
        .join(' or ');
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** "Ship", "Ship after 2 fixes", "Needs work", "Blocked". */
export function verdictHeadline(
  decision: ReviewDecision,
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): string {
  if (decision === 'ship-with-fixes') {
    const fixes =
      countBlockingFixes(findings) || countSeverities(findings, { activeOnly: true }).low;
    return fixes > 0 ? `Ship after ${plural(fixes, 'fix', 'fixes')}` : 'Ship with fixes';
  }
  return DECISION_LABEL[decision];
}

export function defaultVerdictSummary(
  decision: ReviewDecision,
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): string {
  const counts = countSeverities(findings, { activeOnly: true });
  switch (decision) {
    case 'blocked':
      return `${plural(counts.critical, 'critical finding')} must be resolved before this can merge.`;
    case 'needs-work':
      return counts.critical > 0
        ? `${plural(counts.critical, 'critical finding')} need attention before merge.`
        : `${plural(counts.high, 'high-severity finding')} need rework before merge.`;
    case 'ship-with-fixes': {
      const fixes = countBlockingFixes(findings);
      return fixes > 0
        ? `Good to merge once ${plural(fixes, 'finding')} ${fixes === 1 ? 'is' : 'are'} addressed.`
        : 'Good to merge after a few small clean-ups.';
    }
    case 'ship':
      return counts.low + counts.info > 0
        ? 'Good to merge; the remaining notes are optional.'
        : 'Good to merge; nothing stood out.';
  }
}

/** Keeps computed verdicts in step with statuses; clamps agent verdicts into range. */
export function reconcileVerdict(
  verdict: ReviewVerdict | undefined,
  findings: readonly Pick<ReviewFinding, 'severity' | 'status'>[],
): ReviewVerdict {
  if (!verdict || verdict.source === 'computed') {
    const decision = computeDecision(findings);
    return { decision, summary: defaultVerdictSummary(decision, findings), source: 'computed' };
  }
  const decision = clampDecision(verdict.decision, findings);
  if (decision === verdict.decision) return verdict;
  return { decision, summary: defaultVerdictSummary(decision, findings), source: 'computed' };
}

export function formatFindingLocation(
  finding: Pick<ReviewFinding, 'filePath' | 'lineStart' | 'lineEnd'>,
): string {
  return finding.lineEnd > finding.lineStart
    ? `${finding.filePath}:${finding.lineStart}-${finding.lineEnd}`
    : `${finding.filePath}:${finding.lineStart}`;
}

export function describeReviewScope(scope: ReviewScope): string {
  switch (scope.type) {
    case 'turn':
      return 'this turn';
    case 'working-tree':
      return 'working tree';
    case 'pull-request':
      return scope.pullRequestId ? `PR #${scope.pullRequestId}` : 'pull request';
    case 'commit-range':
      return scope.ref ?? 'commit range';
  }
}

export function reviewSurfaceKey(
  scope: Pick<ReviewScope, 'type' | 'repoId' | 'ref' | 'pullRequestId'>,
): string {
  const suffix =
    scope.type === 'pull-request'
      ? `pull-request#${scope.pullRequestId ?? ''}`
      : scope.type === 'commit-range'
        ? `commit-range:${scope.ref ?? ''}`
        : scope.type;
  return `review:${scope.repoId}:${suffix}`;
}

/** "Review: ship after 2 fixes · 14 files +412 −97 · 3 risks · 9 findings (2 high)". */
export function buildReviewDigest(
  data: Pick<ReviewSurfaceData, 'verdict' | 'stats' | 'risks' | 'findings'>,
): string {
  const findings = data.findings ?? [];
  const decision = data.verdict?.decision ?? computeDecision(findings);
  const headline = verdictHeadline(decision, findings);
  const parts = [`Review: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}`];
  if (data.stats) {
    parts.push(
      `${plural(data.stats.files, 'file')} +${data.stats.additions} \u2212${data.stats.deletions}`,
    );
  }
  const risks = data.risks?.length ?? 0;
  if (risks > 0) parts.push(plural(risks, 'risk'));
  const counts = countSeverities(findings, { activeOnly: true });
  const active = findings.filter(isActiveFinding).length;
  const top = REVIEW_SEVERITIES.filter((severity) => severity !== 'info' && counts[severity] > 0)
    .slice(0, 2)
    .map((severity) => `${counts[severity]} ${severity}`);
  const findingPart = `${plural(findings.length, 'finding')}${top.length ? ` (${top.join(', ')})` : ''}`;
  parts.push(findingPart);
  const resolved = findings.length - active;
  if (resolved > 0) parts.push(`${resolved} resolved`);
  const ids = findings
    .filter(isActiveFinding)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 12)
    .map((finding) => `${finding.id} ${finding.severity} ${formatFindingLocation(finding)}`);
  const digest = parts.join(' \u00b7 ');
  return ids.length ? `${digest}\nActive: ${ids.join('; ')}` : digest;
}
