import { describe, expect, it } from 'vitest';
import { linkifyBareFileReferences } from '../MarkdownRenderer';

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
});
