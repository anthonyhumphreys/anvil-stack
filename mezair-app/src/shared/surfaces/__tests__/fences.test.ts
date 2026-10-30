import { describe, expect, it } from 'vitest';
import {
  hasSurfaceFence,
  parseSurfaceFenceHeader,
  parseSurfaceFences,
  type SurfaceFenceBlockSegment,
} from '../fences.js';

const blocks = (text: string) =>
  parseSurfaceFences(text).filter(
    (segment): segment is SurfaceFenceBlockSegment => segment.type !== 'text',
  );

describe('parseSurfaceFenceHeader', () => {
  it('matches the post-turn artifact header grammar', () => {
    expect(
      parseSurfaceFenceHeader(
        'artifact:plans/delivery.md kind=markdown title="Delivery plan" storage=session',
      ),
    ).toMatchObject({
      path: 'plans/delivery.md',
      kind: 'markdown',
      title: 'Delivery plan',
      storage: 'session',
    });
    expect(
      parseSurfaceFenceHeader("artifact kind=docx title='Deck' encoding=file path=decks/q3.docx"),
    ).toMatchObject({ path: 'decks/q3.docx', kind: 'docx', encoding: 'file', title: 'Deck' });
    expect(parseSurfaceFenceHeader('artifact kind=bogus persist=repository')).toMatchObject({
      storage: 'repository',
      attributes: { kind: 'bogus', persist: 'repository' },
    });
    expect(parseSurfaceFenceHeader('artifact')?.kind).toBeUndefined();
    expect(parseSurfaceFenceHeader('artifacts')).toBeNull();
    expect(parseSurfaceFenceHeader('ts')).toBeNull();
  });

  it('parses sketch headers', () => {
    expect(parseSurfaceFenceHeader('sketch title="Latency by region" height=320')).toMatchObject({
      title: 'Latency by region',
      height: 320,
    });
  });
});

describe('parseSurfaceFences', () => {
  it('splits prose and complete fences', () => {
    const text = [
      'Here is the plan.',
      '```artifact:plan.md kind=markdown title="Plan"',
      '# Plan',
      '',
      '- step',
      '```',
      'Done.',
    ].join('\n');
    const segments = parseSurfaceFences(text);
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'artifact', 'text']);
    expect(segments[0]).toEqual({ type: 'text', text: 'Here is the plan.\n' });
    expect(segments[1]).toMatchObject({
      index: 0,
      complete: true,
      body: '# Plan\n\n- step',
      header: { path: 'plan.md', title: 'Plan', kind: 'markdown' },
    });
    expect(segments[2]).toEqual({ type: 'text', text: 'Done.' });
    expect(hasSurfaceFence(text)).toBe(true);
  });

  it('streams partial input without flashing fence syntax', () => {
    const full = 'Intro\n```sketch title="Chart"\n<div>bars</div>\n```\nOutro';
    const states = Array.from({ length: full.length + 1 }, (_, end) => full.slice(0, end));
    for (const partial of states) {
      const segments = parseSurfaceFences(partial);
      const text = segments
        .filter((segment) => segment.type === 'text')
        .map((segment) => (segment as { text: string }).text)
        .join('');
      if (partial.includes('```sketch')) expect(text).not.toContain('```sketch');
      const block = blocks(partial)[0];
      if (block && !block.complete) expect(block.body).not.toMatch(/`$/);
    }
    const partialHeader = blocks('Intro\n```sketch title="Ch')[0];
    expect(partialHeader).toMatchObject({ complete: false, body: '' });
    expect(partialHeader.header.title).toBeUndefined();
    expect(blocks('Intro\n```sketch title="Chart"\n<div>ba')[0]).toMatchObject({
      complete: false,
      body: '<div>ba',
      header: { title: 'Chart' },
    });
    expect(blocks('Intro\n```sketch\n<div></div>\n``')[0]).toMatchObject({
      complete: false,
      body: '<div></div>\n',
    });
    expect(blocks(full)[0]).toMatchObject({ complete: true, body: '<div>bars</div>' });
  });

  it('treats a closing fence at the end of the text as complete', () => {
    expect(blocks('```artifact kind=text\nhello\n```')[0]).toMatchObject({
      complete: true,
      body: 'hello',
    });
  });

  it('keeps nested code blocks inside an artifact', () => {
    const text = [
      '```artifact:guide.md kind=markdown',
      'Run:',
      '```bash',
      'pnpm test',
      '```',
      'Inline ``` backticks stay too.',
      '```',
      'after',
    ].join('\n');
    const [block] = blocks(text);
    expect(block.complete).toBe(true);
    expect(block.body).toBe('Run:\n```bash\npnpm test\n```\nInline ``` backticks stay too.');
    expect(parseSurfaceFences(text).at(-1)).toEqual({ type: 'text', text: 'after' });
  });

  it('supports longer outer fences', () => {
    const text = '````artifact kind=markdown\n```\nplain block\n```\n````';
    expect(blocks(text)[0]).toMatchObject({ complete: true, body: '```\nplain block\n```' });
  });

  it('leaves example fences inside ordinary code blocks as text', () => {
    const text = 'Example:\n```markdown\n```artifact kind=text\nnot real\n```\n```\nEnd';
    expect(blocks(text)).toHaveLength(0);
    expect(parseSurfaceFences(text)).toEqual([{ type: 'text', text }]);
  });

  it('handles encoding=file artifacts and multiple fences with stable indexes', () => {
    const text = [
      '```artifact:decks/q3.pptx kind=pptx encoding=file title="Q3 deck"',
      'Quarterly review deck',
      '```',
      'and',
      '```sketch title="Mix"',
      '<p>mix</p>',
      '```',
    ].join('\n');
    const result = blocks(text);
    expect(result.map((block) => [block.type, block.index])).toEqual([
      ['artifact', 0],
      ['sketch', 1],
    ]);
    expect(result[0].header).toMatchObject({
      encoding: 'file',
      kind: 'pptx',
      path: 'decks/q3.pptx',
    });
    expect(result[0].body).toBe('Quarterly review deck');
    expect(text.slice(result[1].start, result[1].end)).toBe(
      '```sketch title="Mix"\n<p>mix</p>\n```',
    );
  });

  it('returns plain text unchanged when there are no fences', () => {
    expect(parseSurfaceFences('just prose\n```ts\nconst a = 1;\n```')).toEqual([
      { type: 'text', text: 'just prose\n```ts\nconst a = 1;\n```' },
    ]);
    expect(parseSurfaceFences('')).toEqual([]);
    expect(hasSurfaceFence('```ts\n')).toBe(false);
  });
});
