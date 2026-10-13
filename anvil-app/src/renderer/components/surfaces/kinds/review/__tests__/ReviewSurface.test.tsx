import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SurfaceViewProps } from '../../../types';
import { reviewSurfaceView } from '..';
import { ReviewDiff } from '../ReviewDiff';
import { finding, reviewData, reviewIntent } from './review-fixture';

function props(data = reviewData(), streaming = false): SurfaceViewProps {
  return {
    intent: reviewIntent(data, streaming),
    presentation: 'inline',
    onAction: async () => ({ ok: true }),
    onComment: () => undefined,
    onOpenStage: () => undefined,
  };
}

describe('Review inline surface', () => {
  const { Inline, Stage } = reviewSurfaceView;

  it('renders the verdict line, risks, chapters, grouped findings and footer', () => {
    const markup = renderToStaticMarkup(<Inline {...props()} />);
    expect(markup).toContain('Ship after 1 fix');
    expect(markup).toContain('Good to merge once the cache write is locked.');
    expect(markup).toContain('2 files');
    expect(markup).toContain('Concurrent refresh');
    expect(markup).toContain('ch. 1');
    expect(markup).toContain('Token refresh moves to the gateway');
    expect(markup).toContain('Refresh now awaits rotation and caches the result.');
    expect(markup).toContain('Cache write races the rotation');
    expect(markup).toContain('src/auth/refresh.ts:11-12');
    // Low and fully-resolved groups start collapsed: their rows are not rendered.
    expect(markup).not.toContain('Name the route constant');
    expect(markup).not.toContain('Return type widened');
    expect(markup).toContain('Ask agent to fix selected');
    expect(markup).toContain('Accept all');
    expect(markup).toContain('Create work items');
    expect(markup).toContain('Open stage');
    expect(markup).not.toContain('Post to PR');
  });

  it('pairs every severity and status with a text label, not colour alone', () => {
    const markup = renderToStaticMarkup(<Inline {...props()} />);
    expect(markup).toContain('>High<');
    expect(markup).toContain('>Open<');
    expect(markup).toMatch(/sr-only">\s*\(Ship with fixes\)/);
  });

  it('shows Post to PR only for pull request scopes', () => {
    const data = reviewData({
      scope: { type: 'pull-request', repoId: 'repo-1', pullRequestId: '42' },
    });
    expect(renderToStaticMarkup(<Inline {...props(data)} />)).toContain('Post to PR');
  });

  it('hides mutation actions in read-only threads', () => {
    const data = reviewData({
      scope: { type: 'pull-request', repoId: 'repo-1', pullRequestId: '42' },
    });
    const editable = renderToStaticMarkup(<Inline {...props(data)} />);
    expect(editable).toContain('Post to PR');
    expect(editable).toContain('Create work items');
    const inline = renderToStaticMarkup(<Inline {...props(data)} readOnly />);
    expect(inline).not.toContain('Post to PR');
    expect(inline).not.toContain('Create work items');
    expect(inline).toContain('Ask agent to fix');
    if (!Stage) return;
    const stage = renderToStaticMarkup(<Stage {...props(data)} presentation="stage" readOnly />);
    expect(stage).not.toContain('Post to PR');
    expect(stage).not.toContain('Create work items');
    expect(stage).not.toContain('Apply patch');
  });

  it('streams: provisional verdict, fading rows and a skeleton before the first finding', () => {
    const streamingMarkup = renderToStaticMarkup(<Inline {...props(reviewData(), true)} />);
    expect(streamingMarkup).toContain('Reviewing');
    expect(streamingMarkup).toContain('starting:opacity-0');
    expect(streamingMarkup).toContain('motion-reduce:transition-none');
    expect(streamingMarkup).toContain('More findings on the way');
    const empty = renderToStaticMarkup(<Inline {...props(reviewData({ findings: [] }), true)} />);
    expect(empty).toContain('motion-safe:animate-pulse');
  });

  it('falls back to the digest for malformed payloads', () => {
    const base = props();
    const markup = renderToStaticMarkup(
      <Inline
        {...base}
        intent={{ ...base.intent, payload: { ...base.intent.payload, data: {} } }}
      />,
    );
    expect(markup).toContain('Review: ship after 1 fix');
  });

  it('renders the stage workbench with file tree, diff callouts and finding detail', () => {
    expect(Stage).toBeDefined();
    if (!Stage) return;
    const markup = renderToStaticMarkup(<Stage {...props()} presentation="stage" />);
    expect(markup).toContain('aria-label="Chapters and files"');
    expect(markup).toContain('refresh.ts');
    expect(markup).toContain('data-callout="f1"');
    expect(markup).toContain('Two concurrent refreshes can both rotate');
    expect(markup).toContain('Unified');
    expect(markup).toContain('Split');
    expect(markup).toContain('All findings · 3');
    expect(markup).toContain('aria-keyshortcuts');
  });
});

describe('ReviewDiff', () => {
  it('numbers lines, marks finding ranges in the gutter and renders callouts at the range end', () => {
    const data = reviewData();
    const markup = renderToStaticMarkup(
      <ReviewDiff
        filePath="src/auth/refresh.ts"
        hunks={data.hunks['src/auth/refresh.ts']}
        findings={[finding()]}
        focusedId="f1"
        renderCallout={(entry) => <span>callout:{entry.id}</span>}
      />,
    );
    expect(markup).toContain('@@ -10,4 +10,5 @@');
    expect(markup).toContain('Finding f1 starts here');
    expect(markup).toContain('callout:f1');
    expect(markup).toContain('Added: ');
    expect(markup).toContain('Removed: ');
    expect(markup.indexOf('callout:f1')).toBeGreaterThan(markup.indexOf('cache.set(token, next);'));
    expect(markup.indexOf('callout:f1')).toBeLessThan(markup.indexOf('return next;'));
  });

  it('renders line selection buttons only when selection is enabled', () => {
    const data = reviewData();
    const hunks = data.hunks['src/auth/refresh.ts'];
    const plain = renderToStaticMarkup(<ReviewDiff filePath="a.ts" hunks={hunks} findings={[]} />);
    expect(plain).not.toContain('Shift-click to extend');
    const selectable = renderToStaticMarkup(
      <ReviewDiff
        filePath="a.ts"
        hunks={hunks}
        findings={[]}
        split
        lineSelection={{ filePath: 'a.ts', start: 11, end: 12 }}
        onSelectLine={() => undefined}
      />,
    );
    expect(selectable).toContain('Line 11, selected');
    expect(selectable).toContain('Line 13. Shift-click to extend.');
  });
});
