// Builds what a share publishes (spec §11.2–§11.3).
//
// - Binary artifacts (pdf, docx, pptx, xlsx) and plain-text artifacts
//   (markdown, csv, code, text, data) share their raw bytes under their
//   own media type, exactly as before bundles existed.
// - HTML artifacts (including kept sketches) share an interactive bundle:
//   the full standalone document plus a frozen, script-free snapshot.
// - Mermaid/diagram artifacts share a bundle whose snapshot embeds the
//   renderer's pre-rendered SVG, or the source as a fallback.
// - Native surfaces share a bundle with the kind's redacted static
//   snapshot, its digest and the redacted payload (for Open in Anvil).
//
// Everything here is pure apart from the offscreen freeze; the secret
// scan, sealing and upload happen in share.service.

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { ChatArtifactKind } from '../../shared/types.js';
import {
  SHARE_BUNDLE_MEDIA_TYPE,
  type AnvilShareBundle,
  type SharePreview,
} from '../../shared/shares-ipc.js';
import {
  buildSketchDocument,
  DEFAULT_SKETCH_TOKENS,
} from '../../shared/surfaces/sketch-runtime.js';
import { renderOffscreen } from '../surfaces/offscreen.js';
import type { MainSurfaceHandler, ShareSnapshot } from '../surfaces/types.js';

export const SHARE_BUNDLE_FORMAT = 'anvil-share/v1' as const;
export const SHARE_BUNDLE_SCHEMA_VERSION = 1;
/** Width the HTML snapshot is frozen at (matches a comfortable reading column). */
export const SNAPSHOT_FREEZE_WIDTH = 900;
const MAX_DIAGRAM_SVG_BYTES = 2 * 1024 * 1024;

export interface ArtifactShareSource {
  id: string;
  title: string;
  kind: ChatArtifactKind;
  content: string;
  filePath: string | null;
  version: number;
}

export interface SurfaceShareSource {
  id: string;
  title: string;
  surfaceKind: string;
  revision: number;
  digest: string;
  data: unknown;
}

export interface ShareBuildOptions {
  includeComments?: boolean;
  includeFullDiff?: boolean;
  diagramSvg?: string;
}

export interface BuiltShare {
  title: string;
  mediaType: string;
  interactive: boolean;
  version: number;
  /** 'artifact:html', 'artifact:markdown', 'surface:review', … */
  kind: string;
  /** UTF-8 plaintext to scan and upload; null for binary payloads. */
  text: string | null;
  /** Raw bytes for binary payloads; null when `text` is set. */
  binary: Uint8Array | null;
  includes: string[];
  availableOptions: NonNullable<SharePreview['availableOptions']>;
}

// ---- media types --------------------------------------------------------

const BINARY_KINDS: ReadonlySet<ChatArtifactKind> = new Set(['docx', 'pptx', 'pdf', 'xlsx']);
const RAW_TEXT_KINDS: ReadonlySet<ChatArtifactKind> = new Set([
  'markdown',
  'csv',
  'code',
  'text',
  'data',
]);

function mimeTypeForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv':
      return 'text/csv';
    default:
      return 'application/octet-stream';
  }
}

/** Media type an artifact shares under when it is not bundled (unchanged from before bundles). */
export function rawArtifactMediaType(kind: ChatArtifactKind, filePath: string | null): string {
  if (filePath !== null) {
    const fromFile = mimeTypeForPath(filePath);
    if (fromFile !== 'application/octet-stream') return fromFile;
  }
  switch (kind) {
    case 'markdown':
      return 'text/markdown';
    case 'html':
      return 'text/html';
    case 'csv':
      return 'text/csv';
    case 'data':
      return 'application/json';
    case 'mermaid':
    case 'diagram':
      return 'text/vnd.mermaid';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'pdf':
      return 'application/pdf';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default:
      return 'text/plain';
  }
}

