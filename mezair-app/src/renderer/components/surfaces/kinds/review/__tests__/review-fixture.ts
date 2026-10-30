import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import { parseUnifiedDiff } from '../../../../../../shared/surfaces/kinds/review/diff';
import type {
  ReviewFinding,
  ReviewSurfaceData,
} from '../../../../../../shared/surfaces/kinds/review/types';

const [refresh, gateway] = parseUnifiedDiff(
  [
    'diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts',
    '--- a/src/auth/refresh.ts',
    '+++ b/src/auth/refresh.ts',
    '@@ -10,4 +10,5 @@ export async function refresh(token: string) {',
    '   const session = await load(token);',
    '-  const next = rotate(session);',
    '+  const next = await rotate(session);',
    '+  cache.set(token, next);',
    '   return next;',
    ' }',
    'diff --git a/src/gateway/route.ts b/src/gateway/route.ts',
    '--- a/src/gateway/route.ts',
    '+++ b/src/gateway/route.ts',
    '@@ -1,2 +1,3 @@',
    ' import { refresh } from "../auth/refresh";',
    '+export const route = "/token";',
    ' export default refresh;',
    '',
  ].join('\n'),
);

export function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'f1',
    severity: 'high',
    category: 'Bug Risk',
    title: 'Cache write races the rotation',
    rationale: 'Two concurrent refreshes can both rotate; the second write wins.',
    filePath: 'src/auth/refresh.ts',
    lineStart: 11,
    lineEnd: 12,
    status: 'open',
    chapterId: 'c1',
    ...overrides,
  };
}

export function reviewData(overrides: Partial<ReviewSurfaceData> = {}): ReviewSurfaceData {
  return {
    scope: { type: 'working-tree', repoId: 'repo-1' },
    verdict: {
      decision: 'ship-with-fixes',
      summary: 'Good to merge once the cache write is locked.',
      source: 'computed',
    },
    stats: { files: 2, additions: 3, deletions: 1 },
    risks: [{ id: 'r1', title: 'Concurrent refresh', severity: 'high', chapterId: 'c1' }],
    chapters: [
      {
        id: 'c1',
        index: 1,
        title: 'Token refresh moves to the gateway',
        summary: 'Refresh now awaits rotation and caches the result.',
        files: [{ path: 'src/auth/refresh.ts', additions: 2, deletions: 1 }],
      },
      {
        id: 'c2',
        index: 2,
        title: 'Gateway exposes the route',
        summary: 'A new route constant.',
        files: [{ path: 'src/gateway/route.ts', additions: 1, deletions: 0 }],
      },
    ],
    findings: [
      finding(),
      finding({
        id: 'f2',
        severity: 'low',
        title: 'Name the route constant',
        filePath: 'src/gateway/route.ts',
        lineStart: 2,
        lineEnd: 2,
        chapterId: 'c2',
      }),
      finding({
        id: 'f3',
        severity: 'medium',
        title: 'Return type widened',
        lineStart: 13,
        lineEnd: 13,
        status: 'dismissed',
        dismissReason: 'Intentional.',
      }),
    ],
    files: [
      { path: 'src/auth/refresh.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'src/gateway/route.ts', status: 'modified', additions: 1, deletions: 0 },
    ],
    hunks: { 'src/auth/refresh.ts': refresh.hunks, 'src/gateway/route.ts': gateway.hunks },
    fullDiff: { 'src/auth/refresh.ts': refresh.hunks, 'src/gateway/route.ts': gateway.hunks },
    ...overrides,
  };
}

export function reviewIntent(data: ReviewSurfaceData, streaming = false): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 2,
    scope: { threadId: 'thread-1' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'review',
      title: 'Review · working tree',
      key: 'review:repo-1:working-tree',
      streaming,
      digest: 'Review: ship after 1 fix',
      data,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
