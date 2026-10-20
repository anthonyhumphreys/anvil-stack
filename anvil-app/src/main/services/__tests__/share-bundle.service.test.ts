import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnvilShareBundle } from '../../../shared/shares-ipc.js';
import type { MainSurfaceHandler } from '../../surfaces/types.js';

const renderOffscreen = vi.hoisted(() => vi.fn());
vi.mock('../../surfaces/offscreen.js', () => ({ renderOffscreen }));

const buildSketchDocument = vi.hoisted(() =>
  vi.fn((html: string, options: { mode: string }) => `<!--sketch:${options.mode}-->${html}`),
);
vi.mock('../../../shared/surfaces/sketch-runtime.js', () => ({
  buildSketchDocument,
  DEFAULT_SKETCH_TOKENS: { light: { '--anvil-ink': '#111' }, dark: { '--anvil-ink': '#fff' } },
}));

import {
  buildArtifactShare,
  buildPreviewDocument,
  buildSurfaceShare,
  composeStaticDocument,
  sanitizeSvg,
  stripScripts,
} from '../share-bundle.service.js';

const dir = mkdtempSync(join(tmpdir(), 'anvil-share-bundle-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  renderOffscreen.mockReset();
  buildSketchDocument.mockClear();
});

function artifact(kind: string, content: string, filePath: string | null = null) {
  return {
    id: 'a1',
    title: 'Release notes',
    kind: kind as never,
    content,
    filePath,
    version: 3,
  };
}

function parseBundle(text: string | null): AnvilShareBundle {
  expect(text).not.toBeNull();
  return JSON.parse(text as string) as AnvilShareBundle;
}

