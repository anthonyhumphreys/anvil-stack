import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { linkifyBareFileReferences, MarkdownRenderer } from '../MarkdownRenderer';

describe('linkifyBareFileReferences', () => {
  it('converts bare source paths into markdown links', () => {
    expect(linkifyBareFileReferences('See src/renderer/App.tsx:31 for the route.')).toBe(
      'See [src/renderer/App.tsx:31](src/renderer/App.tsx:31) for the route.',
    );
  });

  it('keeps punctuation outside the generated link', () => {
    expect(linkifyBareFileReferences('Open src/main/index.ts, then retry.')).toBe(
      'Open [src/main/index.ts](src/main/index.ts), then retry.',
    );
  });

  it('does not linkify fenced or inline code', () => {
    const content = [
      'Run `cat src/main/index.ts`.',
      '',
      '```ts',
      'import "./src/renderer/App.tsx";',
      '```',
    ].join('\n');

    expect(linkifyBareFileReferences(content)).toBe(content);
  });

  it('does not rewrite existing markdown links', () => {
    const content = 'Use [the app](src/renderer/App.tsx:31) first.';
    expect(linkifyBareFileReferences(content)).toBe(content);
  });

  it('ignores ordinary slash text without a file signal', () => {
    expect(linkifyBareFileReferences('This is product/design language, not a file.')).toBe(
      'This is product/design language, not a file.',
    );
  });

  it('keeps an unfinished streamed fence visible as code', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownRenderer, { content: 'Answer so far:\n\n```ts\nconst answer = 42;' }),
    );

    expect(markup).toContain('data-line-number-gutter="true"');
    expect(markup).toContain('const answer = 42;');
  });

  it('keeps Mermaid source available while an incomplete diagram is rendering', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: '```mermaid\ngraph TD\n  A -->',
      }),
    );

    expect(markup).toContain('Rendering diagram');
    expect(markup).toContain('Show Mermaid source');
    expect(markup).toContain('A --&gt;');
  });

  it('reserves a stable image frame and exposes loading state', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: '![Build output](https://example.test/build.png)',
      }),
    );

    expect(markup).toContain('aspect-video');
    expect(markup).toContain('Loading image');
    expect(markup).toContain('loading="lazy"');
  });

  it('does not request an image while its markdown destination is unfinished', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownRenderer, {
        content: '![Build output](https://example.test/build.png',
      }),
    );

    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('Loading image');
  });
});
