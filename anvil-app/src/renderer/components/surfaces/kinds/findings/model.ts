import {
  findingLocation,
  isActiveFinding,
  severityRank,
  sortFindings,
  type FindingStatus,
  type FindingsSurfaceData,
  type SurfaceFinding,
  type SurfaceSeverity,
} from '../../../../../shared/surfaces/kinds/findings';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import { matchesQuery } from '../../shared-ui/table-model';

export type FindingsStatusFilter = FindingStatus | 'all' | 'active';

export interface FindingsFilter {
  query: string;
  severities: ReadonlySet<SurfaceSeverity>;
  status: FindingsStatusFilter;
  category: string;
}

export const DEFAULT_FINDINGS_FILTER: FindingsFilter = {
  query: '',
  severities: new Set(),
  status: 'active',
  category: 'all',
};

export function readFindingsData(data: unknown): FindingsSurfaceData {
  const value = (data ?? {}) as Partial<FindingsSurfaceData>;
  return {
    source: value.source ?? 'custom',
    title: value.title ?? 'Findings',
    ...value,
    findings: Array.isArray(value.findings) ? value.findings : [],
  } as FindingsSurfaceData;
}

export function filterFindings(
  findings: readonly SurfaceFinding[],
  filter: FindingsFilter,
): SurfaceFinding[] {
  return sortFindings(findings).filter((finding) => {
    if (filter.severities.size > 0 && !filter.severities.has(finding.severity)) return false;
    if (filter.status === 'active' && !isActiveFinding(finding)) return false;
    if (filter.status !== 'active' && filter.status !== 'all' && finding.status !== filter.status) {
      return false;
    }
    if (filter.category !== 'all' && (finding.category ?? '') !== filter.category) return false;
    return matchesQuery(filter.query, [
      finding.title,
      finding.detail,
      finding.category,
      finding.filePath,
      finding.package,
      finding.id,
      ...(finding.refs ?? []),
    ]);
  });
}

export function findingCategories(findings: readonly SurfaceFinding[]): string[] {
  return Array.from(
    new Set(
      findings
        .map((finding) => finding.category)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

export function topActiveFindings(
  findings: readonly SurfaceFinding[],
  limit = 5,
): SurfaceFinding[] {
  return sortFindings(findings.filter(isActiveFinding)).slice(0, limit);
}

export function findingAnchor(finding: SurfaceFinding): SurfaceAnchor {
  return {
    type: 'finding',
    targetId: finding.id,
    ...(finding.filePath ? { filePath: finding.filePath } : {}),
    ...(finding.lineStart ? { lineStart: finding.lineStart } : {}),
    ...(finding.lineEnd ? { lineEnd: finding.lineEnd } : {}),
    label: `${finding.title}${findingLocation(finding) ? ` · ${findingLocation(finding)}` : ''}`,
  };
}

export function severitySortValue(finding: SurfaceFinding): number {
  return severityRank(finding.severity);
}

/** Selected ids that can still take an action (not dismissed/fixed). */
export function actionableIds(
  findings: readonly SurfaceFinding[],
  ids: ReadonlySet<string>,
): string[] {
  return findings
    .filter(
      (finding) =>
        ids.has(finding.id) && finding.status !== 'dismissed' && finding.status !== 'fixed',
    )
    .map((finding) => finding.id);
}
