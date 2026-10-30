import {
  packageKey,
  packageRiskScore,
  worstSeverity,
  type DependenciesSurfaceData,
  type DependencyManager,
  type DependencyPackage,
} from '../../../../../shared/surfaces/kinds/dependencies';
import { severityRank } from '../../../../../shared/surfaces/kinds/findings';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import { matchesQuery } from '../../shared-ui/table-model';

export type DependencyRiskFilter =
  'all' | 'vulnerable' | 'restricted' | 'unknown-license' | 'deprecated' | 'any-risk';
export type DependencyScopeFilter = 'all' | 'direct' | 'transitive';

export interface DependenciesFilter {
  query: string;
  manager: DependencyManager | 'all';
  risk: DependencyRiskFilter;
  scope: DependencyScopeFilter;
}

export const DEFAULT_DEPENDENCIES_FILTER: DependenciesFilter = {
  query: '',
  manager: 'all',
  risk: 'all',
  scope: 'all',
};

export function readDependenciesData(data: unknown): DependenciesSurfaceData {
  const value = (data ?? {}) as Partial<DependenciesSurfaceData>;
  const packages = Array.isArray(value.packages) ? value.packages : [];
  return {
    repoId: value.repoId ?? '',
    ...value,
    managers: Array.isArray(value.managers) ? value.managers : [],
    packages,
    summary: value.summary ?? {
      total: packages.length,
      direct: packages.filter((pkg) => pkg.direct).length,
      vulnerablePackages: 0,
      vulnerabilities: 0,
      restrictedLicenses: 0,
      unknownLicenses: 0,
      deprecated: 0,
      byManager: {},
      audits: [],
      generatedAt: '',
    },
  } as DependenciesSurfaceData;
}

export function matchesRisk(pkg: DependencyPackage, risk: DependencyRiskFilter): boolean {
  switch (risk) {
    case 'vulnerable':
      return (pkg.vulnerabilities?.length ?? 0) > 0;
    case 'restricted':
      return pkg.licenseStatus === 'restricted';
    case 'unknown-license':
      return pkg.licenseStatus === 'unknown';
    case 'deprecated':
      return Boolean(pkg.deprecated);
    case 'any-risk':
      return packageRiskScore(pkg) > 0;
    default:
      return true;
  }
}

export function filterPackages(
  packages: readonly DependencyPackage[],
  filter: DependenciesFilter,
): DependencyPackage[] {
  return packages.filter((pkg) => {
    if (filter.manager !== 'all' && pkg.manager !== filter.manager) return false;
    if (filter.scope === 'direct' && !pkg.direct) return false;
    if (filter.scope === 'transitive' && pkg.direct) return false;
    if (!matchesRisk(pkg, filter.risk)) return false;
    return matchesQuery(filter.query, [
      pkg.name,
      pkg.version,
      pkg.license,
      ...(pkg.vulnerabilities ?? []).flatMap((vulnerability) => [
        vulnerability.id,
        vulnerability.title,
      ]),
    ]);
  });
}

export function riskSortValue(pkg: DependencyPackage): number {
  // Riskiest first under ascending sort.
  return -packageRiskScore(pkg);
}

export function vulnerabilitySortValue(pkg: DependencyPackage): number | null {
  const worst = worstSeverity(pkg);
  return worst ? severityRank(worst) * 1000 - (pkg.vulnerabilities?.length ?? 0) : null;
}

export function fixVersions(pkg: DependencyPackage): string {
  return Array.from(
    new Set(
      (pkg.vulnerabilities ?? []).map((vulnerability) => vulnerability.fixedIn).filter(Boolean),
    ),
  ).join(', ');
}

export function packageAnchor(pkg: DependencyPackage): SurfaceAnchor {
  return {
    type: 'row',
    targetId: packageKey(pkg),
    label: `${pkg.name}@${pkg.version} (${pkg.manager})`,
  };
}

export function riskReasons(pkg: DependencyPackage): string[] {
  const reasons: string[] = [];
  const count = pkg.vulnerabilities?.length ?? 0;
  if (count > 0) reasons.push(`${count} advisor${count === 1 ? 'y' : 'ies'}`);
  if (pkg.licenseStatus === 'restricted')
    reasons.push(`Restricted licence ${pkg.license ?? ''}`.trim());
  if (pkg.deprecated)
    reasons.push(pkg.alternative ? `Deprecated (try ${pkg.alternative})` : 'Deprecated');
  return reasons;
}

export { packageKey, worstSeverity };
