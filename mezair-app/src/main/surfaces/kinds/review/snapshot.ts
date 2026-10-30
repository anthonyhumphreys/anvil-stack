// Share support for the Review surface (spec §11.3, §11.5): redaction plus a
// static, script-free snapshot of the stage layout with light and dark tokens.

import { homedir } from 'node:os';
import {
  numberHunkLines,
  normalizeReviewPath,
} from '../../../../shared/surfaces/kinds/review/diff.js';
import {
  DECISION_LABEL,
  REVIEW_SEVERITIES,
  SEVERITY_LABEL,
  STATUS_LABEL,
  describeReviewScope,
  formatFindingLocation,
  severityRank,
  verdictHeadline,
} from '../../../../shared/surfaces/kinds/review/model.js';
import type {
  ReviewDecision,
  ReviewFinding,
  ReviewHunk,
  ReviewSeverity,
  ReviewSurfaceData,
} from '../../../../shared/surfaces/kinds/review/types.js';
import type { ShareSnapshot, ShareSnapshotOptions } from '../../types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubText(value: string, roots: string[]): string {
  let next = value;
  for (const root of roots) {
    if (!root || root === '/') continue;
    next = next.replace(new RegExp(`${escapeRegExp(root)}/?`, 'g'), '');
  }
  return next;
}

/**
 * Strips local context before sharing: absolute paths become repo-relative
 * (and the home directory disappears from prose). Dismiss reasons are kept in
 * the payload; the snapshot shows them only when comments are included.
 */
export function redactReviewData(data: ReviewSurfaceData, repoPath?: string): ReviewSurfaceData {
  const home = (() => {
    try {
      return homedir();
    } catch {
      return '';
    }
  })();
  const roots = [repoPath ?? '', home].filter(Boolean).sort((a, b) => b.length - a.length);
  const path = (value: string) => normalizeReviewPath(value, repoPath);
  const prose = (value: string | undefined) =>
    value === undefined ? undefined : scrubText(value, roots);
  const remap = (hunks: Record<string, ReviewHunk[]> | undefined) =>
    hunks
      ? Object.fromEntries(Object.entries(hunks).map(([key, value]) => [path(key), value]))
      : undefined;
  const findings = data.findings.map((finding) => {
    const next: ReviewFinding = {
      ...finding,
      filePath: path(finding.filePath),
      title: scrubText(finding.title, roots),
      rationale: scrubText(finding.rationale, roots),
    };
    if (finding.suggestion !== undefined) next.suggestion = prose(finding.suggestion);
    if (finding.dismissReason !== undefined) next.dismissReason = prose(finding.dismissReason);
    if (finding.fixNote !== undefined) next.fixNote = prose(finding.fixNote);
    return next;
  });
  const redacted: ReviewSurfaceData = {
    ...data,
    verdict: { ...data.verdict, summary: scrubText(data.verdict.summary, roots) },
    chapters: data.chapters.map((chapter) => ({
      ...chapter,
      summary: scrubText(chapter.summary, roots),
      files: chapter.files.map((file) => ({ ...file, path: path(file.path) })),
    })),
    files: data.files.map((file) => ({
      ...file,
      path: path(file.path),
      ...(file.previousPath ? { previousPath: path(file.previousPath) } : {}),
    })),
    findings,
    hunks: remap(data.hunks) ?? {},
  };
  if (data.fullDiff) redacted.fullDiff = remap(data.fullDiff);
  if (data.notes) redacted.notes = data.notes.map((note) => scrubText(note, roots));
  return redacted;
}

// ---------------------------------------------------------------------------
// Static markup
// ---------------------------------------------------------------------------

const SEVERITY_SHAPES: Record<ReviewSeverity, string> = {
  critical: '<polygon points="5,1 11,1 15,5 15,11 11,15 5,15 1,11 1,5" />',
  high: '<polygon points="8,1.5 15,14.5 1,14.5" />',
  medium: '<polygon points="8,1 15,8 8,15 1,8" />',
  low: '<circle cx="8" cy="8" r="5.5" />',
  info: '<circle cx="8" cy="8" r="6" fill="none" stroke-width="2" />',
};

