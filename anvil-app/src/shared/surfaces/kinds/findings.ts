// Findings surface (§8.3): one surface for security audits, dependency audits,
// BA findings and agent-authored findings. Process-neutral: types, schema,
// actions, anchors and digest.
import type { JsonSchema, SurfaceKindDefinition } from '../types.js';

export type SurfaceSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SURFACE_SEVERITIES: readonly SurfaceSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

export const SEVERITY_LABELS: Record<SurfaceSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

export type FindingsSource = 'security-audit' | 'dependency-audit' | 'ba' | 'custom';
export type FindingStatus = 'open' | 'dismissed' | 'fix-requested' | 'fixed';
export const FINDING_STATUSES: readonly FindingStatus[] = [
  'open',
  'fix-requested',
  'fixed',
  'dismissed',
];
export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  open: 'Open',
  'fix-requested': 'Fix requested',
  fixed: 'Fixed',
  dismissed: 'Dismissed',
};

export interface SurfaceFinding {
  id: string;
  severity: SurfaceSeverity;
  title: string;
  detail: string;
  category?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  package?: string;
  recommendation?: string;
  status: FindingStatus;
  workItemId?: string;
  /** Extra references (OWASP, CWE, advisory ids). */
  refs?: string[];
}

export interface FindingsAuditProgress {
  message: string;
  percent: number;
}

export interface FindingsSurfaceData {
  source: FindingsSource;
  repoId?: string;
  title: string;
  summary?: string;
  /** Persisted security audit backing this surface. */
  auditId?: string;
  /** Present while a backing audit runs (security_audit_run). */
  auditStatus?: 'running' | 'completed' | 'failed';
  progress?: FindingsAuditProgress;
  /** Audit scope, e.g. OWASP Top 10. */
  scope?: string[];
  findings: SurfaceFinding[];
}

export type FindingsActionId = 'dismiss' | 'ask_fix' | 'create_work_items';

export const FINDINGS_MAX_ITEMS = 2000;

const severitySchema: JsonSchema = { type: 'string', enum: SURFACE_SEVERITIES };

export const findingSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'severity', 'title', 'detail', 'status'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    severity: severitySchema,
    title: { type: 'string', minLength: 1, maxLength: 400 },
    detail: { type: 'string', maxLength: 20000 },
    category: { type: 'string', maxLength: 200 },
    filePath: { type: 'string', maxLength: 1000 },
    lineStart: { type: 'integer', minimum: 1 },
    lineEnd: { type: 'integer', minimum: 1 },
    package: { type: 'string', maxLength: 300 },
    recommendation: { type: 'string', maxLength: 10000 },
    status: { type: 'string', enum: FINDING_STATUSES },
    workItemId: { type: 'string', maxLength: 200 },
    refs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
  },
  additionalProperties: false,
};

export const findingsSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['source', 'title', 'findings'],
  properties: {
    source: { type: 'string', enum: ['security-audit', 'dependency-audit', 'ba', 'custom'] },
    repoId: { type: 'string', maxLength: 200 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    summary: { type: 'string', maxLength: 4000 },
    auditId: { type: 'string', maxLength: 200 },
    auditStatus: { type: 'string', enum: ['running', 'completed', 'failed'] },
    progress: {
      type: 'object',
      required: ['message', 'percent'],
      properties: {
        message: { type: 'string', maxLength: 500 },
        percent: { type: 'number', minimum: 0, maximum: 100 },
      },
      additionalProperties: false,
    },
    scope: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 200 } },
    findings: { type: 'array', maxItems: FINDINGS_MAX_ITEMS, items: findingSchema },
  },
  additionalProperties: false,
};

export type SeverityCounts = Record<SurfaceSeverity, number>;

export function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

export function countBySeverity(
  findings: readonly { severity: SurfaceSeverity }[],
): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export function severityRank(severity: SurfaceSeverity): number {
  return SURFACE_SEVERITIES.indexOf(severity);
}

/** Open first, then by severity, then title. Stable for equal keys. */
export function sortFindings<T extends SurfaceFinding>(findings: readonly T[]): T[] {
  const statusRank = (status: FindingStatus) =>
    status === 'dismissed' || status === 'fixed' ? 1 : 0;
  return [...findings].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      a.title.localeCompare(b.title),
  );
}

export function isActiveFinding(finding: SurfaceFinding): boolean {
  return finding.status === 'open' || finding.status === 'fix-requested';
}

export function findingLocation(finding: SurfaceFinding): string | undefined {
  if (!finding.filePath) return finding.package;
  if (!finding.lineStart) return finding.filePath;
  const range =
    finding.lineEnd && finding.lineEnd !== finding.lineStart
      ? `${finding.lineStart}-${finding.lineEnd}`
      : String(finding.lineStart);
  return `${finding.filePath}:${range}`;
}

export function formatSeverityCounts(counts: SeverityCounts): string {
  const parts = SURFACE_SEVERITIES.filter((severity) => counts[severity] > 0).map(
    (severity) => `${counts[severity]} ${severity}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'none';
}

const DIGEST_TOP = 5;

export function digestFindings(data: FindingsSurfaceData): string {
  const active = data.findings.filter(isActiveFinding);
  const lines: string[] = [];
  const header = `${data.title} (${data.source}${data.repoId ? `, repo ${data.repoId}` : ''})`;
  lines.push(header);
  if (data.auditStatus === 'running') {
    lines.push(
      `Audit running${data.auditId ? ` (${data.auditId})` : ''}: ${data.progress?.message ?? 'starting'} ${Math.round(data.progress?.percent ?? 0)}%`,
    );
  } else if (data.auditStatus === 'failed') {
    lines.push(`Audit failed${data.summary ? `: ${data.summary}` : ''}`);
  }
  const dismissed = data.findings.filter((finding) => finding.status === 'dismissed').length;
  const fixed = data.findings.filter((finding) => finding.status === 'fixed').length;
  lines.push(
    `${data.findings.length} findings; active ${active.length} (${formatSeverityCounts(countBySeverity(active))})` +
      (dismissed ? `; ${dismissed} dismissed` : '') +
      (fixed ? `; ${fixed} fixed` : ''),
  );
  for (const finding of sortFindings(active).slice(0, DIGEST_TOP)) {
    const location = findingLocation(finding);
    lines.push(
      `- [${finding.severity}] ${finding.id}: ${finding.title}${location ? ` @ ${location}` : ''}`,
    );
  }
  if (active.length > DIGEST_TOP) lines.push(`… ${active.length - DIGEST_TOP} more active`);
  return lines.join('\n');
}

export const findingsSurfaceKind: SurfaceKindDefinition<FindingsSurfaceData> = {
  kind: 'findings',
  label: 'Findings',
  schema: findingsSurfaceSchema,
  actions: {
    dismiss: {
      label: 'Dismiss',
      semantics: { type: 'anvil-command', command: 'findings.dismiss' },
      shortcut: 'd',
      targets: 'many',
    },
    ask_fix: {
      label: 'Ask agent to fix',
      semantics: {
        type: 'agent-message',
        template: 'Please fix these findings from "{title}":\n{targets}',
      },
      shortcut: 'f',
      targets: 'many',
    },
    create_work_items: {
      label: 'Create work items',
      semantics: { type: 'mutation', command: 'findings.create-work-items', approval: true },
      targets: 'many',
    },
  },
  anchors: ['surface', 'finding'],
  digest: digestFindings,
  shareable: true,
};
