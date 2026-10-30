import { describe, expect, it } from 'vitest';
import { parseUnifiedDiffLines } from '../DiffViewer';

describe('parseUnifiedDiffLines', () => {
  it('retains source line numbers across separated hunks', () => {
    const rows = parseUnifiedDiffLines(
      [
        'diff --git a/src/file.ts b/src/file.ts',
        '--- a/src/file.ts',
        '+++ b/src/file.ts',
        '@@ -10,2 +10,2 @@ function first()',
        '-before();',
        '+after();',
        ' context();',
        '@@ -42 +43 @@ function last()',
        '-return false;',
        '+return true;',
      ].join('\n'),
    );

    expect(rows).toEqual([
      { kind: 'hunk', text: '@@ -10,2 +10,2 @@ function first()', oldLine: null, newLine: null },
      { kind: 'removed', text: 'before();', oldLine: 10, newLine: null },
      { kind: 'added', text: 'after();', oldLine: null, newLine: 10 },
      { kind: 'context', text: 'context();', oldLine: 11, newLine: 11 },
      { kind: 'hunk', text: '@@ -42 +43 @@ function last()', oldLine: null, newLine: null },
      { kind: 'removed', text: 'return false;', oldLine: 42, newLine: null },
      { kind: 'added', text: 'return true;', oldLine: null, newLine: 43 },
    ]);
  });
});
