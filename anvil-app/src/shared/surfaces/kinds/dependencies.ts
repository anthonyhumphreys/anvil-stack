// Dependencies surface (§8.5): dependency table with audit and licence overlays.
import type { JsonSchema, SurfaceKindDefinition } from '../types.js';
import {
  SURFACE_SEVERITIES,
  severityRank,
  type SurfaceSeverity,
  countBySeverity,
  formatSeverityCounts,
} from './findings.js';

export type DependencyManager = 'npm' | 'pnpm' | 'yarn' | 'nuget' | 'python';
export const DEPENDENCY_MANAGERS: readonly DependencyManager[] = [
  'npm',
  'pnpm',
  'yarn',
  'nuget',
  'python',
];

export interface DependencyVulnerability {
  id: string;
  severity: SurfaceSeverity;
  title: string;
  fixedIn?: string;
  url?: string;
}

export type LicenseStatus = 'allowed' | 'restricted' | 'unknown';

export interface DependencyPackage {
  name: string;
  version: string;
  manager: DependencyManager;
  direct: boolean;
  license?: string;
  licenseStatus?: LicenseStatus;
  deprecated?: boolean;
  alternative?: string;
  vulnerabilities?: DependencyVulnerability[];
  workItemId?: string;
}

export interface DependencyAuditRun {
  manager: DependencyManager;
  ranAt: string;
  ok: boolean;
  vulnerabilityCount: number;
  error?: string;
  /** Caveat about what the manager's audit can report. */
  note?: string;
}

export interface DependenciesSummary {
  total: number;
  direct: number;
  vulnerablePackages: number;
  vulnerabilities: number;
  restrictedLicenses: number;
  unknownLicenses: number;
  deprecated: number;
  byManager: Partial<Record<DependencyManager, number>>;
  audits: DependencyAuditRun[];
  licensesCheckedAt?: string;
  generatedAt: string;
}

export interface DependenciesSurfaceData {
  repoId: string;
  repoName?: string;
  managers: DependencyManager[];
  packages: DependencyPackage[];
  summary: DependenciesSummary;
}

export type DependenciesActionId = 'ask_upgrade' | 'create_work_items';

export const DEPENDENCIES_MAX_PACKAGES = 5000;

const managerSchema: JsonSchema = { type: 'string', enum: DEPENDENCY_MANAGERS };

