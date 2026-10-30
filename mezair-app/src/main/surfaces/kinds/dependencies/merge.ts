// Builds and merges the Dependencies surface payload from the dependency
// list, audit overlays and licence overlays.
import type { DependencyRecord, LicenseAuditResult } from '../../../../shared/types.js';
import {
  DEPENDENCIES_MAX_PACKAGES,
  DEPENDENCY_MANAGERS,
  classifyLicense,
  packageKey,
  summarizeDependencies,
  type DependenciesSurfaceData,
  type DependencyAuditRun,
  type DependencyManager,
  type DependencyPackage,
} from '../../../../shared/surfaces/kinds/dependencies.js';
import type { ParsedAudit } from './audit-parse.js';

const JS_MANAGERS: ReadonlySet<DependencyManager> = new Set(['npm', 'pnpm', 'yarn']);

function sameFamily(a: DependencyManager, b: DependencyManager): boolean {
  return a === b || (JS_MANAGERS.has(a) && JS_MANAGERS.has(b));
}

function managersOf(packages: readonly DependencyPackage[]): DependencyManager[] {
  const present = new Set(packages.map((pkg) => pkg.manager));
  return DEPENDENCY_MANAGERS.filter((manager) => present.has(manager));
}

function sortPackages(packages: DependencyPackage[]): DependencyPackage[] {
  return packages.sort((a, b) => packageKey(a).localeCompare(packageKey(b)));
}

function finalize(
  base: Pick<DependenciesSurfaceData, 'repoId' | 'repoName'>,
  packages: DependencyPackage[],
  previous: Pick<DependenciesSurfaceData['summary'], 'audits' | 'licensesCheckedAt'>,
): DependenciesSurfaceData {
  const trimmed = sortPackages(packages).slice(0, DEPENDENCIES_MAX_PACKAGES);
  return {
    repoId: base.repoId,
    ...(base.repoName ? { repoName: base.repoName } : {}),
    managers: managersOf(trimmed),
    packages: trimmed,
    summary: summarizeDependencies(trimmed, previous),
  };
}

export function recordToPackage(record: DependencyRecord): DependencyPackage {
  const license = record.license && record.license !== 'UNKNOWN' ? record.license : undefined;
  return {
    name: record.name,
    version: record.version || 'unknown',
    manager: record.manager,
    // listDependencies reads manifests (package.json, *.csproj, requirements.txt): all direct.
    direct: true,
    ...(license ? { license, licenseStatus: classifyLicense(license) } : {}),
    ...(record.deprecated ? { deprecated: true } : {}),
    ...(record.alternative ? { alternative: record.alternative } : {}),
  };
}

/**
 * Fresh dependency list merged over an existing payload: audit and licence
 * overlays carry over for packages that are still present; transitive
 * packages that only came from an audit are kept.
 */
export function mergeDependencyList(
  repo: { repoId: string; repoName?: string },
  records: readonly DependencyRecord[],
  previous?: DependenciesSurfaceData | null,
): DependenciesSurfaceData {
  const prior = new Map((previous?.packages ?? []).map((pkg) => [packageKey(pkg), pkg]));
  const next = new Map<string, DependencyPackage>();
  for (const record of records) {
    const pkg = recordToPackage(record);
    const old = prior.get(packageKey(pkg));
    next.set(packageKey(pkg), {
      ...pkg,
      ...(old?.vulnerabilities?.length ? { vulnerabilities: old.vulnerabilities } : {}),
      ...(!pkg.license && old?.license
        ? { license: old.license, licenseStatus: old.licenseStatus }
        : {}),
      ...(old?.workItemId ? { workItemId: old.workItemId } : {}),
    });
  }
  for (const pkg of previous?.packages ?? []) {
    if (!pkg.direct && !next.has(packageKey(pkg))) next.set(packageKey(pkg), pkg);
  }
  return finalize(repo, [...next.values()], previous?.summary ?? { audits: [] });
}

export function applyAudit(
  data: DependenciesSurfaceData,
  manager: DependencyManager,
  audit: ParsedAudit | { error: string },
  ranAt = new Date().toISOString(),
): DependenciesSurfaceData {
  const run: DependencyAuditRun =
    'error' in audit
      ? { manager, ranAt, ok: false, vulnerabilityCount: 0, error: audit.error.slice(0, 1000) }
      : {
          manager,
          ranAt,
          ok: !audit.unparsed,
          vulnerabilityCount: audit.packages.reduce(
            (sum, pkg) => sum + pkg.vulnerabilities.length,
            0,
          ),
          ...(audit.unparsed ? { error: 'Audit output could not be parsed.' } : {}),
          ...(audit.note ? { note: audit.note } : {}),
        };
  const audits = [...data.summary.audits.filter((entry) => entry.manager !== manager), run];
  if ('error' in audit || audit.unparsed) {
    return finalize(data, [...data.packages], { ...data.summary, audits });
  }

  // Clear this manager family's previous advisories, then overlay the new ones.
  const packages = data.packages.map((pkg) =>
    sameFamily(pkg.manager, manager) && pkg.vulnerabilities
      ? { ...pkg, vulnerabilities: undefined }
      : pkg,
  );
  const byName = new Map<string, number>();
  packages.forEach((pkg, index) => {
    if (sameFamily(pkg.manager, manager)) byName.set(pkg.name, index);
  });
  const familyManager =
    packages.find((pkg) => sameFamily(pkg.manager, manager))?.manager ?? manager;
  for (const entry of audit.packages) {
    const index = byName.get(entry.name);
    if (index !== undefined) {
      const pkg = packages[index];
      packages[index] = {
        ...pkg,
        vulnerabilities: entry.vulnerabilities.slice(0, 200),
        ...(pkg.version === 'unknown' && entry.version ? { version: entry.version } : {}),
      };
    } else {
      byName.set(entry.name, packages.length);
      packages.push({
        name: entry.name,
        version: entry.version ?? 'unknown',
        manager: familyManager,
        direct: entry.direct ?? false,
        vulnerabilities: entry.vulnerabilities.slice(0, 200),
      });
    }
  }
  const cleaned = packages.map((pkg) => {
    if (pkg.vulnerabilities !== undefined) return pkg;
    const rest = { ...pkg };
    delete rest.vulnerabilities;
    return rest;
  });
  return finalize(data, cleaned, { ...data.summary, audits });
}

export function applyLicenses(
  data: DependenciesSurfaceData,
  result: LicenseAuditResult,
): DependenciesSurfaceData {
  const licenses = new Map(
    result.packages.map((record) => [packageKey(record), record.license ?? 'UNKNOWN']),
  );
  const packages = data.packages.map((pkg) => {
    const license = licenses.get(packageKey(pkg)) ?? pkg.license;
    const known = license && license !== 'UNKNOWN' ? license : undefined;
    return {
      ...pkg,
      ...(known ? { license: known } : {}),
      licenseStatus: classifyLicense(known),
    };
  });
  return finalize(data, packages, { ...data.summary, licensesCheckedAt: result.generatedAt });
}
