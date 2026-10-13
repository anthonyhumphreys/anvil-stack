// Builds the sandboxed document for a sketch: CSP, --anvil-* tokens, the
// host bridge (size, links, ask over MCP Apps-style JSON-RPC postMessage) and
// anvil-kit. Used by the renderer (inline frames), main (measure/freeze) and
// sharing (interactive bundles).

import { ANVIL_KIT_SOURCE } from './anvil-kit.js';

export type SketchTokenSet = Record<string, string>;

export interface SketchDocumentOptions {
  /** Single theme (in-app, follows the active theme) or light+dark (shares). */
  tokens: SketchTokenSet | { light: SketchTokenSet; dark: SketchTokenSet };
  /** 'inline' talks to the Anvil host; 'share' is standalone (no tools/ask). */
  mode: 'inline' | 'share';
}

export const SKETCH_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** Every token a sketch can rely on (spec §9.3). */
export const SKETCH_TOKEN_NAMES = [
  '--anvil-canvas',
  '--anvil-surface',
  '--anvil-surface-raised',
  '--anvil-border',
  '--anvil-focus',
  '--anvil-ink',
  '--anvil-ink-secondary',
  '--anvil-ink-muted',
  '--anvil-accent',
  '--anvil-on-accent',
  '--anvil-success',
  '--anvil-warning',
  '--anvil-info',
  '--anvil-error',
  '--anvil-code-bg',
  '--anvil-code-ink',
  '--anvil-series-1',
  '--anvil-series-2',
  '--anvil-series-3',
  '--anvil-series-4',
  '--anvil-series-5',
  '--anvil-series-6',
  '--anvil-radius-sm',
  '--anvil-radius-md',
  '--anvil-radius-lg',
  '--anvil-radius-xl',
  '--anvil-font-sans',
  '--anvil-font-mono',
] as const;

export type SketchTokenName = (typeof SKETCH_TOKEN_NAMES)[number];

const SHARED_TOKENS = {
  '--anvil-radius-sm': '4px',
  '--anvil-radius-md': '6px',
  '--anvil-radius-lg': '8px',
  '--anvil-radius-xl': '12px',
  '--anvil-font-sans': "'IBM Plex Sans', system-ui, sans-serif",
  '--anvil-font-mono': "'IBM Plex Mono', ui-monospace, monospace",
};

/** Default token values for the base dark and light themes (shares, offscreen). */
export const DEFAULT_SKETCH_TOKENS: { dark: SketchTokenSet; light: SketchTokenSet } = {
  dark: {
    '--anvil-canvas': '#0b1020',
    '--anvil-surface': '#111827',
    '--anvil-surface-raised': '#172033',
    '--anvil-border': '#33415f',
    '--anvil-focus': '#ff8a3d',
    '--anvil-ink': '#f8fbff',
    '--anvil-ink-secondary': '#cbd6e6',
    '--anvil-ink-muted': '#95a3b8',
    '--anvil-accent': '#ff8a3d',
    '--anvil-on-accent': '#0b1020',
    '--anvil-success': '#48d597',
    '--anvil-warning': '#ffd166',
    '--anvil-info': '#5ec8ff',
    '--anvil-error': '#ff6b8a',
    '--anvil-code-bg': '#172033',
    '--anvil-code-ink': '#f8fbff',
    '--anvil-series-1': '#5ec8ff',
    '--anvil-series-2': '#48d597',
    '--anvil-series-3': '#ffd166',
    '--anvil-series-4': '#a78bfa',
    '--anvil-series-5': '#ff6b8a',
    '--anvil-series-6': '#95a3b8',
    ...SHARED_TOKENS,
  },
  light: {
    '--anvil-canvas': '#fbfbfc',
    '--anvil-surface': '#ffffff',
    '--anvil-surface-raised': '#f3f4f6',
    '--anvil-border': '#e2e4e9',
    '--anvil-focus': '#4f46e5',
    '--anvil-ink': '#181b21',
    '--anvil-ink-secondary': '#3d4450',
    '--anvil-ink-muted': '#6b7280',
    '--anvil-accent': '#4f46e5',
    '--anvil-on-accent': '#fbfbfc',
    '--anvil-success': '#15803d',
    '--anvil-warning': '#b45309',
    '--anvil-info': '#0369a1',
    '--anvil-error': '#dc2626',
    '--anvil-code-bg': '#f3f4f6',
    '--anvil-code-ink': '#181b21',
    '--anvil-series-1': '#0369a1',
    '--anvil-series-2': '#15803d',
    '--anvil-series-3': '#b45309',
    '--anvil-series-4': '#7c3aed',
    '--anvil-series-5': '#dc2626',
    '--anvil-series-6': '#6b7280',
    ...SHARED_TOKENS,
  },
};

const TOKEN_NAME_PATTERN = /^--anvil-[a-z0-9-]+$/;

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
  const luminance = parseColorLuminance(tokens['--anvil-canvas']);
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
  'html{background:var(--anvil-canvas);color:var(--anvil-ink);font-family:var(--anvil-font-sans);font-size:14px;line-height:1.65;-webkit-font-smoothing:antialiased;scrollbar-width:none}',
  'body{margin:0}',
  '::-webkit-scrollbar{display:none}',
  ':focus-visible{outline:2px solid var(--anvil-focus);outline-offset:2px}',
  'a{color:var(--anvil-info)}',
  'code,pre,kbd,samp{font-family:var(--anvil-font-mono)}',
  'img,svg,canvas,video{max-width:100%}',
].join('');

function bridgeSource(mode: SketchDocumentOptions['mode']): string {
  const ask =
    mode === 'inline'
      ? `
  function ask(prompt){
    if (typeof prompt !== 'string' || !prompt.trim()) return;
    notify('anvil/ask', { prompt: prompt.trim().slice(0, 4000) });
  }
  window.AnvilHost = Object.freeze({ ask: ask });
  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-anvil-ask]') : null;
    if (!target) return;
    event.preventDefault();
    ask(target.getAttribute('data-anvil-ask') || '');
  });`
      : '';
  return `(function () {
  var host = window.parent;
  if (!host || host === window) return;
  var nextId = 1;
  function post(message) { try { host.postMessage(message, '*'); } catch (error) {} }
  function notify(method, params) { post({ jsonrpc: '2.0', method: method, params: params || {} }); }
  function request(method, params) { var id = nextId++; post({ jsonrpc: '2.0', id: id, method: method, params: params || {} }); return id; }
  var NAME = /^--anvil-[a-z0-9-]+$/;
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
    var style = document.getElementById('anvil-tokens');
    if (style) style.textContent = ':root{color-scheme:' + scheme + ';' + parts.join(';') + '}';
  }
  var initializeId = request('ui/initialize', {
    protocolVersion: '2026-01-26',
    appInfo: { name: 'anvil-sketch', version: '1' },
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
 * anvil-kit come before any page content (after a leading doctype).
 */
export function buildSketchDocument(html: string, options: SketchDocumentOptions): string {
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="anvil-tokens">${buildSketchTokenCss(options.tokens)}</style>`,
    `<style id="anvil-base">${BASE_CSS}</style>`,
    inlineScript('anvil-bridge', bridgeSource(options.mode)),
    inlineScript('anvil-kit', ANVIL_KIT_SOURCE),
  ].join('');
  const doctype = LEADING_DOCTYPE.exec(html);
  if (doctype) {
    const prefix = doctype[0].replace(/^\uFEFF/, '').trim();
    return `${prefix}${head}${html.slice(doctype[0].length)}`;
  }
  return `<!doctype html>${head}${html}`;
}
