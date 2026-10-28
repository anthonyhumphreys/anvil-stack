// Script-free share snapshot for the Dependencies surface.
import {
  DEPENDENCY_MANAGERS,
  packageKey,
  topRiskPackages,
  worstSeverity,
  type DependenciesSurfaceData,
  type DependencyPackage,
} from '../../../../shared/surfaces/kinds/dependencies.js';
import type { ShareSnapshot } from '../../types.js';
import {
  SHARE_BASE_CSS,
  assertScriptFree,
  escapeHtml,
  htmlTable,
  severityBadge,
  wrapSnapshot,
} from '../data/share-kit.js';

const SNAPSHOT_MAX_ROWS = 1000;

function licenseCell(pkg: DependencyPackage): string {
  const label = escapeHtml(pkg.license ?? 'Unknown');
  if (pkg.licenseStatus === 'restricted')
    return `<span class="sev-high">▲ ${label} (restricted)</span>`;
  if (pkg.licenseStatus === 'unknown' || !pkg.license) return `<span class="muted">${label}</span>`;
  return label;
}

function riskCell(pkg: DependencyPackage): string {
  const worst = worstSeverity(pkg);
  if (!worst) return '<span class="muted">—</span>';
  const count = pkg.vulnerabilities?.length ?? 0;
  return `${severityBadge(worst)} <span class="muted">${count} advisor${count === 1 ? 'y' : 'ies'}</span>`;
}

export function dependenciesSnapshot(data: DependenciesSurfaceData, title: string): ShareSnapshot {
  const { summary } = data;
  const counts = DEPENDENCY_MANAGERS.filter((manager) => summary.byManager[manager])
    .map((manager) => `<li>${escapeHtml(manager)}: ${summary.byManager[manager]}</li>`)
    .join('');
  const facts = `<ul class="counts"><li>${summary.total} packages</li><li>${summary.direct} direct</li><li>${summary.vulnerablePackages} vulnerable</li><li>${summary.restrictedLicenses ?? 0} restricted licences</li>${counts}</ul>`;
  const risks = topRiskPackages(data.packages, 10);
  const riskTable =
    risks.length > 0
      ? `<h2 class="meta">Top risks</h2>${htmlTable(
          [
            {
              label: 'Package',
              cell: (pkg) =>
                `<code>${escapeHtml(packageKey(pkg))}@${escapeHtml(pkg.version)}</code>`,
            },
            { label: 'Risk', cell: riskCell },
            {
              label: 'Fix',
              cell: (pkg) =>
                escapeHtml(
                  (pkg.vulnerabilities ?? [])
                    .map((vulnerability) => vulnerability.fixedIn)
                    .filter(Boolean)
                    .join(', '),
                ),
            },
          ],
          risks,
        )}`
      : '';
  const rows = data.packages.slice(0, SNAPSHOT_MAX_ROWS);
  const table = htmlTable(
    [
      { label: 'Package', cell: (pkg) => `<code>${escapeHtml(pkg.name)}</code>` },
      { label: 'Version', cell: (pkg) => `<code>${escapeHtml(pkg.version)}</code>` },
      { label: 'Manager', cell: (pkg) => escapeHtml(pkg.manager) },
      { label: 'Direct', cell: (pkg) => (pkg.direct ? 'Direct' : 'Transitive') },
      { label: 'Licence', cell: licenseCell },
      { label: 'Vulnerabilities', cell: riskCell },
    ],
    rows,
  );
  const omitted =
    data.packages.length > rows.length
      ? `<p class="muted">${data.packages.length - rows.length} more packages not included.</p>`
      : '';
  const meta = `${data.repoName ?? 'Repository'} · ${summary.audits.length ? `audited ${summary.audits.map((audit) => audit.manager).join(', ')}` : 'not audited'}`;
  const html = wrapSnapshot(title, meta, `${facts}${riskTable}${table}${omitted}`);
  assertScriptFree(html);
  return { html, css: SHARE_BASE_CSS };
}
