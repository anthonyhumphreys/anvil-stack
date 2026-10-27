import { describe, expect, it } from 'vitest';
import type { ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review/types.js';
import { buildReviewSurfaceData, setFindingStatus } from '../review/build.js';
import { buildReviewSnapshot, redactReviewData } from '../review/snapshot.js';
import { REVIEW_FIXTURE_CONTEXT, fixtureFinding } from './review-fixture.js';

function review(): ReviewSurfaceData {
  const data = buildReviewSurfaceData(
    {
      chapters: [
        {
          id: 'c1',
          title: 'Token refresh moves to the gateway',
          summary: 'Caches <rotations>.',
          files: ['src/auth/refresh.ts'],
        },
      ],
      risks: [{ title: 'Concurrent refresh', severity: 'high', chapterId: 'c1' }],
      findings: [
        fixtureFinding({
          rationale: 'See /Users/dev/code/app/src/auth/refresh.ts for <script>alert(1)</script>.',
        }),
        fixtureFinding({
          id: 'f2',
          severity: 'low',
          title: 'Name the audit helper',
          lineStart: 14,
          lineEnd: 14,
          suggestedPatch: '@@ -14 +14 @@\n-  audit(next);\n+  auditRotation(next);\n',
        }),
      ],
    },
    REVIEW_FIXTURE_CONTEXT,
  );
  return setFindingStatus(data, ['f2'], 'dismissed', {
    dismissReason: 'Private note about naming.',
  });
}

describe('review share snapshot', () => {
  it('is script-free, escaped and contains the verdict, chapters and findings', () => {
    const { html, css } = buildReviewSnapshot(review(), 'Review · working tree', {
      includeComments: false,
      includeFullDiff: false,
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Ship after 1 fix');
    expect(html).toContain('<details class="chapter" open>');
    expect(html).toContain('Token refresh moves to the gateway');
    expect(html).toContain('Caches &lt;rotations&gt;.');
    expect(html).toContain('Cache write races the rotation');
    expect(html).toContain('src/auth/refresh.ts:13-14');
    expect(html).toContain('Concurrent refresh');
    expect(html).toContain('Diff around findings');
    expect(html).not.toContain('src/gateway/new.ts');
    expect(html).not.toContain('Private note about naming.');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).not.toMatch(/url\(/);
  });

  it('includes dismiss notes and the full diff only when opted in', () => {
    const { html } = buildReviewSnapshot(review(), 'Review', {
      includeComments: true,
      includeFullDiff: true,
    });
    expect(html).toContain('Private note about naming.');
    expect(html).toContain('src/gateway/new.ts');
    expect(html).toContain('<h2>Diff</h2>');
  });

  it('redacts absolute local paths to repo-relative', () => {
    const data = review();
    data.findings[0].filePath = '/Users/dev/code/app/src/auth/refresh.ts';
    const redacted = redactReviewData(data, '/Users/dev/code/app');
    expect(redacted.findings[0].filePath).toBe('src/auth/refresh.ts');
    expect(redacted.findings[0].rationale).toContain('See src/auth/refresh.ts');
    expect(JSON.stringify(redacted)).not.toContain('/Users/dev/code/app');
    expect(redacted.findings[1].dismissReason).toBe('Private note about naming.');
    expect(data.findings[0].filePath).toBe('/Users/dev/code/app/src/auth/refresh.ts');
  });
});
