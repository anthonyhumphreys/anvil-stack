import { describe, expect, it } from 'vitest';
import {
  parseChangedRanges,
  splitDiffByFile,
  summarizeDiffFiles,
} from '../code-review-git.service';

describe('parseChangedRanges', () => {
  it('records current and base line ranges from a unified diff', () => {
    expect(
      parseChangedRanges(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -4,3 +4,4 @@
 keep
-old
+new
+added
 keep`),
    ).toEqual([
      { side: 'base', startLine: 5, endLine: 5 },
      { side: 'current', startLine: 5, endLine: 6 },
    ]);
  });

  it('anchors deletion-only hunks on the current side', () => {
    expect(
      parseChangedRanges(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,4 +10,2 @@
 keep
-removed one
-removed two
 keep`),
    ).toEqual([
      { side: 'base', startLine: 11, endLine: 12 },
      { side: 'current', startLine: 11, endLine: 11 },
    ]);
  });
});

describe('splitDiffByFile', () => {
  it('retains added and deleted files with their change status', () => {
    const files = splitDiffByFile(`diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export {};
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export {};
`);

    expect(files.map(({ filePath, status }) => ({ filePath, status }))).toEqual([
      { filePath: 'src/new.ts', status: 'added' },
      { filePath: 'src/old.ts', status: 'deleted' },
    ]);
  });

  it('captures renamed paths', () => {
    const [file] = splitDiffByFile(`diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
`);

    expect(file).toMatchObject({
      filePath: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
      status: 'renamed',
    });
  });
});

describe('summarizeDiffFiles', () => {
  it('returns totals for the PR map legend', () => {
    expect(
      summarizeDiffFiles([
        { filePath: 'one.ts', status: 'added' },
        { filePath: 'two.ts', status: 'modified' },
        { filePath: 'three.ts', status: 'modified' },
      ]),
    ).toMatchObject({ additions: 1, modifications: 2, deletions: 0, renames: 0 });
  });
});
