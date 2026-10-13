import { describe, expect, it } from 'vitest';
import { reviewSurfaceKind } from '../../../../shared/surfaces/kinds/review.js';
import {
  buildReviewDigest,
  computeDecision,
  decisionBounds,
  isDecisionConsistent,
  reconcileVerdict,
  verdictHeadline,
} from '../../../../shared/surfaces/kinds/review/model.js';
import type { ReviewSurfaceData } from '../../../../shared/surfaces/kinds/review/types.js';
import { validateJsonSchema } from '../../validate.js';
import {
  ReviewInputError,
  applyReviewOps,
  buildReviewSurfaceData,
  opsNeedDiff,
  setFindingStatus,
} from '../review/build.js';
import { REVIEW_FIXTURE_CONTEXT, fixtureFinding } from './review-fixture.js';

function build(input: Parameters<typeof buildReviewSurfaceData>[0] = {}): ReviewSurfaceData {
  return buildReviewSurfaceData(
    {
      chapters: [
        {
          id: 'c1',
          title: 'Token refresh moves to the gateway',
          summary: 'Refresh now caches.',
          files: ['src/auth/refresh.ts', 'src/gateway/new.ts'],
        },
        { title: 'Legacy cleanup', files: ['/Users/dev/code/app/src/old/legacy.ts'] },
      ],
      findings: [fixtureFinding()],
      risks: [{ title: 'Concurrent refresh', severity: 'high', chapterId: 'c1' }],
      ...input,
    },
    REVIEW_FIXTURE_CONTEXT,
  );
}

function expectInputError(fn: () => unknown): ReviewInputError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewInputError);
    return error as ReviewInputError;
  }
  throw new Error('expected a ReviewInputError');
}

describe('verdict rules', () => {
  const f = (severity: string, status = 'open') => ({ severity, status }) as never;

  it('computes the decision from active severities', () => {
    expect(computeDecision([])).toBe('ship');
    expect(computeDecision([f('low'), f('info')])).toBe('ship');
    expect(computeDecision([f('medium')])).toBe('ship-with-fixes');
    expect(computeDecision([f('high'), f('high')])).toBe('ship-with-fixes');
    expect(computeDecision([f('high'), f('high'), f('high')])).toBe('needs-work');
    expect(computeDecision([f('critical')])).toBe('blocked');
    expect(computeDecision([f('critical', 'fixed'), f('high', 'dismissed')])).toBe('ship');
  });

  it('checks agent decisions against severity bounds', () => {
    expect(isDecisionConsistent('ship', [f('critical')])).toBe(false);
    expect(isDecisionConsistent('needs-work', [f('critical')])).toBe(true);
    expect(isDecisionConsistent('blocked', [f('medium')])).toBe(false);
    expect(isDecisionConsistent('ship-with-fixes', [])).toBe(false);
    expect(decisionBounds([f('high')])).toEqual({
      min: 'ship-with-fixes',
      max: 'needs-work',
      suggested: 'ship-with-fixes',
    });
  });

  it('reconciles: computed verdicts follow statuses, agent verdicts clamp', () => {
    const findings = [f('high'), f('medium')];
    const agent = {
      decision: 'needs-work' as const,
      summary: 'Rework the cache.',
      source: 'agent' as const,
    };
    expect(reconcileVerdict(agent, findings)).toBe(agent);
    const afterFix = [f('high', 'fixed'), f('medium')];
    expect(reconcileVerdict(agent, afterFix).decision).toBe('ship-with-fixes');
    expect(reconcileVerdict(undefined, afterFix)).toMatchObject({
      decision: 'ship-with-fixes',
      source: 'computed',
    });
  });

  it('writes "Ship after N fixes" headlines and a compact digest', () => {
    expect(verdictHeadline('ship-with-fixes', [f('high'), f('medium'), f('low')])).toBe(
      'Ship after 2 fixes',
    );
    const data = build();
    expect(buildReviewDigest(data)).toMatch(
      /^Review: ship after 1 fix · 3 files \+66 −5 · 1 risk · 1 finding \(1 high\)\nActive: f1 high src\/auth\/refresh.ts:13-14$/,
    );
    expect(reviewSurfaceKind.digest(data)).toBe(buildReviewDigest(data));
  });
});

