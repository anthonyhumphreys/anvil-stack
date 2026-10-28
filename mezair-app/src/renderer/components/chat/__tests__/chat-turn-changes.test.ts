import { describe, expect, it } from 'vitest';
import type { CodexEvent, GitFileChange, RepoInfo } from '../../../../shared/types';
import type { ChatTurnWorkItem } from '../chat-turns';
import {
  buildTurnReviewPrompt,
  checkTurnUndoTarget,
  collectTurnFileChanges,
  createTurnDeliveryReviewRequestGuard,
  countDiffStats,
  countTurnStatuses,
  detectDiffFileStatus,
  evaluateTurnUndo,
  findStatusEntry,
  firstChangedLine,
  formatTurnChangeSummary,
  isLineLevelPatch,
  planTurnUndo,
  repoRelativePath,
  resolveTurnDeliveryRepo,
  resolveChangesRepoId,
  sameTurnChangeSummary,
  splitDisplayPath,
  summarizeTurnChanges,
  turnDeliveryPaths,
  tallyDiffLines,
  tallyEquals,
  tallyFileContent,
  type TurnFileChange,
  type TurnUndoProbe,
} from '../chat-turn-changes';

function workItem(event: CodexEvent, sourceIndex = 0): ChatTurnWorkItem {
  return { kind: 'event', event, sourceIndex };
}

function fileEdit(filePath: string, diff: string): CodexEvent {
  return { type: 'file_edit', filePath, diff } as CodexEvent;
}

const DIFF_A = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', ' line', '+added', '-removed'].join(
  '\n',
);

describe('collectTurnFileChanges', () => {
  it('deduplicates edits by path and concatenates diffs', () => {
    const items = [
      workItem(fileEdit('a.ts', DIFF_A)),
      workItem(fileEdit('b.ts', '')),
      workItem(fileEdit('a.ts', '+more')),
      workItem({ type: 'text', text: 'hi' } as CodexEvent),
    ];
    const files = collectTurnFileChanges(items);
    expect(files).toHaveLength(2);
    expect(files[0].filePath).toBe('a.ts');
    expect(files[0].editCount).toBe(2);
    expect(files[0].diff).toContain('added');
    expect(files[0].diff).toContain('more');
    expect(files[1].filePath).toBe('b.ts');
  });

  it('ignores non-file-edit events', () => {
    const items = [
      workItem({ type: 'command_exec', command: 'ls' } as CodexEvent),
      { kind: 'progress', content: 'working', sourceIndex: 1 } as ChatTurnWorkItem,
    ];
    expect(collectTurnFileChanges(items)).toHaveLength(0);
  });
});

describe('countDiffStats', () => {
  it('counts added and removed lines, ignoring headers', () => {
    const stats = countDiffStats(DIFF_A);
    expect(stats).toEqual({ additions: 1, deletions: 1 });
  });

  it('handles empty diffs', () => {
    expect(countDiffStats('')).toEqual({ additions: 0, deletions: 0 });
  });
});

describe('summarizeTurnChanges', () => {
  it('returns null when the turn changed no files', () => {
    expect(summarizeTurnChanges([workItem({ type: 'text', text: 'x' } as CodexEvent)])).toBeNull();
  });

  it('aggregates across files', () => {
    const summary = summarizeTurnChanges([
      workItem(fileEdit('a.ts', DIFF_A)),
      workItem(fileEdit('b.ts', '+x\n+y')),
    ]);
    expect(summary).not.toBeNull();
    expect(summary!.files).toHaveLength(2);
    expect(summary!.additions).toBe(3);
    expect(summary!.deletions).toBe(1);
    expect(formatTurnChangeSummary(summary!)).toBe('2 files changed · +3 −1');
  });

  it('uses the singular for one file', () => {
    const summary = summarizeTurnChanges([workItem(fileEdit('a.ts', DIFF_A))]);
    expect(formatTurnChangeSummary(summary!)).toBe('1 file changed · +1 −1');
  });
});