const DECISION_SHAPES: Record<ReviewDecision, string> = {
  ship: '<circle cx="8" cy="8" r="7" /><path d="M4.5 8.2l2.3 2.3 4.7-4.9" class="ink" />',
  'ship-with-fixes': '<circle cx="8" cy="8" r="7" /><path d="M5 8h6" class="ink" />',
  'needs-work': '<polygon points="8,1 15,14.5 1,14.5" /><path d="M8 6v4" class="ink" />',
  blocked:
    '<polygon points="5,1 11,1 15,5 15,11 11,15 5,15 1,11 1,5" /><path d="M5.5 8h5" class="ink" />',
};

function glyph(shape: string, className: string): string {
  return `<svg class="glyph ${className}" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${shape}</svg>`;
}

function severityBadge(severity: ReviewSeverity): string {
  return `<span class="sev sev-${severity}">${glyph(SEVERITY_SHAPES[severity], `sev-${severity}`)}${SEVERITY_LABEL[severity]}</span>`;
}

function renderHunks(
  path: string,
  hunks: readonly ReviewHunk[],
  findings: readonly ReviewFinding[],
): string {
  const rows: string[] = [];
  for (const hunk of hunks) {
    rows.push(`<tr class="hunk"><td colspan="3">${escapeHtml(hunk.header)}</td></tr>`);
    for (const line of numberHunkLines(hunk)) {
      if (line.kind === 'note') continue;
      const anchorLine = line.newLine ?? line.oldLine;
      const marked = findings.some(
        (finding) =>
          finding.filePath === path &&
          anchorLine !== null &&
          anchorLine >= finding.lineStart &&
          anchorLine <= finding.lineEnd,
      );
      const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '\u2212' : ' ';
      rows.push(
        `<tr class="line ${line.kind}${marked ? ' marked' : ''}"><td class="num">${line.oldLine ?? ''}</td><td class="num">${line.newLine ?? ''}</td><td class="code"><span class="sign">${sign}</span>${escapeHtml(line.text) || ' '}</td></tr>`,
      );
      const ending = findings.filter(
        (finding) =>
          finding.filePath === path && line.newLine !== null && line.newLine === finding.lineEnd,
      );
      for (const finding of ending) {
        rows.push(
          `<tr class="callout"><td colspan="3">${severityBadge(finding.severity)} <span class="callout-title">${escapeHtml(finding.title)}</span> <span class="mono muted">${escapeHtml(finding.id)}</span></td></tr>`,
        );
      }
    }
  }
  return `<table class="diff" role="presentation">${rows.join('')}</table>`;
}

function renderFinding(finding: ReviewFinding, includeComments: boolean): string {
  const parts = [
    `<details class="finding" id="finding-${escapeHtml(finding.id)}">`,
    `<summary>${severityBadge(finding.severity)}<span class="mono loc">${escapeHtml(formatFindingLocation(finding))}</span><span class="finding-title">${escapeHtml(finding.title)}</span><span class="status status-${finding.status}">${STATUS_LABEL[finding.status]}</span></summary>`,
    '<div class="finding-body">',
    `<p class="meta">${escapeHtml(finding.category)}</p>`,
    `<p class="prose">${escapeHtml(finding.rationale)}</p>`,
  ];
  if (finding.suggestion) {
    parts.push(
      `<p class="label">Suggestion</p><p class="prose">${escapeHtml(finding.suggestion)}</p>`,
    );
  }
  if (finding.suggestedPatch) {
    parts.push(
      `<p class="label">Suggested patch</p><pre class="patch">${escapeHtml(finding.suggestedPatch.trimEnd())}</pre>`,
    );
  }
  if (finding.status === 'fixed' && finding.fixNote) {
    parts.push(`<p class="meta">Fixed · ${escapeHtml(finding.fixNote)}</p>`);
  }
  if (includeComments && finding.dismissReason) {
    parts.push(`<p class="meta">Dismissed · ${escapeHtml(finding.dismissReason)}</p>`);
  }
  parts.push('</div></details>');
  return parts.join('');
}

