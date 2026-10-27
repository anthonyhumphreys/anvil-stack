// Builds the sandboxed document for a sketch: CSP, --mezair-* tokens, the
// host bridge (size, links, ask over MCP Apps-style JSON-RPC postMessage) and
// mezair-kit. Used by the renderer (inline frames), main (measure/freeze) and
// sharing (interactive bundles).

import { MEZAIR_KIT_SOURCE } from './mezair-kit.js';

export type SketchTokenSet = Record<string, string>;

export interface SketchDocumentOptions {
  /** Single theme (in-app, follows the active theme) or light+dark (shares). */
  tokens: SketchTokenSet | { light: SketchTokenSet; dark: SketchTokenSet };
  /** 'inline' talks to the Mezair host; 'share' is standalone (no tools/ask). */
  mode: 'inline' | 'share';
}

export const SKETCH_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Every token a sketch can rely on (spec §9.3). */
export const SKETCH_TOKEN_NAMES = [
  '--mezair-canvas',
  '--mezair-surface',
  '--mezair-surface-raised',
  '--mezair-border',
  '--mezair-focus',
  '--mezair-ink',
  '--mezair-ink-secondary',
  '--mezair-ink-muted',
  '--mezair-accent',
  '--mezair-on-accent',
  '--mezair-success',
  '--mezair-warning',
  '--mezair-info',
  '--mezair-error',
  '--mezair-code-bg',
  '--mezair-code-ink',
  '--mezair-series-1',
  '--mezair-series-2',
  '--mezair-series-3',
  '--mezair-series-4',
  '--mezair-series-5',
  '--mezair-series-6',
  '--mezair-radius-sm',
  '--mezair-radius-md',
  '--mezair-radius-lg',
  '--mezair-radius-xl',
  '--mezair-font-sans',
  '--mezair-font-mono',
] as const;

export type SketchTokenName = (typeof SKETCH_TOKEN_NAMES)[number];

const SHARED_TOKENS = {
  '--mezair-radius-sm': '4px',
  '--mezair-radius-md': '6px',
  '--mezair-radius-lg': '8px',
  '--mezair-radius-xl': '12px',
  '--mezair-font-sans': "'IBM Plex Sans', system-ui, sans-serif",
  '--mezair-font-mono': "'IBM Plex Mono', ui-monospace, monospace",
};

/** Default token values for the base dark and light themes (shares, offscreen). */
export const DEFAULT_SKETCH_TOKENS: { dark: SketchTokenSet; light: SketchTokenSet } = {
  dark: {
    '--mezair-canvas': '#0b1020',
    '--mezair-surface': '#111827',
    '--mezair-surface-raised': '#172033',
    '--mezair-border': '#33415f',
    '--mezair-focus': '#ff8a3d',
    '--mezair-ink': '#f8fbff',
    '--mezair-ink-secondary': '#cbd6e6',
    '--mezair-ink-muted': '#95a3b8',
    '--mezair-accent': '#ff8a3d',
    '--mezair-on-accent': '#0b1020',
    '--mezair-success': '#48d597',
    '--mezair-warning': '#ffd166',
    '--mezair-info': '#5ec8ff',
    '--mezair-error': '#ff6b8a',
    '--mezair-code-bg': '#172033',
    '--mezair-code-ink': '#f8fbff',
    '--mezair-series-1': '#5ec8ff',
    '--mezair-series-2': '#48d597',
    '--mezair-series-3': '#ffd166',
    '--mezair-series-4': '#a78bfa',
    '--mezair-series-5': '#ff6b8a',
    '--mezair-series-6': '#95a3b8',
    ...SHARED_TOKENS,
  },
  light: {
    '--mezair-canvas': '#fbfbfc',
    '--mezair-surface': '#ffffff',
    '--mezair-surface-raised': '#f3f4f6',
    '--mezair-border': '#e2e4e9',
    '--mezair-focus': '#4f46e5',
    '--mezair-ink': '#181b21',
    '--mezair-ink-secondary': '#3d4450',
    '--mezair-ink-muted': '#6b7280',
    '--mezair-accent': '#4f46e5',
    '--mezair-on-accent': '#fbfbfc',
    '--mezair-success': '#15803d',
    '--mezair-warning': '#b45309',
    '--mezair-info': '#0369a1',
    '--mezair-error': '#dc2626',
    '--mezair-code-bg': '#f3f4f6',
    '--mezair-code-ink': '#181b21',
    '--mezair-series-1': '#0369a1',
    '--mezair-series-2': '#15803d',
    '--mezair-series-3': '#b45309',
    '--mezair-series-4': '#7c3aed',
    '--mezair-series-5': '#dc2626',
    '--mezair-series-6': '#6b7280',
    ...SHARED_TOKENS,
  },
};

const TOKEN_NAME_PATTERN = /^--mezair-[a-z0-9-]+$/;

/** Strips anything that could close the declaration, rule or style element. */
export function sanitizeTokenValue(value: string): string {
  return value.replace(/[<>{};\\]/g, '').trim();
}

function declarations(tokens: SketchTokenSet): string {
  return Object.entries(tokens)
    .filter(([name]) => TOKEN_NAME_PATTERN.test(name))
    .map(([name, value]) => `${name}:${sanitizeTokenValue(String(value))}`)
    .filter((declaration) => !declaration.endsWith(':'))
    .join(';');
}