describe('buildArtifactShare', () => {
  it('keeps raw bytes and media types for plain-text kinds', async () => {
    const markdown = await buildArtifactShare(artifact('markdown', '# Hi'));
    expect(markdown).toMatchObject({
      mediaType: 'text/markdown',
      interactive: false,
      text: '# Hi',
      binary: null,
      version: 3,
    });
    expect((await buildArtifactShare(artifact('csv', 'a,b'))).mediaType).toBe('text/csv');
    expect((await buildArtifactShare(artifact('code', 'x()'))).mediaType).toBe('text/plain');
    expect((await buildArtifactShare(artifact('data', '{}'))).mediaType).toBe('application/json');
  });

  it('shares binary kinds as their on-disk bytes', async () => {
    const path = join(dir, 'report.pdf');
    writeFileSync(path, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
    const built = await buildArtifactShare(artifact('pdf', '', path));
    expect(built.mediaType).toBe('application/pdf');
    expect(built.text).toBeNull();
    expect(Array.from(built.binary ?? [])).toEqual([0x25, 0x50, 0x44, 0x46, 0x00]);
    expect(built.includes[0]).toContain('PDF file');
  });

  it('bundles HTML as interactive with a frozen, script-free snapshot', async () => {
    renderOffscreen.mockResolvedValue({
      height: 400,
      frozenHtml:
        '<html><head></head><body><h1 onclick="x()">Hi</h1><script>evil()</script></body></html>',
    });
    const built = await buildArtifactShare(artifact('html', '<h1>Hi</h1><script>run()</script>'));
    expect(built.mediaType).toBe('application/vnd.anvil.share+json');
    expect(built.interactive).toBe(true);
    const bundle = parseBundle(built.text);
    expect(bundle).toMatchObject({ format: 'anvil-share/v1', kind: 'artifact:html', version: 3 });
    expect(bundle.interactive?.html).toBe('<!--sketch:share--><h1>Hi</h1><script>run()</script>');
    expect(buildSketchDocument).toHaveBeenCalledWith(
      '<h1>Hi</h1><script>run()</script>',
      expect.objectContaining({
        mode: 'share',
        tokens: { light: { '--anvil-ink': '#111' }, dark: { '--anvil-ink': '#fff' } },
      }),
    );
    expect(renderOffscreen).toHaveBeenCalledWith(bundle.interactive?.html, {
      width: 900,
      freeze: true,
    });
    expect(bundle.snapshot.html).not.toMatch(/<script|onclick/i);
    expect(bundle.snapshot.html).toContain('<h1>Hi</h1>');
    expect(bundle.snapshot.height).toBe(400);
    expect(bundle.digest).toContain('Hi');
  });

  it('falls back to the script-stripped source when offscreen rendering fails', async () => {
    renderOffscreen.mockRejectedValue(new Error('no offscreen'));
    const built = await buildArtifactShare(artifact('html', '<p>Body</p><script>run()</script>'));
    const bundle = parseBundle(built.text);
    expect(bundle.snapshot.html).toBe('<p>Body</p>');
    expect(bundle.interactive).toBeDefined();
  });

  it('embeds a sanitised pre-rendered SVG for diagrams', async () => {
    const built = await buildArtifactShare(artifact('mermaid', 'graph TD; A-->B'), {
      diagramSvg:
        '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><g onload="y()"><text>A</text></g><image href="https://evil.test/p.png"/></svg>',
    });
    expect(built.interactive).toBe(false);
    const bundle = parseBundle(built.text);
    expect(bundle.kind).toBe('artifact:mermaid');
    expect(bundle.snapshot.html).toContain('<svg');
    expect(bundle.snapshot.html).not.toMatch(/<script|onload|evil\.test/);
    expect(bundle.payload).toEqual({ format: 'mermaid', source: 'graph TD; A-->B' });
  });

  it('shows diagram source when no SVG was provided', async () => {
    const built = await buildArtifactShare(artifact('diagram', 'graph TD; A-->B'));
    const bundle = parseBundle(built.text);
    expect(bundle.snapshot.html).toContain('<pre><code>graph TD; A--&gt;B</code></pre>');
    expect(built.includes[0]).toContain('source');
  });
});

describe('buildSurfaceShare', () => {
  const source = {
    id: 's1',
    title: 'Review: main',
    surfaceKind: 'review',
    revision: 4,
    digest: 'Review · 2 findings',
    data: { findings: [{ id: 'f1', path: '/Users/me/repo/src/a.ts', note: 'private' }] },
  };

  it('redacts, snapshots and carries the payload', () => {
    const snapshot = vi.fn(() => ({
      html: '<details><summary>F1</summary></details>',
      css: '.x{}',
    }));
    const handler: MainSurfaceHandler = {
      kind: 'review',
      share: {
        redact: (data) => ({
          findings: (data as typeof source.data).findings.map((finding) => ({
            id: finding.id,
            path: 'src/a.ts',
          })),
        }),
        snapshot,
      },
    };
    const built = buildSurfaceShare(source, handler, { includeFullDiff: true });
    const bundle = parseBundle(built.text);
    expect(bundle).toMatchObject({
      kind: 'surface:review',
      version: 4,
      digest: 'Review · 2 findings',
    });
    expect(bundle.payload).toEqual({ findings: [{ id: 'f1', path: 'src/a.ts' }] });
    expect(built.text).not.toContain('/Users/me');
    expect(built.text).not.toContain('private');
    expect(snapshot).toHaveBeenCalledWith(bundle.payload, 'Review: main', {
      includeComments: false,
      includeFullDiff: true,
    });
    expect(bundle.snapshot.css).toContain('.x{}');
    expect(built.availableOptions).toEqual({ includeComments: true, includeFullDiff: true });
    expect(built.includes).toContain('The full diff');
  });

  it('rejects kinds without a share entry', () => {
    expect(() => buildSurfaceShare(source, { kind: 'review' })).toThrow(/not shareable/);
    expect(() => buildSurfaceShare(source, undefined)).toThrow(/not shareable/);
  });
});

describe('static documents', () => {
  it('injects the static CSP ahead of the markup and resolves snapshot images', () => {
    const doc = composeStaticDocument('<img src="anvil-image:chart">', 'p{}', {
      images: { chart: 'data:image/png;base64,AAAA' },
    });
    expect(doc.indexOf("script-src 'none'")).toBeLessThan(doc.indexOf('<img'));
    expect(doc).toContain('src="data:image/png;base64,AAAA"');
  });

  it('renders raw text kinds as escaped source', () => {
    const doc = buildPreviewDocument({
      title: 'Notes',
      mediaType: 'text/markdown',
      text: '<b>x</b>',
      byteLength: 8,
    });
    expect(doc).toContain('<pre>&lt;b&gt;x&lt;/b&gt;</pre>');
  });

  it('strips scripts, handlers and javascript: URLs', () => {
    expect(
      stripScripts(
        '<a href="javascript:alert(1)" onmouseover=\'x()\'>x</a><iframe src="y"></iframe>',
      ),
    ).toBe('<a href="#">x</a>');
    expect(sanitizeSvg('not an svg')).toBeNull();
  });
});
