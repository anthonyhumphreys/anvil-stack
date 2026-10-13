import { parseUnifiedDiff } from '../../../../shared/surfaces/kinds/review/diff.js';
import type { ReviewDiffContext } from '../review/build.js';

const longBody = Array.from(
  { length: 60 },
  (_, index) => `+  const line${index + 1} = ${index + 1};`,
);

/** Two modified files, one added file with a long hunk, one deleted file. */
export const REVIEW_FIXTURE_DIFF = [
  'diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth/refresh.ts',
  '+++ b/src/auth/refresh.ts',
  '@@ -10,6 +10,8 @@ export async function refresh(token: string) {',
  '   const session = await load(token);',
  '   if (!session) return null;',
  '-  const next = rotate(session);',
  '+  const next = await rotate(session);',
  '+  cache.set(token, next);',
  '+  audit(next);',
  '   return next;',
  ' }',
  ' ',
  '@@ -40,3 +42,3 @@ function rotate(session: Session) {',
  '   const id = session.id;',
  '-  return { id, at: Date.now() };',
  '+  return { id, at: now() };',
  ' }',
  '',
  'diff --git a/src/gateway/new.ts b/src/gateway/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/gateway/new.ts',
  '@@ -0,0 +1,62 @@',
  '+export function gateway() {',
  ...longBody,
  '+}',
  'diff --git a/src/old/legacy.ts b/src/old/legacy.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/old/legacy.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-export const legacy = true;',
  '-export const other = false;',
  '-// end',
  '',
].join('\n');

export const REVIEW_FIXTURE_FILES = parseUnifiedDiff(REVIEW_FIXTURE_DIFF);

export const REVIEW_FIXTURE_CONTEXT: ReviewDiffContext = {
  scope: { type: 'working-tree', repoId: 'repo-1' },
  files: REVIEW_FIXTURE_FILES,
  repoPath: '/Users/dev/code/app',
};

export function fixtureFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    severity: 'high',
    category: 'Bug Risk',
    title: 'Cache write races the rotation',
    rationale: 'Two concurrent refreshes can both rotate and the second write wins.',
    filePath: 'src/auth/refresh.ts',
    lineStart: 13,
    lineEnd: 14,
    ...overrides,
  };
}
