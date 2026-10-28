// Maps persisted security audit data onto the Findings surface payload.
import type { SecurityAudit, SecurityFinding } from '../../../../shared/types.js';
import {
  FINDINGS_MAX_ITEMS,
  SURFACE_SEVERITIES,
  type FindingsSurfaceData,
  type SurfaceFinding,
  type SurfaceSeverity,
} from '../../../../shared/surfaces/kinds/findings.js';

const TITLE_MAX = 160;

export function normalizeSeverity(value: unknown): SurfaceSeverity {
  const lower = String(value ?? '').toLowerCase();
  if (lower === 'moderate') return 'medium';
  if (lower === 'informational' || lower === 'none') return 'info';
  return (SURFACE_SEVERITIES as readonly string[]).includes(lower)
    ? (lower as SurfaceSeverity)
    : 'info';
}

export function firstLine(text: string, max = TITLE_MAX): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find(Boolean) ?? '';
  const cleaned = line.replace(/^#+\s*/, '').replace(/\*\*/g, '');
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned || 'Finding';
}

/** "src/a.ts:12-18" → path + lines. */
export function parseFileReference(value: string): {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(value.trim());
  if (!match) return { filePath: value.trim() };
  const lineStart = Number(match[2]);
  const lineEnd = match[3] ? Number(match[3]) : undefined;
  return {
    filePath: match[1],
    lineStart: lineStart > 0 ? lineStart : undefined,
    lineEnd: lineEnd && lineEnd >= lineStart ? lineEnd : undefined,
  };
}

export function mapSecurityFinding(finding: SecurityFinding): SurfaceFinding {
  const [primary, ...others] = finding.affectedFiles.filter(Boolean);
  const location = primary ? parseFileReference(primary) : undefined;
  const refs = [finding.owaspRef, finding.cweRef].filter((ref): ref is string => Boolean(ref));
  const detail =
    others.length > 0
      ? `${finding.description}\n\nAlso affects: ${others.join(', ')}`
      : finding.description;
  return {
    id: finding.id,
    severity: normalizeSeverity(finding.severity),
    title: firstLine(finding.description),
    detail: detail.slice(0, 20000),
    category: finding.category?.slice(0, 200) || undefined,
    ...(location?.filePath ? { filePath: location.filePath.slice(0, 1000) } : {}),
    ...(location?.lineStart ? { lineStart: location.lineStart } : {}),
    ...(location?.lineEnd ? { lineEnd: location.lineEnd } : {}),
    ...(finding.remediation ? { recommendation: finding.remediation.slice(0, 10000) } : {}),
    status: finding.dismissed ? 'dismissed' : 'open',
    ...(finding.workItemId ? { workItemId: finding.workItemId } : {}),
    ...(refs.length > 0 ? { refs } : {}),
  };
}

export function buildSecurityFindingsData(
  audit: SecurityAudit,
  findings: readonly SecurityFinding[],
  repoName: string,
): FindingsSurfaceData {
  return {
    source: 'security-audit',
    repoId: audit.repoId,
    title: `Security audit · ${repoName}`,
    ...(audit.summary ? { summary: audit.summary.slice(0, 4000) } : {}),
    auditId: audit.id,
    auditStatus: audit.status,
    ...(audit.scope.length > 0 ? { scope: audit.scope.slice(0, 20) } : {}),
    findings: findings.slice(0, FINDINGS_MAX_ITEMS).map(mapSecurityFinding),
  };
}