describe('buildReviewSurfaceData', () => {
  it('builds a schema-valid payload with stats, files, hunks and chapter inference', () => {
    const data = build();
    expect(validateJsonSchema(reviewSurfaceKind.schema, data)).toEqual([]);
    expect(data.stats).toEqual({ files: 3, additions: 66, deletions: 5 });
    expect(
      data.chapters.map((chapter) => [chapter.id, chapter.index, chapter.files.length]),
    ).toEqual([
      ['c1', 1, 2],
      ['c2', 2, 1],
    ]);
    expect(data.chapters[1].files[0]).toEqual({
      path: 'src/old/legacy.ts',
      additions: 0,
      deletions: 3,
    });
    expect(data.findings[0]).toMatchObject({ status: 'open', chapterId: 'c1' });
    expect(Object.keys(data.hunks)).toEqual(['src/auth/refresh.ts']);
    expect(data.hunks['src/auth/refresh.ts']).toHaveLength(1);
    expect(data.fullDiff && Object.keys(data.fullDiff)).toHaveLength(3);
    expect(data.verdict).toMatchObject({ decision: 'ship-with-fixes', source: 'computed' });
  });

  it('rejects unanchored line claims and lists every offending id', () => {
    const error = expectInputError(() =>
      build({
        findings: [
          fixtureFinding(),
          fixtureFinding({ id: 'f2', lineStart: 300, lineEnd: 310 }),
          fixtureFinding({ id: 'f3', filePath: 'src/not-in-diff.ts' }),
          fixtureFinding({ id: 'f4', lineStart: undefined, lineEnd: undefined }),
        ],
      }),
    );
    expect(error.issues).toHaveLength(3);
    expect(error.message).toContain('3 finding(s) are not anchored to the working-tree diff');
    expect(error.message).toContain(
      'f2 (src/auth/refresh.ts:300-310): lines are outside the changed hunks',
    );
    expect(error.message).toContain('f3 (src/not-in-diff.ts): file is not part of this diff');
    expect(error.message).toContain('f4 (src/auth/refresh.ts): needs lineStart/lineEnd');
  });

  it('rejects verdicts that contradict severities', () => {
    const error = expectInputError(() =>
      build({
        findings: [fixtureFinding({ severity: 'critical' })],
        verdict: { decision: 'ship', summary: 'LGTM' },
      }),
    );
    expect(error.message).toContain("verdict.decision 'ship' is inconsistent");
    expect(error.message).toContain("'needs-work' or 'blocked'");
  });

  it('keeps consistent agent verdicts and maps rubric severities', () => {
    const data = build({
      findings: [fixtureFinding({ severity: 'major' })],
      verdict: { decision: 'needs-work', summary: 'The cache write needs a lock.' },
    });
    expect(data.findings[0].severity).toBe('high');
    expect(data.verdict).toEqual({
      decision: 'needs-work',
      summary: 'The cache write needs a lock.',
      source: 'agent',
    });
  });

  it('validates chapters, risks, duplicate ids and suggested patches', () => {
    const error = expectInputError(() =>
      build({
        chapters: [{ id: 'c1', title: 'A', files: ['src/missing.ts'] }],
        risks: [{ title: 'R', severity: 'high', chapterId: 'nope' }],
        findings: [
          fixtureFinding(),
          fixtureFinding(),
          fixtureFinding({
            id: 'f9',
            suggestedPatch: '--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n',
          }),
        ],
      }),
    );
    expect(error.message).toContain(
      'chapter c1 lists files that are not in this diff: src/missing.ts',
    );
    expect(error.message).toContain('risk r1 references unknown chapter "nope"');
    expect(error.message).toContain('finding id "f1" is used more than once');
    expect(error.message).toContain('suggestedPatch may only touch src/auth/refresh.ts');
  });
});

