import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from '../CodeBlock';

describe('CodeBlock', () => {
  it('renders line numbers before syntax highlighting completes', () => {
    const markup = renderToStaticMarkup(
      createElement(CodeBlock, { 'data-fenced': true }, 'const answer = 42;\nreturn answer;'),
    );

    expect(markup).toContain('data-line-number-gutter="true"');
    expect(markup).toContain('<div>1</div><div>2</div>');
    expect(markup).toContain('const answer = 42;\nreturn answer;');
  });
});
