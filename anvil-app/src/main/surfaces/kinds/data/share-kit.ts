// Static, script-free share snapshot helpers (§11.3) used by the findings,
// dependencies, pipeline and data surfaces. Snapshots carry light and dark
// token sets via prefers-color-scheme so they follow the recipient's OS.
import path from 'node:path';
import {
  SEVERITY_LABELS,
  type SurfaceSeverity,
} from '../../../../shared/surfaces/kinds/findings.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Token names match the renderer's `--color-*` so chart series map 1:1. */
export const SHARE_BASE_CSS = `
:root {
  color-scheme: light dark;
  --color-bg-primary: #fbfbfc; --color-bg-secondary: #ffffff; --color-bg-tertiary: #f3f4f6;
  --color-border: #e2e4e9; --color-border-subtle: #ecedf1;
  --color-text-primary: #181b21; --color-text-secondary: #3d4450; --color-text-tertiary: #6b7280;
  --color-accent: #c2410c; --color-success: #15803d; --color-warning: #b45309; --color-info: #0369a1;
  --color-error: #dc2626; --color-persona-docs: #7c3aed; --color-persona-architect: #0369a1;
  --color-persona-reviewer: #b45309;
  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg-primary: #0b1020; --color-bg-secondary: #111827; --color-bg-tertiary: #172033;
    --color-border: #33415f; --color-border-subtle: #25304a;
    --color-text-primary: #f8fbff; --color-text-secondary: #cbd6e6; --color-text-tertiary: #95a3b8;
    --color-accent: #ff8a3d; --color-success: #48d597; --color-warning: #ffd166; --color-info: #5ec8ff;
    --color-error: #ff6b8a; --color-persona-docs: #a78bfa; --color-persona-architect: #5ec8ff;
    --color-persona-reviewer: #ffd166;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-bg-primary); color: var(--color-text-primary);
  font: 14px/1.65 var(--font-sans); }
.sv { padding: 16px; max-width: 1200px; }
.sv h1 { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.sv .meta { color: var(--color-text-tertiary); font-size: 12px; margin: 0 0 12px; }
.sv p { margin: 0 0 12px; max-width: 72ch; color: var(--color-text-secondary); }
.sv .counts { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 12px; padding: 0; list-style: none;
  font-size: 12px; color: var(--color-text-secondary); }
.sv table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 0 0 16px; }
.sv th, .sv td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--color-border-subtle);
  vertical-align: top; overflow-wrap: anywhere; }
.sv th { color: var(--color-text-tertiary); font-weight: 500; border-bottom-color: var(--color-border); }
.sv td.num, .sv th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sv code, .sv .mono { font-family: var(--font-mono); font-size: 12px; }
.sv pre { font-family: var(--font-mono); font-size: 12px; background: var(--color-bg-secondary);
  border: 1px solid var(--color-border); border-radius: 8px; padding: 8px 12px; overflow: auto; margin: 4px 0 12px; }
.sv details { border-bottom: 1px solid var(--color-border-subtle); padding: 6px 0; }
.sv summary { cursor: pointer; }
.sv .muted { color: var(--color-text-tertiary); }
.sv .sev-critical, .sv .sev-high { color: var(--color-error); }
.sv .sev-medium { color: var(--color-warning); }
.sv .sev-low { color: var(--color-info); }
.sv .sev-info { color: var(--color-text-tertiary); }
.sv svg { max-width: 100%; height: auto; display: block; margin: 0 0 16px; }
.sv svg text { font-family: var(--font-sans); font-size: 11px; fill: var(--color-text-secondary); }
`;

export const SEVERITY_TEXT_GLYPHS: Record<SurfaceSeverity, string> = {
  critical: '◆',
  high: '▲',
  medium: '■',
  low: '●',
  info: '○',
};

export function severityBadge(severity: SurfaceSeverity): string {
  return `<span class="sev-${severity}"><span aria-hidden="true">${SEVERITY_TEXT_GLYPHS[severity]}</span> ${escapeHtml(SEVERITY_LABELS[severity])}</span>`;
}

export function wrapSnapshot(title: string, meta: string, body: string): string {
  return `<article class="sv"><h1>${escapeHtml(title)}</h1>${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ''}${body}</article>`;
}

export interface SnapshotColumn<T> {
  label: string;
  numeric?: boolean;
  /** Returns pre-escaped HTML. */
  cell(row: T): string;
}

export function htmlTable<T>(
  columns: SnapshotColumn<T>[],
  rows: readonly T[],
  caption?: string,
): string {
  const head = columns
    .map(
      (column) =>
        `<th scope="col"${column.numeric ? ' class="num"' : ''}>${escapeHtml(column.label)}</th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${columns.map((column) => `<td${column.numeric ? ' class="num"' : ''}>${column.cell(row)}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table>${caption ? `<caption class="muted">${escapeHtml(caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Reduce absolute local paths to repo-relative (or bare file name when outside the repo). */
export function redactPath(value: string | undefined, repoRoot?: string): string | undefined {
  if (!value) return value;
  const looksAbsolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (!looksAbsolute) return value;
  if (repoRoot) {
    const relative = path.relative(repoRoot, value);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative.split(path.sep).join('/');
    }
  }
  return path.basename(value);
}

/** Guard used in tests and before returning snapshots. */
export function assertScriptFree(html: string): void {
  // Content is escaped, so `<` only ever opens a real tag; check tags and their attributes.
  if (/<script\b|<[^>]*\son[a-z]+\s*=|<[^>]*javascript:|<iframe\b|<object\b|<embed\b/i.test(html)) {
    throw new Error('Share snapshot must be script-free.');
  }
}