describe('applyReviewOps', () => {
  it('adds anchored findings and rebuilds hunks for the touched file', () => {
    const data = build();
    const next = applyReviewOps(
      data,
      [
        {
          op: 'add_finding',
          finding: fixtureFinding({
            id: undefined,
            severity: 'medium',
            filePath: 'src/gateway/new.ts',
            lineStart: 30,
            lineEnd: 30,
          }),
        },
      ],
      REVIEW_FIXTURE_CONTEXT,
    );
    expect(next.findings.map((finding) => finding.id)).toEqual(['f1', 'f2']);
    expect(next.hunks['src/gateway/new.ts'][0].header).toMatch(/^@@ -0,0 \+26,/);
    expect(data.findings).toHaveLength(1);
  });

  it('rejects unanchored add_finding with the id listed', () => {
    const error = expectInputError(() =>
      applyReviewOps(
        build(),
        [
          {
            op: 'add_finding',
            finding: fixtureFinding({ id: 'f7', lineStart: 999, lineEnd: 999 }),
          },
        ],
        REVIEW_FIXTURE_CONTEXT,
      ),
    );
    expect(error.message).toContain('f7 (src/auth/refresh.ts:999-999)');
  });

  it('sets statuses, links fixes and recomputes the verdict', () => {
    const data = build();
    const fixed = applyReviewOps(data, [
      { op: 'link_fix', findingIds: ['f1'], surfaceId: 's-2', note: 'Locked the cache write.' },
    ]);
    expect(fixed.findings[0]).toMatchObject({
      status: 'fixed',
      fixedInSurfaceId: 's-2',
      fixNote: 'Locked the cache write.',
    });
    expect(fixed.verdict.decision).toBe('ship');
    const reopened = applyReviewOps(fixed, [
      { op: 'set_status', findingIds: ['f1'], status: 'open' },
    ]);
    expect(reopened.findings[0].fixNote).toBeUndefined();
    expect(reopened.verdict.decision).toBe('ship-with-fixes');
  });

  it('updates findings without re-anchoring unless they move', () => {
    const data = build();
    const retitled = applyReviewOps(data, [
      {
        op: 'update_finding',
        findingId: 'f1',
        changes: { title: 'Sharper title', severity: 'critical' },
      },
    ]);
    expect(retitled.findings[0]).toMatchObject({
      title: 'Sharper title',
      severity: 'critical',
      lineStart: 13,
    });
    expect(retitled.verdict.decision).toBe('blocked');
    expect(() =>
      applyReviewOps(
        data,
        [{ op: 'update_finding', findingId: 'f1', changes: { lineStart: 500, lineEnd: 501 } }],
        REVIEW_FIXTURE_CONTEXT,
      ),
    ).toThrow(ReviewInputError);
    expect(opsNeedDiff([{ op: 'update_finding', changes: { title: 'x' } }])).toBe(false);
    expect(opsNeedDiff([{ op: 'update_finding', changes: { lineStart: 3 } }])).toBe(true);
  });

  it('validates set_verdict against the final findings and rejects unknown ops/ids', () => {
    const data = build();
    expect(
      applyReviewOps(data, [{ op: 'set_verdict', decision: 'needs-work', summary: 'Hold.' }])
        .verdict,
    ).toEqual({
      decision: 'needs-work',
      summary: 'Hold.',
      source: 'agent',
    });
    expect(() => applyReviewOps(data, [{ op: 'set_verdict', decision: 'blocked' }])).toThrow(
      /inconsistent/,
    );
    const error = expectInputError(() =>
      applyReviewOps(data, [
        { op: 'explode' },
        { op: 'set_status', findingIds: ['zz'], status: 'accepted' },
      ]),
    );
    expect(error.message).toContain('unknown op "explode"');
    expect(error.message).toContain('unknown finding id(s) zz');
  });

  it('records dismiss reasons and clears them on reopen', () => {
    const dismissed = setFindingStatus(build(), ['f1'], 'dismissed', {
      dismissReason: 'Single-threaded worker.',
    });
    expect(dismissed.findings[0].dismissReason).toBe('Single-threaded worker.');
    expect(dismissed.verdict.decision).toBe('ship');
    expect(setFindingStatus(dismissed, ['f1'], 'open').findings[0].dismissReason).toBeUndefined();
  });
});
