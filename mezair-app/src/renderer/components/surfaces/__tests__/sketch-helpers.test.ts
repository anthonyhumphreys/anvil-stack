import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKETCH_TOKENS,
  SKETCH_TOKEN_NAMES,
} from '../../../../shared/surfaces/sketch-runtime';
import { deriveSketchTokens, sketchThemeName } from '../sketch-tokens';
import {
  SKETCH_MAX_HEIGHT,
  SKETCH_MIN_HEIGHT,
  parseSketchBridgeMessage,
  safeExternalUrl,
} from '../kinds/sketch/sketch-bridge';
import { sketchFileName } from '../kinds/sketch/SketchSurfaceViews';
import { buildUnifiedDiff } from '../kinds/artifact/artifact-diff';
import { applyRevision } from '../kinds/artifact/useArtifactVersion';

describe('deriveSketchTokens', () => {
  it('maps every sketch token from the active theme variables', () => {
    const values: Record<string, string> = {
      '--color-bg-primary': ' #101010 ',
      '--color-accent': '#ff8a3d',
      '--color-text-primary': '#fafafa',
      '--font-mono': 'Plex Mono',
    };
    const tokens = deriveSketchTokens((name) => values[name] ?? '');
    expect(Object.keys(tokens).sort()).toEqual([...SKETCH_TOKEN_NAMES].sort());
    expect(tokens['--mezair-canvas']).toBe('#101010');
    expect(tokens['--mezair-focus']).toBe('#ff8a3d');
    expect(tokens['--mezair-accent']).toBe('#ff8a3d');
    expect(tokens['--mezair-ink']).toBe('#fafafa');
    expect(tokens['--mezair-font-mono']).toBe('Plex Mono');
    expect(tokens['--mezair-surface']).toBe(DEFAULT_SKETCH_TOKENS.dark['--mezair-surface']);
  });

  it('falls back to the light defaults on the light theme', () => {
    const tokens = deriveSketchTokens(() => '', 'light');
    expect(tokens).toEqual(DEFAULT_SKETCH_TOKENS.light);
    expect(sketchThemeName(tokens)).toBe('light');
    expect(sketchThemeName(deriveSketchTokens(() => ''))).toBe('dark');
  });
});

describe('parseSketchBridgeMessage', () => {
  it('accepts JSON-RPC 2.0 bridge messages only', () => {
    expect(parseSketchBridgeMessage({ method: 'ui/initialize', id: 1 })).toEqual({
      kind: 'ignore',
    });
    expect(parseSketchBridgeMessage('{"jsonrpc":"2.0"}')).toEqual({ kind: 'ignore' });
    expect(parseSketchBridgeMessage({ jsonrpc: '2.0', method: 'ui/initialize', id: 1 })).toEqual({
      kind: 'initialize',
      id: 1,
    });
  });

  it('clamps reported heights', () => {
    const size = (height: unknown) =>
      parseSketchBridgeMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height },
      });
    expect(size(320.4)).toEqual({ kind: 'size', height: 320 });
    expect(size(2)).toEqual({ kind: 'size', height: SKETCH_MIN_HEIGHT });
    expect(size(1e9)).toEqual({ kind: 'size', height: SKETCH_MAX_HEIGHT });
    expect(size('tall')).toEqual({ kind: 'ignore' });
  });

  it('only opens http(s) links', () => {
    const link = (url: unknown) =>
      parseSketchBridgeMessage({ jsonrpc: '2.0', method: 'ui/open-link', params: { url } });
    expect(link('https://example.com/a')).toEqual({
      kind: 'open-link',
      url: 'https://example.com/a',
      id: undefined,
    });
    expect(link('javascript:alert(1)')).toEqual({ kind: 'ignore' });
    expect(link('file:///etc/passwd')).toEqual({ kind: 'ignore' });
    expect(safeExternalUrl('http://x.test')).toBe('http://x.test/');
  });

  it('drafts asks and rejects unknown requests', () => {
    expect(
      parseSketchBridgeMessage({
        jsonrpc: '2.0',
        method: 'mezair/ask',
        params: { prompt: '  Why? ' },
      }),
    ).toEqual({ kind: 'ask', prompt: 'Why?', id: undefined });
    expect(parseSketchBridgeMessage({ jsonrpc: '2.0', method: 'mezair/ask', params: {} })).toEqual({
      kind: 'ignore',
    });
    expect(parseSketchBridgeMessage({ jsonrpc: '2.0', method: 'tools/call', id: 'x' })).toEqual({
      kind: 'unsupported-request',
      id: 'x',
    });
    expect(parseSketchBridgeMessage({ jsonrpc: '2.0', method: 'tools/call' })).toEqual({
      kind: 'ignore',
    });
  });

  it('names downloads from the title', () => {
    expect(sketchFileName('Auth flow: v2!')).toBe('auth-flow-v2.html');
    expect(sketchFileName('???')).toBe('sketch.html');
  });
});

describe('buildUnifiedDiff', () => {
  it('returns nothing for identical text', () => {
    expect(buildUnifiedDiff('a\nb\n', 'a\nb\n', 'x.md')).toBe('');
  });

  it('produces hunks with context and line numbers', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n');
    const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join(
      '\n',
    );
    const diff = buildUnifiedDiff(before, after, 'notes.md', 1);
    expect(diff).toBe(
      [
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -2,3 +2,3 @@',
        ' two',
        '-three',
        '+THREE',
        ' four',
        '@@ -8,1 +8,2 @@',
        ' eight',
        '+nine',
        '',
      ].join('\n'),
    );
  });

  it('handles additions to an empty document', () => {
    expect(buildUnifiedDiff('', 'hello\n', 'a.txt')).toBe(
      ['--- a/a.txt', '+++ b/a.txt', '@@ -0,0 +1,1 @@', '+hello', ''].join('\n'),
    );
  });
});

describe('applyRevision', () => {
  it('shows the revision a turn produced over the head', () => {
    const head = { id: 'a', version: 3, title: 'Head', content: 'v3' } as never;
    expect(applyRevision(head, { version: 1, title: 'First', content: 'v1' })).toMatchObject({
      version: 1,
      title: 'First',
      content: 'v1',
    });
    expect(applyRevision(head, null)).toBe(head);
  });
});