describe('resolveChangesRepoId', () => {
  const repos = [
    { id: 'r1', path: '/ws/one' },
    { id: 'r2', path: '/ws/two' },
  ] as RepoInfo[];

  it('prefers the thread repo when valid', () => {
    expect(resolveChangesRepoId(['/ws/two/x.ts'], repos, 'r1')).toBe('r1');
  });

  it('matches absolute file paths to the repo root', () => {
    expect(resolveChangesRepoId(['/ws/two/src/x.ts'], repos)).toBe('r2');
  });

  it('falls back to the first repo', () => {
    expect(resolveChangesRepoId(['relative/x.ts'], repos)).toBe('r1');
  });

  it('returns null without repos', () => {
    expect(resolveChangesRepoId(['x.ts'], [])).toBeNull();
  });
});

describe('repoRelativePath', () => {
  it('strips the repo root from absolute paths', () => {
    expect(repoRelativePath('/ws/one/src/a.ts', '/ws/one')).toBe('src/a.ts');
  });

  it('passes through already-relative paths', () => {
    expect(repoRelativePath('src/a.ts', '/ws/one')).toBe('src/a.ts');
  });

  it('rejects absolute paths outside the repo', () => {
    expect(repoRelativePath('/elsewhere/a.ts', '/ws/one')).toBeNull();
  });
});

describe('reviewed Git scope', () => {
  const repos = [
    { id: 'r1', path: '/ws/one' },
    { id: 'r2', path: '/ws/two' },
  ] as RepoInfo[];

  it('requires every absolute turn path to resolve to the same known repository', () => {
    expect(resolveTurnDeliveryRepo(['/ws/one/a.ts', '/ws/two/b.ts'], repos)).toEqual({
      repoId: null,
      reason: 'This turn changed files in more than one repository.',
    });
  });

  it('requires an explicit repository for relative paths in a multi-repo workspace', () => {
    expect(resolveTurnDeliveryRepo(['src/a.ts'], repos).repoId).toBeNull();
    expect(resolveTurnDeliveryRepo(['src/a.ts'], repos, 'r2')).toEqual({ repoId: 'r2' });
  });

  it('includes the source path from a recorded rename in the selected scope', () => {
    const [file] = changes([
      '/ws/one/new-name.ts',
      'diff --git a/old-name.ts b/new-name.ts\nsimilarity index 100%\nrename from old-name.ts\nrename to new-name.ts',
    ]);

    expect(turnDeliveryPaths([file], '/ws/one')).toEqual({
      paths: ['new-name.ts', 'old-name.ts'],
    });
  });

  it('rejects turn paths outside the chosen repository', () => {
    expect(resolveTurnDeliveryRepo(['/elsewhere/file.ts'], repos).repoId).toBeNull();
    expect(turnDeliveryPaths(changes(['/elsewhere/file.ts', '+x']), '/ws/one')).toMatchObject({
      paths: [],
      reason: expect.stringContaining('outside'),
    });
  });
});

describe('turn delivery review request guard', () => {
  it('ignores a pending response after the review dialog is closed', () => {
    const guard = createTurnDeliveryReviewRequestGuard();
    const request = guard.begin();

    expect(guard.isCurrent(request)).toBe(true);
    expect(guard.cancel()).toBe(true);
    expect(guard.isCurrent(request)).toBe(false);
    expect(guard.finish(request)).toBe(false);
  });

  it('allows only the latest refreshed review request to update the dialog', () => {
    const guard = createTurnDeliveryReviewRequestGuard();
    const first = guard.begin();
    const latest = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(latest)).toBe(true);
    expect(guard.finish(latest)).toBe(true);
    expect(guard.isCurrent(latest)).toBe(false);
  });
});

const REPO = '/ws/one';

function changes(...edits: Array<[string, string]>): TurnFileChange[] {
  return collectTurnFileChanges(edits.map(([path, diff]) => workItem(fileEdit(path, diff))));
}

function status(path: string, value: GitFileChange['status'], staged = false): GitFileChange {
  return { path, status: value, staged };
}

const MODIFY_PATCH = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  ' tail',
].join('\n');

const CREATE_PATCH = ['--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two'].join(
  '\n',
);