const vulnerabilitySchema: JsonSchema = {
  type: 'object',
  required: ['id', 'severity', 'title'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    severity: { type: 'string', enum: SURFACE_SEVERITIES },
    title: { type: 'string', maxLength: 500 },
    fixedIn: { type: 'string', maxLength: 200 },
    url: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
};

const packageSchema: JsonSchema = {
  type: 'object',
  required: ['name', 'version', 'manager', 'direct'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 300 },
    version: { type: 'string', maxLength: 200 },
    manager: managerSchema,
    direct: { type: 'boolean' },
    license: { type: 'string', maxLength: 300 },
    licenseStatus: { type: 'string', enum: ['allowed', 'restricted', 'unknown'] },
    deprecated: { type: 'boolean' },
    alternative: { type: 'string', maxLength: 300 },
    vulnerabilities: { type: 'array', maxItems: 200, items: vulnerabilitySchema },
    workItemId: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
};

const countSchema: JsonSchema = { type: 'integer', minimum: 0 };

export const dependenciesSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['repoId', 'managers', 'packages', 'summary'],
  properties: {
    repoId: { type: 'string', minLength: 1, maxLength: 200 },
    repoName: { type: 'string', maxLength: 300 },
    managers: { type: 'array', maxItems: 10, items: managerSchema },
    packages: { type: 'array', maxItems: DEPENDENCIES_MAX_PACKAGES, items: packageSchema },
    summary: {
      type: 'object',
      required: ['total', 'direct', 'vulnerablePackages', 'byManager', 'audits', 'generatedAt'],
      properties: {
        total: countSchema,
        direct: countSchema,
        vulnerablePackages: countSchema,
        vulnerabilities: countSchema,
        restrictedLicenses: countSchema,
        unknownLicenses: countSchema,
        deprecated: countSchema,
        byManager: { type: 'object', additionalProperties: countSchema },
        audits: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            required: ['manager', 'ranAt', 'ok', 'vulnerabilityCount'],
            properties: {
              manager: managerSchema,
              ranAt: { type: 'string' },
              ok: { type: 'boolean' },
              vulnerabilityCount: countSchema,
              error: { type: 'string', maxLength: 1000 },
              note: { type: 'string', maxLength: 500 },
            },
            additionalProperties: false,
          },
        },
        licensesCheckedAt: { type: 'string' },
        generatedAt: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Licence policy (default; strong copyleft and source-available terms need review)
// ---------------------------------------------------------------------------

const RESTRICTED_LICENSE_PATTERNS: readonly RegExp[] = [
  /\bAGPL/i,
  /(^|[^L])GPL/i,
  /\bSSPL/i,
  /\bBUSL|Business Source/i,
  /Commons[- ]Clause/i,
  /\bCC-BY-NC/i,
  /\bEUPL/i,
  /\bOSL-/i,
];

export function classifyLicense(license: string | undefined): LicenseStatus {
  const value = license?.trim();
  if (!value || /^(UNKNOWN|NOASSERTION|UNLICENSED|SEE LICENSE IN)/i.test(value)) return 'unknown';
  // "MIT OR GPL-3.0" lets the consumer pick the permissive option.
  const alternatives = value.replace(/[()]/g, '').split(/\s+OR\s+/i);
  const allRestricted = alternatives.every((option) =>
    RESTRICTED_LICENSE_PATTERNS.some((pattern) => pattern.test(option)),
  );
  return allRestricted ? 'restricted' : 'allowed';
}

export function packageKey(pkg: Pick<DependencyPackage, 'manager' | 'name'>): string {
  return `${pkg.manager}:${pkg.name}`;
}

export function worstSeverity(pkg: DependencyPackage): SurfaceSeverity | undefined {
  let worst: SurfaceSeverity | undefined;
  for (const vulnerability of pkg.vulnerabilities ?? []) {
    if (!worst || severityRank(vulnerability.severity) < severityRank(worst)) {
      worst = vulnerability.severity;
    }
  }
  return worst;
}

/** Higher = riskier. Vulnerabilities dominate, then restricted licences, then deprecation. */
export function packageRiskScore(pkg: DependencyPackage): number {
  const worst = worstSeverity(pkg);
  let score = worst ? (5 - severityRank(worst)) * 100 + (pkg.vulnerabilities?.length ?? 0) : 0;
  if (pkg.licenseStatus === 'restricted') score += 50;
  if (pkg.deprecated) score += 10;
  if (pkg.direct && score > 0) score += 1;
  return score;
}

export function topRiskPackages(
  packages: readonly DependencyPackage[],
  limit: number,
): DependencyPackage[] {
  return packages
    .map((pkg) => ({ pkg, score: packageRiskScore(pkg) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.pkg.name.localeCompare(b.pkg.name))
    .slice(0, limit)
    .map((entry) => entry.pkg);
}

export function summarizeDependencies(
  packages: readonly DependencyPackage[],
  previous: Pick<DependenciesSummary, 'audits' | 'licensesCheckedAt'> = { audits: [] },
  now = new Date().toISOString(),
): DependenciesSummary {
  const byManager: Partial<Record<DependencyManager, number>> = {};
  let vulnerablePackages = 0;
  let vulnerabilities = 0;
  for (const pkg of packages) {
    byManager[pkg.manager] = (byManager[pkg.manager] ?? 0) + 1;
    const count = pkg.vulnerabilities?.length ?? 0;
    if (count > 0) vulnerablePackages += 1;
    vulnerabilities += count;
  }
  return {
    total: packages.length,
    direct: packages.filter((pkg) => pkg.direct).length,
    vulnerablePackages,
    vulnerabilities,
    restrictedLicenses: packages.filter((pkg) => pkg.licenseStatus === 'restricted').length,
    unknownLicenses: packages.filter((pkg) => pkg.licenseStatus === 'unknown').length,
    deprecated: packages.filter((pkg) => pkg.deprecated).length,
    byManager,
    audits: previous.audits,
    ...(previous.licensesCheckedAt ? { licensesCheckedAt: previous.licensesCheckedAt } : {}),
    generatedAt: now,
  };
}

const DIGEST_TOP = 6;

export function digestDependencies(data: DependenciesSurfaceData): string {
  const { summary } = data;
  const managers = DEPENDENCY_MANAGERS.filter((manager) => summary.byManager[manager])
    .map((manager) => `${manager} ${summary.byManager[manager]}`)
    .join(', ');
  const lines = [
    `Dependencies for ${data.repoName ?? data.repoId}: ${summary.total} packages (${summary.direct} direct)${managers ? ` · ${managers}` : ''}`,
  ];
  const audited = summary.audits.map(
    (audit) => `${audit.manager} ${audit.ok ? `${audit.vulnerabilityCount} vulns` : 'failed'}`,
  );
  lines.push(
    audited.length > 0 ? `Audits: ${audited.join(', ')}` : 'Audits: not run (call deps_audit)',
  );
  if (summary.vulnerablePackages > 0) {
    const allVulns = data.packages.flatMap((pkg) => pkg.vulnerabilities ?? []);
    lines.push(
      `${summary.vulnerablePackages} vulnerable packages, ${summary.vulnerabilities} advisories (${formatSeverityCounts(countBySeverity(allVulns))})`,
    );
  }
  lines.push(
    summary.licensesCheckedAt
      ? `Licences: ${summary.restrictedLicenses ?? 0} restricted, ${summary.unknownLicenses ?? 0} unknown`
      : 'Licences: not checked (call deps_licenses)',
  );
  for (const pkg of topRiskPackages(data.packages, DIGEST_TOP)) {
    const worst = worstSeverity(pkg);
    const reasons = [
      worst ? `${pkg.vulnerabilities?.length} vulns, worst ${worst}` : undefined,
      pkg.licenseStatus === 'restricted' ? `licence ${pkg.license}` : undefined,
      pkg.deprecated ? 'deprecated' : undefined,
    ].filter(Boolean);
    lines.push(`- ${packageKey(pkg)}@${pkg.version}: ${reasons.join('; ')}`);
  }
  return lines.join('\n');
}

export const dependenciesSurfaceKind: SurfaceKindDefinition<DependenciesSurfaceData> = {
  kind: 'dependencies',
  label: 'Dependencies',
  schema: dependenciesSurfaceSchema,
  actions: {
    ask_upgrade: {
      label: 'Ask agent to upgrade',
      semantics: {
        type: 'agent-message',
        template:
          'Please upgrade these dependencies in repo {repoId} and verify the build:\n{targets}',
      },
      shortcut: 'u',
      targets: 'many',
    },
    create_work_items: {
      label: 'Create work items',
      semantics: { type: 'mutation', command: 'dependencies.create-work-items', approval: true },
      targets: 'many',
    },
  },
  anchors: ['surface', 'row'],
  digest: digestDependencies,
  feature: 'dependencies',
  wide: true,
  shareable: true,
};