export function buildReviewSnapshot(
  data: ReviewSurfaceData,
  title: string,
  options: ShareSnapshotOptions,
): ShareSnapshot {
  const findings = [...data.findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.filePath.localeCompare(b.filePath) ||
      a.lineStart - b.lineStart,
  );
  const decision = data.verdict.decision;
  const facts = [
    `${data.stats.files} file${data.stats.files === 1 ? '' : 's'}`,
    `<span class="add">+${data.stats.additions}</span> <span class="del">\u2212${data.stats.deletions}</span>`,
    `${data.risks.length} risk${data.risks.length === 1 ? '' : 's'}`,
    `${data.findings.length} finding${data.findings.length === 1 ? '' : 's'}`,
  ];
  const html: string[] = [
    '<article class="review">',
    `<header><p class="eyebrow">Review · ${escapeHtml(describeReviewScope(data.scope))}</p><h1>${escapeHtml(title)}</h1></header>`,
    `<section class="verdict decision-${decision}"><p class="headline">${glyph(DECISION_SHAPES[decision], `decision-${decision}`)}<strong>${escapeHtml(verdictHeadline(decision, data.findings))}</strong><span class="muted"> · ${DECISION_LABEL[decision]}</span></p><p class="prose">${escapeHtml(data.verdict.summary)}</p><p class="facts">${facts.join(' · ')}</p></section>`,
  ];

  if (data.risks.length) {
    html.push('<section><h2>Risks</h2><ul class="risks">');
    for (const risk of data.risks.slice(0, 3)) {
      const chapter = data.chapters.find((entry) => entry.id === risk.chapterId);
      html.push(
        `<li>${severityBadge(risk.severity)}<span>${escapeHtml(risk.title)}</span>${chapter ? `<span class="muted"> · chapter ${chapter.index}</span>` : ''}</li>`,
      );
    }
    html.push('</ul></section>');
  }

  if (data.chapters.length) {
    html.push('<section><h2>The change</h2>');
    for (const chapter of data.chapters) {
      const count = data.findings.filter((finding) => finding.chapterId === chapter.id).length;
      html.push(
        `<details class="chapter" open><summary><span class="chapter-index">${chapter.index}</span><span class="chapter-title">${escapeHtml(chapter.title)}</span><span class="muted">${chapter.files.length} file${chapter.files.length === 1 ? '' : 's'}${count ? ` · ${count} finding${count === 1 ? '' : 's'}` : ''}</span></summary>`,
      );
      if (chapter.summary) html.push(`<p class="prose">${escapeHtml(chapter.summary)}</p>`);
      if (chapter.files.length) {
        html.push('<ul class="files">');
        for (const file of chapter.files) {
          html.push(
            `<li><span class="mono">${escapeHtml(file.path)}</span> <span class="add">+${file.additions}</span> <span class="del">\u2212${file.deletions}</span></li>`,
          );
        }
        html.push('</ul>');
      }
      html.push('</details>');
    }
    html.push('</section>');
  }

  html.push('<section><h2>Findings</h2>');
  if (!findings.length) html.push('<p class="muted">No findings.</p>');
  for (const severity of REVIEW_SEVERITIES) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (!group.length) continue;
    html.push(
      `<details class="group" open><summary>${severityBadge(severity)}<span class="muted">${group.length}</span></summary>${group
        .map((finding) => renderFinding(finding, options.includeComments))
        .join('')}</details>`,
    );
  }
  html.push('</section>');

  const diffSource = options.includeFullDiff && data.fullDiff ? data.fullDiff : data.hunks;
  const paths = Object.keys(diffSource);
  if (paths.length) {
    html.push(
      `<section><h2>${options.includeFullDiff && data.fullDiff ? 'Diff' : 'Diff around findings'}</h2>`,
    );
    for (const path of paths) {
      html.push(
        `<details class="file" open><summary class="mono">${escapeHtml(path)}</summary>${renderHunks(path, diffSource[path], data.findings)}</details>`,
      );
    }
    html.push('</section>');
  }
  html.push('</article>');
  return { html: html.join('\n'), css: REVIEW_SNAPSHOT_CSS };
}