const GIT_MODIFY_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@ function x()',
  ' keep',
  '-old',
  '+new',
  ' tail',
].join('\n');

describe('per-file status and stats', () => {
  it('detects added, deleted and modified patches', () => {
    expect(detectDiffFileStatus(CREATE_PATCH)).toBe('added');
    expect(detectDiffFileStatus('--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x')).toBe('deleted');
    expect(detectDiffFileStatus('diff --git a/x b/x\ndeleted file mode 100644')).toBe('deleted');
    expect(detectDiffFileStatus(MODIFY_PATCH)).toBe('modified');
  });

  it('keeps a file created then edited in the same turn as added', () => {
    const [file] = changes(
      ['src/new.ts', CREATE_PATCH],
      ['src/new.ts', '@@ -1,2 +1,2 @@\n one\n-two\n+TWO'],
    );
    expect(file.status).toBe('added');
    expect(file.editCount).toBe(2);
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(1);
  });

  it('records per-file stats and the patch kind', () => {
    const files = changes(
      ['src/a.ts', MODIFY_PATCH],
      ['src/empty.ts', ''],
      ['src/raw.ts', 'export const raw = 1;\n'],
      ['src/cut.ts', '@@ -1 +1 @@\n-a\n+b\n... truncated 900 chars ...\n+c'],
    );
    expect(files.map((file) => [file.filePath, file.patch])).toEqual([
      ['src/a.ts', 'unified'],
      ['src/empty.ts', 'missing'],
      ['src/raw.ts', 'raw'],
      ['src/cut.ts', 'truncated'],
    ]);
    expect(files[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('counts hunk content that looks like a file header', () => {
    const patch = ['--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '--- removed dashes', '+++ added plus'];
    expect(countDiffStats(patch.join('\n'))).toEqual({ additions: 1, deletions: 1 });
  });

  it('counts statuses across files', () => {
    const files = changes(['a', CREATE_PATCH], ['b', MODIFY_PATCH], ['c', MODIFY_PATCH]);
    expect(countTurnStatuses(files)).toEqual({ added: 1, modified: 2, deleted: 0 });
  });

  it('tells patches from raw content', () => {
    expect(isLineLevelPatch(MODIFY_PATCH)).toBe(true);
    expect(isLineLevelPatch('+bare')).toBe(true);
    expect(isLineLevelPatch('const x = 1;')).toBe(false);
  });

  it('finds the first changed new-side line', () => {
    expect(firstChangedLine(GIT_MODIFY_DIFF)).toBe(11);
    expect(firstChangedLine(CREATE_PATCH)).toBe(1);
    expect(firstChangedLine('no hunks')).toBeUndefined();
  });

  it('splits display paths', () => {
    expect(splitDisplayPath('src/a/b.ts')).toEqual({ dir: 'src/a/', name: 'b.ts' });
    expect(splitDisplayPath('b.ts')).toEqual({ dir: '', name: 'b.ts' });
  });
});

describe('diff tallies', () => {
  it('nets out lines edited twice in one turn', () => {
    const turn = `${'@@ -1 +1 @@\n-a\n+b'}\n${'@@ -1 +1 @@\n-b\n+c'}`;
    expect(tallyEquals(tallyDiffLines(turn), tallyDiffLines('@@ -1 +1 @@\n-a\n+c'))).toBe(true);
  });

  it('matches a collapsed single-hunk patch against git hunks', () => {
    const collapsed = '@@ -1,3 +1,3 @@\n-A\n-B\n-C\n+A2\n+B\n+C2';
    const git = '@@ -1 +1 @@\n-A\n+A2\n@@ -3 +3 @@\n-C\n+C2';
    expect(tallyEquals(tallyDiffLines(collapsed), tallyDiffLines(git))).toBe(true);
  });

  it('detects extra working-tree changes', () => {
    const extra = `${GIT_MODIFY_DIFF}\n@@ -40 +40 @@\n-mine\n+user edit`;
    expect(tallyEquals(tallyDiffLines(MODIFY_PATCH), tallyDiffLines(extra))).toBe(false);
  });

  it('tallies whole-file content', () => {
    expect(tallyEquals(tallyDiffLines(CREATE_PATCH), tallyFileContent('one\ntwo\n'))).toBe(true);
  });
});

describe('planTurnUndo', () => {
  it('needs a repository', () => {
    expect(planTurnUndo(changes(['a.ts', MODIFY_PATCH]), null)).toEqual({
      ok: false,
      reason: 'No repository is attached to these changes.',
    });
  });

  it('maps absolute and relative paths into the repo', () => {
    const plan = planTurnUndo(
      changes([`${REPO}/src/a.ts`, MODIFY_PATCH], ['./src/b.ts', MODIFY_PATCH]),
      REPO,
    );
    expect(plan.ok && plan.targets.map((target) => target.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('rejects files outside the repo', () => {
    const plan = planTurnUndo(changes(['/elsewhere/a.ts', MODIFY_PATCH]), REPO);
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
  });

  it('rejects files a later turn edited', () => {
    const plan = planTurnUndo(changes(['src/a.ts', MODIFY_PATCH]), REPO, [`${REPO}/src/a.ts`]);
    expect(plan).toMatchObject({ ok: false, reason: 'src/a.ts was edited again in a later turn.' });
  });

  it('rejects missing and truncated patches', () => {
    expect(planTurnUndo(changes(['a.ts', '']), REPO)).toMatchObject({ ok: false });
    expect(
      planTurnUndo(changes(['a.ts', '@@ -1 +1 @@\n-a\n... truncated 5 chars ...\n+b']), REPO),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('truncated') });
  });
});

describe('undo eligibility', () => {
  const probe = (workingDiff: string, currentContent = ''): TurnUndoProbe => ({
    workingDiff,
    currentContent,
  });

  function evaluate(
    files: TurnFileChange[],
    statusFiles: GitFileChange[],
    probes: Record<string, TurnUndoProbe>,
    later?: string[],
  ) {
    return evaluateTurnUndo(
      planTurnUndo(files, REPO, later),
      statusFiles,
      new Map(Object.entries(probes)),
    );
  }

  it('allows undo when the working tree holds exactly this turn', () => {
    const result = evaluate(
      changes(['src/a.ts', MODIFY_PATCH], ['src/new.ts', CREATE_PATCH]),
      [status('src/a.ts', 'modified'), status('src/new.ts', 'untracked')],
      { 'src/a.ts': probe(GIT_MODIFY_DIFF), 'src/new.ts': probe('', 'one\ntwo\n') },
    );
    expect(result).toEqual({ eligible: true, paths: ['src/a.ts', 'src/new.ts'] });
  });

  it('blocks when the file has changes from outside this turn', () => {
    const result = evaluate(changes(['src/a.ts', MODIFY_PATCH]), [status('src/a.ts', 'modified')], {
      'src/a.ts': probe(`${GIT_MODIFY_DIFF}\n@@ -40 +40 @@\n-x\n+y`),
    });
    expect(result).toEqual({
      eligible: false,
      reason: 'src/a.ts has changes from outside this turn.',
    });
  });

  it('blocks committed, staged and conflicted files', () => {
    const files = changes(['src/a.ts', MODIFY_PATCH]);
    expect(evaluate(files, [], {})).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('committed'),
    });
    expect(evaluate(files, [status('src/a.ts', 'modified', true)], {})).toMatchObject({
      eligible: false,
      reason: 'src/a.ts has staged changes.',
    });
    expect(evaluate(files, [status('src/a.ts', 'conflicted')], {})).toMatchObject({
      eligible: false,
      reason: 'src/a.ts is conflicted.',
    });
  });

  it('never deletes an untracked file the turn did not create', () => {
    const result = evaluate(
      changes(['notes.md', MODIFY_PATCH]),
      [status('notes.md', 'untracked')],
      {
        'notes.md': probe('', 'keep\nnew\ntail\n'),
      },
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: expect.stringContaining("isn't tracked"),
    });
  });

  it('blocks files inside an untracked folder', () => {
    const result = evaluate(
      changes(['src/fresh/new.ts', CREATE_PATCH]),
      [status('src/fresh/', 'untracked')],
      {},
    );
    expect(result).toMatchObject({ eligible: false, reason: expect.stringContaining('folder') });
  });

  it('accepts a raw whole-file creation that matches disk', () => {
    const [file] = changes(['src/raw.ts', 'export const x = 1;\n']);
    const reason = checkTurnUndoTarget(
      { file, path: 'src/raw.ts' },
      [status('src/raw.ts', 'untracked')],
      probe('', 'export const x = 1;\n'),
    );
    expect(reason).toBeNull();
  });

  it('rejects raw content for tracked files', () => {
    const [file] = changes(['src/raw.ts', 'export const x = 1;']);
    expect(
      checkTurnUndoTarget(
        { file, path: 'src/raw.ts' },
        [status('src/raw.ts', 'modified')],
        probe('@@ -1 +1 @@\n-a\n+export const x = 1;'),
      ),
    ).toContain('line-level');
  });

  it('skips net-zero files and still requires something to undo', () => {
    const netZero = '@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-b\n+a';
    expect(evaluate(changes(['src/z.ts', netZero]), [], {})).toEqual({
      eligible: false,
      reason: 'Nothing from this turn is left to undo.',
    });
  });

  it('honours later-turn edits before reading git', () => {
    expect(
      evaluate(
        changes(['src/a.ts', MODIFY_PATCH]),
        [status('src/a.ts', 'modified')],
        {
          'src/a.ts': probe(GIT_MODIFY_DIFF),
        },
        ['src/a.ts'],
      ),
    ).toMatchObject({ eligible: false, reason: expect.stringContaining('later turn') });
  });

  it('finds status entries exactly or by untracked folder', () => {
    const entries = [status('a.ts', 'modified'), status('dir/', 'untracked')];
    expect(findStatusEntry(entries, 'a.ts')).toEqual(entries[0]);
    expect(findStatusEntry(entries, 'dir/x.ts')).toBe('untracked-folder');
    expect(findStatusEntry(entries, 'b.ts')).toBeNull();
  });
});

describe('buildTurnReviewPrompt', () => {
  it('uses the turn scope for the latest editing turn', () => {
    const prompt = buildTurnReviewPrompt({
      repoId: 'r1',
      paths: ['src/a.ts'],
      isLatestEditingTurn: true,
    });
    expect(prompt).toContain('(1 file)');
    expect(prompt).toContain('- `src/a.ts`');
    expect(prompt).toContain('scope { type: "turn", repoId: "r1" }');
    expect(prompt).toContain('review_publish');
    expect(prompt).not.toContain('working-tree');
  });

  it('falls back to a working-tree scope for older turns', () => {
    const prompt = buildTurnReviewPrompt({
      repoId: 'r1',
      paths: ['a', 'b'],
      isLatestEditingTurn: false,
    });
    expect(prompt).toContain('(2 files)');
    expect(prompt).toContain('type: "working-tree"');
    expect(prompt).not.toContain('type: "turn"');
  });

  it('offers both scopes when unknown and caps long file lists', () => {
    const paths = Array.from({ length: 25 }, (_, index) => `f${index}.ts`);
    const prompt = buildTurnReviewPrompt({ repoId: null, paths });
    expect(prompt).toContain('type: "turn" }');
    expect(prompt).toContain('working-tree');
    expect(prompt).toContain('…and 5 more');
    expect(prompt).not.toContain('f24.ts');
  });
});

describe('sameTurnChangeSummary', () => {
  it('compares content, not identity', () => {
    const build = () => summarizeTurnChanges([workItem(fileEdit('a.ts', DIFF_A))]);
    expect(sameTurnChangeSummary(build(), build())).toBe(true);
    expect(sameTurnChangeSummary(null, null)).toBe(true);
    expect(sameTurnChangeSummary(build(), null)).toBe(false);
    expect(
      sameTurnChangeSummary(build(), summarizeTurnChanges([workItem(fileEdit('a.ts', '+x'))])),
    ).toBe(false);
  });
});
