// Script-free share snapshot for the Findings surface: severity counts, a
// table, and one <details> per finding with its detail and recommendation.
import {
  FINDING_STATUS_LABELS,
  SEVERITY_LABELS,
  SURFACE_SEVERITIES,
  countBySeverity,
  findingLocation,
  isActiveFinding,
  sortFindings,
  type FindingsSurfaceData,
} from '../../../../shared/surfaces/kinds/findings.js';
import type { ShareSnapshot } from '../../types.js';
import {
  SEVERITY_TEXT_GLYPHS,
  SHARE_BASE_CSS,
  assertScriptFree,
  escapeHtml,
  htmlTable,
  redactPath,
  severityBadge,
  wrapSnapshot,
} from '../data/share-kit.js';

const SNAPSHOT_MAX_FINDINGS = 500;

export function redactFindings(data: FindingsSurfaceData, repoRoot?: string): FindingsSurfaceData {
  return {
    ...data,
    findings: data.findings.map((finding) => {
      const filePath = redactPath(finding.filePath, repoRoot);
      return { ...finding, ...(filePath ? { filePath } : {}) };
    }),
  };
}

export function findingsSnapshot(data: FindingsSurfaceData, title: string): ShareSnapshot {
  const findings = sortFindings(data.findings);
  const shown = findings.slice(0, SNAPSHOT_MAX_FINDINGS);
  const counts = countBySeverity(findings.filter(isActiveFinding));
  const countList = `<ul class="counts" aria-label="Active findings by severity">${SURFACE_SEVERITIES.map(
    (severity) =>
      `<li class="sev-${severity}"><span aria-hidden="true">${SEVERITY_TEXT_GLYPHS[severity]}</span> ${counts[severity]} ${escapeHtml(SEVERITY_LABELS[severity])}</li>`,
  ).join('')}</ul>`;

  const table = htmlTable(
    [
      { label: 'Severity', cell: (finding) => severityBadge(finding.severity) },
      { label: 'Finding', cell: (finding) => escapeHtml(finding.title) },
      {
        label: 'Location',
        cell: (finding) => {
          const location = findingLocation(finding);
          return location ? `<code>${escapeHtml(location)}</code>` : '<span class="muted">—</span>';
        },
      },
      { label: 'Category', cell: (finding) => escapeHtml(finding.category ?? '') },
      { label: 'Status', cell: (finding) => escapeHtml(FINDING_STATUS_LABELS[finding.status]) },
    ],
    shown,
  );

  const details = shown
    .map((finding) => {
      const location = findingLocation(finding);
      return `<details><summary>${severityBadge(finding.severity)} · ${escapeHtml(finding.title)}</summary>${
        location ? `<p class="mono">${escapeHtml(location)}</p>` : ''
      }<p>${escapeHtml(finding.detail)}</p>${
        finding.recommendation
          ? `<p><strong>Recommendation.</strong> ${escapeHtml(finding.recommendation)}</p>`
          : ''
      }${finding.refs?.length ? `<p class="muted">${escapeHtml(finding.refs.join(' · '))}</p>` : ''}</details>`;
    })
    .join('');

  const omitted =
    findings.length > shown.length
      ? `<p class="muted">${findings.length - shown.length} more findings not included.</p>`
      : '';
  const meta = [
    data.source.replace('-', ' '),
    `${findings.length} findings`,
    data.scope?.length ? data.scope.join(', ') : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = `${data.summary ? `<p>${escapeHtml(data.summary)}</p>` : ''}${countList}${table}${omitted}<section aria-label="Finding details">${details}</section>`;
  const html = wrapSnapshot(title, meta, body);
  assertScriptFree(html);
  return { html, css: SHARE_BASE_CSS };
}