export const REVIEW_SNAPSHOT_CSS = `
:root {
  color-scheme: light dark;
  --canvas: #fbfbfc; --surface: #ffffff; --raised: #f3f4f6; --border: #e2e4e9;
  --ink: #181b21; --ink-2: #3d4450; --ink-3: #5f6672;
  --accent: #4f46e5; --success: #15803d; --warning: #b45309; --info: #0369a1; --error: #dc2626;
  --add-bg: rgba(21, 128, 61, 0.1); --del-bg: rgba(220, 38, 38, 0.08);
  --sans: 'IBM Plex Sans', system-ui, sans-serif; --mono: 'IBM Plex Mono', ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0b1020; --surface: #111827; --raised: #172033; --border: #33415f;
    --ink: #f8fbff; --ink-2: #cbd6e6; --ink-3: #95a3b8;
    --accent: #ff8a3d; --success: #48d597; --warning: #ffd166; --info: #5ec8ff; --error: #ff6b8a;
    --add-bg: rgba(72, 213, 151, 0.1); --del-bg: rgba(255, 107, 138, 0.1);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 14px/1.65 var(--sans); }
.review { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 16px; font-weight: 600; line-height: 1.4; margin: 2px 0 0; }
h2 { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); margin: 28px 0 8px; }
p { margin: 4px 0; }
.prose { max-width: 72ch; color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.eyebrow, .meta, .label { font-size: 12px; color: var(--ink-3); margin: 0; }
.label { font-weight: 600; margin-top: 10px; }
.muted { color: var(--ink-3); font-size: 12px; }
.mono, .patch, .diff { font-family: var(--mono); }
.add { color: var(--success); } .del { color: var(--error); }
.verdict { margin-top: 16px; }
.headline { display: flex; align-items: center; gap: 8px; font-size: 15px; margin: 0; }
.facts { font-size: 12px; color: var(--ink-3); }
.glyph { flex: none; fill: currentColor; stroke: currentColor; }
.glyph .ink { fill: none; stroke: var(--canvas); stroke-width: 1.8; stroke-linecap: round; }
.decision-ship { color: var(--success); } .decision-ship-with-fixes { color: var(--info); }
.decision-needs-work { color: var(--warning); } .decision-blocked { color: var(--error); }
.verdict .headline strong, .verdict .prose { color: var(--ink); }
.sev { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; white-space: nowrap; }
.sev-critical { color: var(--error); } .sev-high { color: var(--error); } .sev-medium { color: var(--warning); }
.sev-low { color: var(--info); } .sev-info { color: var(--ink-3); }
.risks, .files { list-style: none; padding: 0; margin: 0; }
.risks li { display: flex; gap: 8px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
.files li { font-size: 12px; padding: 2px 0; overflow-wrap: anywhere; }
details > summary { cursor: pointer; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
.chapter { border-top: 1px solid var(--border); padding: 10px 0; }
.chapter > summary { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.chapter-index { font-family: var(--mono); color: var(--ink-3); }
.chapter-title { font-weight: 600; }
.chapter .prose, .chapter .files { margin-left: 22px; }
.group { margin: 6px 0; }
.group > summary { display: flex; gap: 8px; align-items: center; padding: 4px 0; }
.finding { border-top: 1px solid var(--border); }
.finding > summary { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; flex-wrap: wrap; }
.loc { font-size: 12px; color: var(--ink-2); overflow-wrap: anywhere; }
.finding-title { flex: 1 1 240px; }
.status { font-size: 12px; color: var(--ink-3); border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; }
.status-fixed { color: var(--success); } .status-dismissed { text-decoration: line-through; }
.finding-body { padding: 0 0 12px 22px; }
.patch { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px; overflow-x: auto; white-space: pre; }
.file { margin: 10px 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
.file > summary { padding: 6px 12px; font-size: 12px; border-bottom: 1px solid var(--border); background: var(--raised); overflow-wrap: anywhere; }
.diff { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 1.55; }
.diff td { padding: 0 8px; vertical-align: top; }
.diff .num { width: 1%; text-align: right; color: var(--ink-3); user-select: none; white-space: nowrap; }
.diff .code { white-space: pre-wrap; overflow-wrap: anywhere; }
.diff .sign { display: inline-block; width: 1.2em; color: var(--ink-3); }
.diff .add { background: var(--add-bg); color: var(--ink); } .diff .del { background: var(--del-bg); color: var(--ink); }
.diff .marked .num { color: var(--ink); font-weight: 600; background: var(--raised); }
.diff .hunk td { color: var(--ink-3); background: var(--raised); padding: 2px 8px; }
.diff .callout td { padding: 6px 12px; background: var(--raised); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); font-family: var(--sans); font-size: 13px; }
.callout-title { color: var(--ink); }
`;
