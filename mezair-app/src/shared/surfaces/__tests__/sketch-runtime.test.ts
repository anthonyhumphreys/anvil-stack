import { describe, expect, it } from 'vitest';
import { MEZAIR_KIT_SOURCE, MEZAIR_KIT_VERSION } from '../mezair-kit';
import {
  DEFAULT_SKETCH_TOKENS,
  SKETCH_CSP,
  SKETCH_TOKEN_NAMES,
  buildSketchDocument,
  buildSketchTokenCss,
  inferSketchColorScheme,
  sanitizeTokenValue,
} from '../sketch-runtime';

const tokens = DEFAULT_SKETCH_TOKENS.dark;

function scriptBodies(document: string): string[] {
  return [...document.matchAll(/<script id="[^"]+">([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
}

describe('buildSketchDocument', () => {
  it('puts the CSP meta first, ahead of any page content', () => {
    const document = buildSketchDocument('<div id="app">Hi</div>', { tokens, mode: 'inline' });
    expect(document.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(document).toContain(`content="${SKETCH_CSP}"`);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<div id="app">'),
    );
    expect(document.indexOf('id="mezair-tokens"')).toBeLessThan(document.indexOf('id="mezair-kit"'));
    expect(document.endsWith('<div id="app">Hi</div>')).toBe(true);
  });

  it('keeps a leading doctype in front of the injected head', () => {
    const html =
      '  <!DOCTYPE html>\n<html><head><script>window.x=1</script></head><body></body></html>';
    const document = buildSketchDocument(html, { tokens, mode: 'inline' });
    expect(document.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.indexOf('mezair-bridge')).toBeLessThan(document.indexOf('window.x=1'));
  });

  it('blocks network, frames, forms and base overrides', () => {
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      'img-src data: blob:',
    ]) {
      expect(SKETCH_CSP).toContain(directive);
    }
  });

  it('serialises every token on :root with the colour scheme', () => {
    const document = buildSketchDocument('', { tokens, mode: 'inline' });
    expect(document).toContain(':root{color-scheme:dark;--mezair-canvas:#0b1020');
    for (const name of SKETCH_TOKEN_NAMES) expect(document).toContain(`${name}:`);
    const light = buildSketchDocument('', { tokens: DEFAULT_SKETCH_TOKENS.light, mode: 'inline' });
    expect(light).toContain(':root{color-scheme:light;');
  });

  it('emits light and dark sets via prefers-color-scheme for shares', () => {
    const css = buildSketchTokenCss(DEFAULT_SKETCH_TOKENS);
    expect(css).toContain(':root{color-scheme:light dark;--mezair-canvas:#fbfbfc');
    expect(css).toContain('@media (prefers-color-scheme: dark){:root{--mezair-canvas:#0b1020');
  });

  it('omits ask in share mode and includes it inline', () => {
    const inline = buildSketchDocument('', { tokens, mode: 'inline' });
    const share = buildSketchDocument('', { tokens: DEFAULT_SKETCH_TOKENS, mode: 'share' });
    expect(inline).toContain('mezair/ask');
    expect(share).not.toContain('mezair/ask');
    expect(share).not.toContain('MezairHost');
    expect(share).toContain('ui/notifications/size-changed');
  });

  it('speaks JSON-RPC for size, links and theme updates', () => {
    const document = buildSketchDocument('', { tokens, mode: 'inline' });
    expect(document).toContain("jsonrpc: '2.0'");
    expect(document).toContain('ui/initialize');
    expect(document).toContain('ui/open-link');
    expect(document).toContain('ui/notifications/host-context-changed');
    expect(document).toContain('event.source !== host');
  });

  it('injects syntactically valid scripts', () => {
    const document = buildSketchDocument('', { tokens, mode: 'inline' });
    const scripts = scriptBodies(document);
    expect(scripts).toHaveLength(2);
    for (const source of scripts) expect(() => new Function(source)).not.toThrow();
  });

  it('cannot be broken out of by token values', () => {
    const css = buildSketchTokenCss({
      '--mezair-canvas': '#000;}</style><script>alert(1)</script>',
      'not-a-token': 'red',
    });
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('not-a-token');
    expect(sanitizeTokenValue('a{b}c;d<e>')).toBe('abcde');
  });
});

describe('inferSketchColorScheme', () => {
  it('reads the canvas luminance', () => {
    expect(inferSketchColorScheme({ '--mezair-canvas': '#fff' })).toBe('light');
    expect(inferSketchColorScheme({ '--mezair-canvas': 'rgb(11, 16, 32)' })).toBe('dark');
    expect(inferSketchColorScheme({})).toBe('dark');
  });
});

describe('mezair-kit', () => {
  it('is versioned, self-contained and defines the kit API', () => {
    expect(MEZAIR_KIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MEZAIR_KIT_SOURCE).toContain(`'${MEZAIR_KIT_VERSION}'`);
    expect(() => new Function(MEZAIR_KIT_SOURCE)).not.toThrow();
    for (const name of ['chart', 'table', 'code', 'diff']) {
      expect(MEZAIR_KIT_SOURCE).toContain(`${name}: ${name}`);
    }
    expect(MEZAIR_KIT_SOURCE).not.toMatch(/fetch\(|XMLHttpRequest|import\(/);
  });
});