function mediaTypeLabel(mediaType: string): string {
  if (mediaType === 'text/markdown') return 'Markdown';
  if (mediaType === 'text/csv') return 'CSV';
  if (mediaType === 'application/json') return 'JSON';
  if (mediaType === 'text/plain') return 'text';
  if (mediaType === 'application/pdf') return 'PDF';
  if (mediaType.includes('wordprocessingml')) return 'Word';
  if (mediaType.includes('presentationml')) return 'PowerPoint';
  if (mediaType.includes('spreadsheetml')) return 'Excel';
  return mediaType;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ---- markup helpers -------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Defence in depth for static markup: removes scripts, event handlers,
 * javascript: URLs and embedding elements. Every consumer also renders
 * snapshots in a `sandbox=""` frame with `script-src 'none'`, and the
 * website additionally sanitises with DOMPurify.
 */
export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed|frameset|frame|applet|portal)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|frame|applet|portal|base)\b[^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(
      /(href|src|action|formaction|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
      '$1=$2#$2',
    );
}

/** Script-free SVG for embedding: strips scripts, handlers and external references. */
export function sanitizeSvg(svg: string): string | null {
  const trimmed = svg.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed) > MAX_DIAGRAM_SVG_BYTES) return null;
  const start = trimmed.search(/<svg\b/i);
  if (start < 0) return null;
  return stripScripts(trimmed.slice(start))
    .replace(/<\?xml[^>]*>/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])(?!#|data:image\/)[^"']*\1/gi, '')
    .replace(/url\(\s*(["']?)(?!#|data:image\/)[^)]*\1\s*\)/gi, 'none');
}

/** Plain text of an HTML document for digests. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Base snapshot stylesheet: Anvil's type and neutral tokens with light and
 * dark sets, so a snapshot follows the recipient's OS appearance rather
 * than the sharer's theme. Kind snapshots layer their own CSS on top.
 */
export const SNAPSHOT_BASE_CSS = `
:root{color-scheme:light dark;--anvil-canvas:#ffffff;--anvil-surface:#f6f7f9;--anvil-border:#d5dae3;--anvil-ink:#111827;--anvil-ink-secondary:#374151;--anvil-ink-muted:#5b6474;--anvil-accent:#c2410c;--anvil-code-bg:#f3f4f6;--anvil-code-ink:#111827;--anvil-font-sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--anvil-font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--anvil-canvas:#0b1020;--anvil-surface:#111827;--anvil-border:#33415f;--anvil-ink:#f8fbff;--anvil-ink-secondary:#cbd6e6;--anvil-ink-muted:#95a3b8;--anvil-accent:#ff8a3d;--anvil-code-bg:#172033;--anvil-code-ink:#f8fbff}}
html,body{margin:0;padding:0;background:var(--anvil-canvas);color:var(--anvil-ink);font:14px/1.65 var(--anvil-font-sans)}
body{padding:16px}
pre,code{font-family:var(--anvil-font-mono);font-size:12.5px}
pre{background:var(--anvil-code-bg);color:var(--anvil-code-ink);border:1px solid var(--anvil-border);border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;overflow:auto}
.anvil-diagram{margin:0;display:flex;justify-content:center}
.anvil-diagram svg{max-width:100%;height:auto}
.anvil-note{color:var(--anvil-ink-muted);font-size:12px;margin:0 0 8px}
.anvil-file{border:1px solid var(--anvil-border);border-radius:12px;padding:20px;background:var(--anvil-surface)}
.anvil-file strong{display:block;font-size:14px}
.anvil-file span{color:var(--anvil-ink-muted);font-size:12px}
`.trim();

const STATIC_DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

function resolveImages(html: string, images: Record<string, string> | undefined): string {
  if (!images) return html;
  return html.replace(/anvil-image:([A-Za-z0-9_.-]{1,128})/g, (match, key: string) => {
    const uri = images[key];
    return typeof uri === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(uri) ? uri : match;
  });
}

/**
 * A complete, script-free HTML document for an iframe `srcdoc`: the
 * static CSP is injected first, then the stylesheet, then the markup.
 */
export function composeStaticDocument(
  html: string,
  css: string,
  options: { title?: string; images?: Record<string, string> } = {},
): string {
  const markup = resolveImages(stripScripts(html), options.images);
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_DOCUMENT_CSP}"><meta name="referrer" content="no-referrer">${css ? `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>` : ''}`;
  const headMatch = /<head\b[^>]*>/i.exec(markup);
  if (headMatch) {
    const at = (headMatch.index ?? 0) + headMatch[0].length;
    return `${markup.slice(0, at)}${head}${markup.slice(at)}`;
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(markup);
  if (htmlMatch) {
    const at = (htmlMatch.index ?? 0) + htmlMatch[0].length;
    return `${markup.slice(0, at)}<head>${head}</head>${markup.slice(at)}`;
  }
  const title = options.title ? `<title>${escapeHtml(options.title)}</title>` : '';
  return `<!doctype html><html><head>${head}${title}</head><body>${markup}</body></html>`;
}

// ---- bundles --------------------------------------------------------------

function newBundle(
  input: Omit<AnvilShareBundle, 'format' | 'sharedAt' | 'schemaVersion'>,
): AnvilShareBundle {
  return {
    format: SHARE_BUNDLE_FORMAT,
    sharedAt: new Date().toISOString(),
    schemaVersion: SHARE_BUNDLE_SCHEMA_VERSION,
    ...input,
  };
}

function bundleShare(
  bundle: AnvilShareBundle,
  rest: Omit<
    BuiltShare,
    'mediaType' | 'text' | 'binary' | 'kind' | 'version' | 'title' | 'interactive'
  >,
): BuiltShare {
  return {
    title: bundle.title,
    mediaType: SHARE_BUNDLE_MEDIA_TYPE,
    interactive: bundle.interactive !== undefined,
    version: bundle.version,
    kind: bundle.kind,
    text: JSON.stringify(bundle),
    binary: null,
    ...rest,
  };
}

function readArtifactText(source: ArtifactShareSource): string {
  if (source.filePath && existsSync(source.filePath)) {
    return readFileSync(source.filePath, 'utf8');
  }
  return source.content;
}

async function frozenSnapshot(
  interactiveHtml: string,
  sourceHtml: string,
): Promise<{ html: string; height?: number }> {
  try {
    const rendered = await renderOffscreen(interactiveHtml, {
      width: SNAPSHOT_FREEZE_WIDTH,
      freeze: true,
    });
    if (typeof rendered.frozenHtml === 'string' && rendered.frozenHtml.trim().length > 0) {
      const height =
        typeof rendered.height === 'number' &&
        Number.isFinite(rendered.height) &&
        rendered.height > 0
          ? Math.round(rendered.height)
          : undefined;
      return { html: stripScripts(rendered.frozenHtml), ...(height ? { height } : {}) };
    }
  } catch {
    // Offscreen rendering is unavailable (headless/test) or the page
    // failed to settle: fall back to the script-stripped source.
  }
  return { html: stripScripts(sourceHtml) };
}

async function buildHtmlArtifactShare(source: ArtifactShareSource): Promise<BuiltShare> {
  const html = readArtifactText(source);
  const interactiveHtml = buildSketchDocument(html, {
    tokens: { light: DEFAULT_SKETCH_TOKENS.light, dark: DEFAULT_SKETCH_TOKENS.dark },
    mode: 'share',
  });
  const snapshot = await frozenSnapshot(interactiveHtml, html);
  const text = htmlToText(html);
  const bundle = newBundle({
    title: source.title,
    kind: 'artifact:html',
    version: source.version,
    digest: clip(text ? `${source.title}: ${text}` : source.title, 600),
    snapshot: {
      html: snapshot.html,
      css: '',
      ...(snapshot.height ? { height: snapshot.height } : {}),
    },
    interactive: { html: interactiveHtml },
  });
  return bundleShare(bundle, {
    includes: [
      'A static snapshot of the page, shown first',
      'The interactive page, which runs its own scripts only after the recipient chooses to load it',
    ],
    availableOptions: {},
  });
}

function buildDiagramArtifactShare(
  source: ArtifactShareSource,
  options: ShareBuildOptions,
): BuiltShare {
  const diagramSource = readArtifactText(source);
  const svg = options.diagramSvg ? sanitizeSvg(options.diagramSvg) : null;
  const snapshotHtml = svg
    ? `<figure class="anvil-diagram" role="img" aria-label="${escapeHtml(source.title)}">${svg}</figure>`
    : `<p class="anvil-note">Diagram source (no rendered image was available when this was shared)</p><pre><code>${escapeHtml(diagramSource)}</code></pre>`;
  const lineCount = diagramSource.split('\n').filter((line) => line.trim()).length;
  const bundle = newBundle({
    title: source.title,
    kind: `artifact:${source.kind}`,
    version: source.version,
    digest: `${source.title}: Mermaid diagram, ${lineCount} line${lineCount === 1 ? '' : 's'} of source.`,
    snapshot: { html: snapshotHtml, css: SNAPSHOT_BASE_CSS },
    payload: { format: 'mermaid', source: diagramSource },
  });
  return bundleShare(bundle, {
    includes: [
      svg ? 'The diagram as a rendered image' : 'The diagram source as text (no rendered image)',
      'The Mermaid source, for opening in Anvil',
    ],
    availableOptions: {},
  });
}

function buildRawArtifactShare(source: ArtifactShareSource): BuiltShare {
  const mediaType = rawArtifactMediaType(source.kind, source.filePath);
  const fileBacked = source.filePath !== null && existsSync(source.filePath);
  const isBinary =
    BINARY_KINDS.has(source.kind) ||
    (!mediaType.startsWith('text/') && mediaType !== 'application/json');
  if (isBinary) {
    const bytes = fileBacked
      ? new Uint8Array(readFileSync(source.filePath as string))
      : new TextEncoder().encode(source.content);
    return {
      title: source.title,
      mediaType,
      interactive: false,
      version: source.version,
      kind: `artifact:${source.kind}`,
      text: null,
      binary: bytes,
      includes: [`The ${mediaTypeLabel(mediaType)} file (${formatBytes(bytes.byteLength)})`],
      availableOptions: {},
    };
  }
  const text = readArtifactText(source);
  return {
    title: source.title,
    mediaType,
    interactive: false,
    version: source.version,
    kind: `artifact:${source.kind}`,
    text,
    binary: null,
    includes: [`The ${mediaTypeLabel(mediaType)} content as written`],
    availableOptions: {},
  };
}

export async function buildArtifactShare(
  source: ArtifactShareSource,
  options: ShareBuildOptions = {},
): Promise<BuiltShare> {
  if (source.kind === 'html') return buildHtmlArtifactShare(source);
  if (source.kind === 'mermaid' || source.kind === 'diagram') {
    return buildDiagramArtifactShare(source, options);
  }
  if (BINARY_KINDS.has(source.kind) || RAW_TEXT_KINDS.has(source.kind)) {
    return buildRawArtifactShare(source);
  }
  return buildRawArtifactShare({ ...source, kind: 'text' });
}

function surfaceLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function buildSurfaceShare(
  source: SurfaceShareSource,
  handler: MainSurfaceHandler | undefined,
  options: ShareBuildOptions = {},
): BuiltShare {
  const share = handler?.share;
  if (!share) {
    throw new Error(`${surfaceLabel(source.surfaceKind)} surfaces are not shareable.`);
  }
  const includeComments = options.includeComments === true;
  const includeFullDiff = source.surfaceKind === 'review' && options.includeFullDiff === true;
  const redacted = share.redact(source.data);
  const snapshot: ShareSnapshot = share.snapshot(redacted, source.title, {
    includeComments,
    includeFullDiff,
  });
  const bundle = newBundle({
    title: source.title,
    kind: `surface:${source.surfaceKind}`,
    version: source.revision,
    digest: source.digest || source.title,
    snapshot: {
      html: stripScripts(snapshot.html),
      css: `${SNAPSHOT_BASE_CSS}\n${snapshot.css}`,
      ...(snapshot.images ? { images: snapshot.images } : {}),
    },
    payload: redacted,
  });
  const includes = [
    `A read-only snapshot of the ${surfaceLabel(source.surfaceKind)}`,
    'Its data with private fields removed, so a recipient with Anvil can open it',
    includeComments ? 'Resolved comments' : 'No comments',
  ];
  if (source.surfaceKind === 'review') {
    includes.push(includeFullDiff ? 'The full diff' : 'Only the hunks around findings');
  }
  return bundleShare(bundle, {
    includes,
    availableOptions: {
      includeComments: true,
      ...(source.surfaceKind === 'review' ? { includeFullDiff: true } : {}),
    },
  });
}

// ---- previews -------------------------------------------------------------

/**
 * The static document the recipient sees first, for an iframe `srcdoc`
 * (rendered with `sandbox=""`). Built from the final, redacted bytes.
 */
export function buildPreviewDocument(input: {
  title: string;
  mediaType: string;
  text: string | null;
  byteLength: number;
}): string {
  if (input.mediaType === SHARE_BUNDLE_MEDIA_TYPE && input.text !== null) {
    try {
      const bundle = JSON.parse(input.text) as AnvilShareBundle;
      return composeStaticDocument(bundle.snapshot.html, bundle.snapshot.css, {
        title: input.title,
        images: bundle.snapshot.images,
      });
    } catch {
      // Fall through to the source view.
    }
  }
  if (input.text !== null) {
    return composeStaticDocument(`<pre>${escapeHtml(input.text)}</pre>`, SNAPSHOT_BASE_CSS, {
      title: input.title,
    });
  }
  return composeStaticDocument(
    `<div class="anvil-file"><strong>${escapeHtml(input.title)}</strong><span>${escapeHtml(
      mediaTypeLabel(input.mediaType),
    )} file · ${formatBytes(input.byteLength)}. Recipients can preview it in the browser where supported, or download it.</span></div>`,
    SNAPSHOT_BASE_CSS,
    { title: input.title },
  );
}