function parseColorLuminance(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((digit) => digit + digit)
            .join('')
        : hex[1];
    rgb = [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
  } else {
    const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(trimmed);
    if (fn) rgb = [fn[1], fn[2], fn[3]].map(Number);
  }
  if (!rgb || rgb.some((channel) => !Number.isFinite(channel))) return null;
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** `light` when the canvas token is light, otherwise `dark`. */
export function inferSketchColorScheme(tokens: SketchTokenSet): 'light' | 'dark' {
  const luminance = parseColorLuminance(tokens['--mezair-canvas']);
  return luminance !== null && luminance > 0.5 ? 'light' : 'dark';
}

function isPairedTokens(
  tokens: SketchDocumentOptions['tokens'],
): tokens is { light: SketchTokenSet; dark: SketchTokenSet } {
  const candidate = tokens as { light?: unknown; dark?: unknown };
  return (
    typeof candidate.light === 'object' &&
    candidate.light !== null &&
    typeof candidate.dark === 'object' &&
    candidate.dark !== null
  );
}

export function buildSketchTokenCss(tokens: SketchDocumentOptions['tokens']): string {
  if (isPairedTokens(tokens)) {
    return [
      `:root{color-scheme:light dark;${declarations(tokens.light)}}`,
      `@media (prefers-color-scheme: dark){:root{${declarations(tokens.dark)}}}`,
    ].join('');
  }
  return `:root{color-scheme:${inferSketchColorScheme(tokens)};${declarations(tokens)}}`;
}

const BASE_CSS = [
  'html{background:var(--mezair-canvas);color:var(--mezair-ink);font-family:var(--mezair-font-sans);font-size:14px;line-height:1.65;-webkit-font-smoothing:antialiased;scrollbar-width:none}',
  'body{margin:0}',
  '::-webkit-scrollbar{display:none}',
  ':focus-visible{outline:2px solid var(--mezair-focus);outline-offset:2px}',
  'a{color:var(--mezair-info)}',
  'code,pre,kbd,samp{font-family:var(--mezair-font-mono)}',
  'img,svg,canvas,video{max-width:100%}',
].join('');

function bridgeSource(mode: SketchDocumentOptions['mode']): string {
  const ask =
    mode === 'inline'
      ? `
  function ask(prompt){
    if (typeof prompt !== 'string' || !prompt.trim()) return;
    notify('mezair/ask', { prompt: prompt.trim().slice(0, 4000) });
  }
  window.MezairHost = Object.freeze({ ask: ask });
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-mezair-ask]') : null;
    if (!target) return;
    event.preventDefault();
    ask(target.getAttribute('data-mezair-ask') || '');
  });`
      : '';
  return `(function () {
  var host = window.parent;
  if (!host || host === window) return;
  var nextId = 1;
  function post(message) { try { host.postMessage(message, '*'); } catch (error) {} }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function request(method, params) { var id = nextId++; post({ jsonrpc: '2.0', id: id, method: method, params: params || {} }); return id; }
  var NAME = /^--mezair-[a-z0-9-]+$/;
  function applyContext(context) {
    if (!context || !context.styles || !context.styles.variables) return;
    var variables = context.styles.variables;
    var parts = [];
    for (var name in variables) {
      if (!Object.prototype.hasOwnProperty.call(variables, name) || !NAME.test(name)) continue;
      var value = String(variables[name]).replace(/[<>{};\\\\]/g, '').trim();
      if (value) parts.push(name + ':' + value);
    }
    var scheme = context.theme === 'light' ? 'light' : 'dark';
    var style = document.getElementById('mezair-tokens');
    if (style) style.textContent = ':root{color-scheme:' + scheme + ';' + parts.join(';') + '}';
  }
  var initializeId = request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'mezair-sketch', version: '1' },
    appCapabilities: {}
  });
  window.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || data.jsonrpc !== '2.0') return;
    if (data.id === initializeId && data.result) {
      applyContext(data.result.hostContext);
      notify('ui/notifications/initialized', {});
      return;
    }
    if (data.method === 'ui/notifications/host-context-changed') applyContext(data.params);
  });
  var lastHeight = -1;
  function measure() {
    var root = document.documentElement;
    var height = Math.ceil(Math.max(root.getBoundingClientRect().height, document.body ? document.body.getBoundingClientRect().height : 0));
    if (height !== lastHeight) {
      lastHeight = height;
      notify('ui/notifications/size-changed', { height: height });
    }
  }
  var scheduled = false;
  function scheduleMeasure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; measure(); });
  }
  function observe() {
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(scheduleMeasure);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
    scheduleMeasure();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
  window.addEventListener('load', scheduleMeasure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMeasure);
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    event.preventDefault();
    var url;
    try { url = new URL(href, 'https://invalid.local/'); } catch (error) { return; }
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== 'invalid.local') {
      notify('ui/open-link', { url: url.href });
    }
  });${ask}
})();`;
}

/** Escapes `</script` sequences so injected source can't terminate its element. */
function inlineScript(id: string, source: string): string {
  return `<script id="${id}">${source.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
}

const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/**
 * Wraps agent-authored HTML so the CSP, theme tokens, base styles, bridge and
 * mezair-kit come before any page content (after a leading doctype).
 */
export function buildSketchDocument(html: string, options: SketchDocumentOptions): string {
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="mezair-tokens">${buildSketchTokenCss(options.tokens)}</style>`,
    `<style id="mezair-base">${BASE_CSS}</style>`,
    inlineScript('mezair-bridge', bridgeSource(options.mode)),
    inlineScript('mezair-kit', MEZAIR_KIT_SOURCE),
  ].join('');
  const doctype = LEADING_DOCTYPE.exec(html);
  if (doctype) {
    const prefix = doctype[0].replace(/^\uFEFF/, '').trim();
    return `${prefix}${head}${html.slice(doctype[0].length)}`;
  }
  return `<!doctype html>${head}${html}`;
}
