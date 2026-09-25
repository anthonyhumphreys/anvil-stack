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

  it('bounds collapsed output and line-number DOM for very large streams', () => {
    const code = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`).join('\n');
    const markup = renderToStaticMarkup(createElement(CodeBlock, { 'data-fenced': true }, code));

    expect(markup.match(/<div>\d+<\/div>/g)).toHaveLength(20);
    expect(markup).toContain('Show more (20,000 lines,');
    expect(markup).not.toContain('line 20,000');
  });

  it('truncates a single enormous line until the code block is expanded', () => {
    const code = `${'x'.repeat(12_000)}tail-marker`;
    const markup = renderToStaticMarkup(createElement(CodeBlock, { 'data-fenced': true }, code));

    expect(markup).toContain('12,011 characters');
    expect(markup).not.toContain('tail-marker');
  });
});
