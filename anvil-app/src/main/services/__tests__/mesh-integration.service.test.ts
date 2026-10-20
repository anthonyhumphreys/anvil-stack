import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

const meshVerificationDialog = vi.hoisted(() => ({
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
}));

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test', isReady: () => true },
  BrowserWindow: {
    getFocusedWindow: () => ({ isVisible: () => true, isMinimized: () => false }),
    getAllWindows: () => [{ isVisible: () => true, isMinimized: () => false }],
  },
  dialog: { showMessageBox: meshVerificationDialog.showMessageBox },
}));

import {
  configureMeshIntegrationContext,
  applyIntegrationRepository,
  getIntegration,
  integrateResults,
  retryIntegrationVerification,
  runIntegrationVerification,
  resetMeshIntegrationForTests,
} from '../mesh-integration.service';

let userDataDir: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * Seeds a repo + workspace fixture and one adopted-result ref. The result
 * commit is built on a scratch branch then pinned under
 * `refs/mesh/result/<dispatch>/<repo>` — the same shape FLOW-02's bundle
 * import produces.
 */
function seedFixture(suffix: string): {
  workspaceId: string;
  portableId: string;
  repo: string;
  base: string;
} {
  const repo = mkdtempSync(join(tmpdir(), `anvil-int-${suffix}-`));
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  commitAll(repo, 'base');
  const base = git(repo, 'rev-parse', 'HEAD');

  const workspaceId = `w-${suffix}`;
  const portableId = `p-${suffix}`;
  db.prepare(
    `INSERT INTO repos (id, name, path, status, created_at, updated_at)
     VALUES (?, 'repo', ?, 'connected', datetime('now'), datetime('now'))`,
  ).run(`repo-${suffix}`, repo);
  db.prepare(
    `INSERT INTO workspaces (id, name, created_at, updated_at)
     VALUES (?, 'W', datetime('now'), datetime('now'))`,
  ).run(workspaceId);
  db.prepare(
    `INSERT INTO workspace_repo_definitions
     (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
     VALUES (?, ?, 'repo', ?, datetime('now'), datetime('now'))`,
  ).run(workspaceId, portableId, `repo-${suffix}`);
  return { workspaceId, portableId, repo, base };
}

/** Commits `files` on a scratch branch at `base`, pins it as the dispatch's adopted result ref. */
function seedResultRef(input: {
  repo: string;
  portableId: string;
  dispatchId: string;
  workspaceId: string;
  base: string;
  files: Record<string, string>;
}): string {
  const scratch = `scratch/${input.dispatchId}`;
  git(input.repo, 'checkout', '-b', scratch, input.base);
  for (const [name, content] of Object.entries(input.files)) {
    writeFileSync(join(input.repo, name), content);
  }
  const commit = commitAll(input.repo, `result ${input.dispatchId}`);
  const ref = `refs/mesh/result/${input.dispatchId}/${input.portableId}`;
  git(input.repo, 'update-ref', ref, commit);
  git(input.repo, 'checkout', 'main');
  git(input.repo, 'branch', '-D', scratch);
  db.prepare(
    `INSERT INTO mesh_node_dispatches
     (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
      manifest_json, state, cancel_requested, output_json, created_at, updated_at)
     VALUES (?, 'run-1', ?, ?, ?, ?, ?, 'completed', 0, ?, datetime('now'), datetime('now'))`,
  ).run(
    input.dispatchId,
    `node-${input.dispatchId}`,
    `job-${input.dispatchId}`,
    `node-dispatch/${input.dispatchId}`,
    input.workspaceId,
    JSON.stringify({
      repositories: [
        {
          repositoryId: input.portableId,
          commit: input.base,
        },
      ],
    }),
    JSON.stringify({
      resultManifest: {
        repositories: [
          {
            repositoryId: input.portableId,
            baseCommit: input.base,
            resultCommit: commit,
            branch: `mesh/attempt/att-${input.dispatchId}`,
            changed: true,
          },
        ],
      },
      adoptedRefs: [{ repositoryId: input.portableId, ref, commit }],
    }),
  );
  return commit;
}

async function createVerifiedIntegration(suffix: string, integrationId: string) {
  const fixture = seedFixture(suffix);
  seedResultRef({
    ...fixture,
    dispatchId: `disp-${suffix}`,
    files: { 'a.txt': 'verified result\n' },
  });
  const integration = await integrateResults({
    integrationId,
    runId: `run-${suffix}`,
    workspaceId: fixture.workspaceId,
    dispatchIds: [`disp-${suffix}`],
    verification: ['test -f a.txt'],
    permissionMode: 'on-request',
  });
  expect(integration.verificationState).toBe('passed');
  return { ...fixture, integration };
}

beforeEach(() => {
  db.exec('DELETE FROM mesh_integrations; DELETE FROM mesh_node_dispatches;');
  db.exec('DELETE FROM workspace_repo_definitions; DELETE FROM workspaces; DELETE FROM repos;');
  userDataDir = mkdtempSync(join(tmpdir(), 'anvil-int-ud-'));
  meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
  resetMeshIntegrationForTests();
  configureMeshIntegrationContext(() => ({ userDataDir }));
});

describe('integrateResults', () => {
  it('merges ordered results into an integration ref and verifies the combined tree', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('merge');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'base\nfrom-a\n' },
      });
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-b',
        files: { 'b.txt': 'from-b\n' },
      });

      const result = await integrateResults({
        integrationId: 'int-1',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a', 'disp-b'],
        verification: ['test -f a.txt && test -f b.txt && grep -q from-a a.txt'],
      });

      expect(result.state).toBe('integrated');
      expect(result.combined).toBe(true);
      expect(result.verificationState).toBe('passed');
      expect(result.verificationAttempt).toBe(1);
      const integrated = result.repositories[0]!;
      expect(integrated.integratedCommit).not.toBeNull();
      expect(integrated.mergedRefs.map((m) => m.dispatchId)).toEqual(['disp-a', 'disp-b']);
      expect(result.verification).toHaveLength(1);
      expect(result.verification[0]!.exitCode).toBe(0);
      // Both results landed in the integration worktree — user checkout untouched.
      expect(readFileSync(join(integrated.worktreePath, 'a.txt'), 'utf8')).toContain('from-a');
      expect(existsSync(join(integrated.worktreePath, 'b.txt'))).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      // The integration ref is inspectable and durable.
      expect(getIntegration('int-1')!.state).toBe('integrated');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('surfaces overlapping edits as a visible conflict and preserves both refs', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('conflict');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'version-a\n' },
      });
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-b',
        files: { 'a.txt': 'version-b\n' },
      });

      const result = await integrateResults({
        integrationId: 'int-2',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a', 'disp-b'],
      });

      expect(result.state).toBe('conflicted');
      expect(result.combined).toBe(false);
      expect(result.verificationState).toBe('not-run');
      const integrated = result.repositories[0]!;
      // disp-a merged cleanly; disp-b's overlap is the visible conflict.
      expect(integrated.mergedRefs.map((m) => m.dispatchId)).toEqual(['disp-a']);
      expect(integrated.conflicts).toHaveLength(1);
      expect(integrated.conflicts[0]!.dispatchId).toBe('disp-b');
      expect(integrated.conflicts[0]!.conflictedFiles).toContain('a.txt');
      // Merge was aborted — the integration ref holds only the clean merge.
      expect(git(repo, 'rev-parse', integrated.branch)).not.toBe('');
      expect(git(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('');
      // Both adopted refs survive for inspection/manual resolution.
      expect(git(repo, 'rev-parse', `refs/mesh/result/disp-b/${portableId}`)).not.toBe('');
      // No merge state left behind in the user checkout.
      expect(git(repo, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('keeps a clean merge combined while reporting failed verification separately', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('verify');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'changed\n' },
      });

      const result = await integrateResults({
        integrationId: 'int-3',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a'],
        verification: ['exit 1'],
      });

      expect(result.state).toBe('integrated');
      expect(result.combined).toBe(true);
      expect(result.verificationState).toBe('failed');
      expect(result.verification[0]!.exitCode).toBe(1);
      // The merged worktree is preserved for inspection, not discarded.
      expect(existsSync(result.repositories[0]!.worktreePath)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('retries only saved verification commands without replaying result merges', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('retry-checks');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'changed\n' },
      });
      const initial = await integrateResults({
        integrationId: 'int-retry-checks',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a'],
      });
      const integrated = initial.repositories[0]!;
      const pinnedCommit = integrated.integratedCommit;
      expect(initial.combined).toBe(true);
      expect(initial.verificationState).toBe('not-run');

      const checked = await runIntegrationVerification({
        integrationId: 'int-retry-checks',
        runId: 'run-1',
        permissionMode: 'on-request',
        selections: [{ repositoryId: portableId, commands: ['test -f a.txt'] }],
      });
      expect(checked.verificationState).toBe('passed');
      expect(checked.verificationAttempt).toBe(1);
      expect(checked.verification[0]!.testedHead).toBe(pinnedCommit);
      expect(checked.verification[0]!.testedTree).toBeTruthy();
      expect(git(integrated.worktreePath, 'rev-parse', 'HEAD')).toBe(pinnedCommit);

      const retried = await retryIntegrationVerification({
        integrationId: 'int-retry-checks',
        runId: 'run-1',
        permissionMode: 'on-request',
      });
      expect(retried.verificationState).toBe('passed');
      expect(retried.verificationAttempt).toBe(2);
      expect(retried.repositories[0]!.integratedCommit).toBe(pinnedCommit);
      expect(git(integrated.worktreePath, 'rev-parse', 'HEAD')).toBe(pinnedCommit);
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('marks evidence stale when a verification command changes the integration checkout', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('stale-checks');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'changed\n' },
      });
      const initial = await integrateResults({
        integrationId: 'int-stale-checks',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a'],
      });
      const integrated = initial.repositories[0]!;
      const pinnedCommit = integrated.integratedCommit;

      const changed = await runIntegrationVerification({
        integrationId: 'int-stale-checks',
        runId: 'run-1',
        permissionMode: 'on-request',
        selections: [
          { repositoryId: portableId, commands: ['printf artifact > ignored-output.txt'] },
        ],
      });
      expect(changed.verificationState).toBe('stale');
      expect(changed.verification[0]!.testedHead).toBe(pinnedCommit);
      expect(changed.error).toContain('changed the integration checkout');

      const retry = await retryIntegrationVerification({
        integrationId: 'int-stale-checks',
        runId: 'run-1',
        permissionMode: 'on-request',
      });
      expect(retry.verificationState).toBe('stale');
      expect(retry.verificationAttempt).toBe(2);
      expect(retry.verification).toHaveLength(0);
      expect(retry.repositories[0]!.integratedCommit).toBe(pinnedCommit);
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('refuses a fan-out whose dispatches pin divergent bases for one repo', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('diverged');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'a\n' },
      });
      // Corrupt the second dispatch's pin — a different base for the same repo.
      const secondCommit = seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-b',
        files: { 'b.txt': 'b\n' },
      });
      const divergentBase = 'deadbeef'.repeat(5);
      db.prepare(
        `UPDATE mesh_node_dispatches SET manifest_json = ?, output_json = ? WHERE dispatch_id = 'disp-b'`,
      ).run(
        JSON.stringify({
          repositories: [
            {
              repositoryId: portableId,
              commit: divergentBase,
            },
          ],
        }),
        JSON.stringify({
          resultManifest: {
            repositories: [
              {
                repositoryId: portableId,
                baseCommit: divergentBase,
                resultCommit: secondCommit,
                branch: 'mesh/attempt/att-disp-b',
                changed: true,
              },
            ],
          },
          adoptedRefs: [
            {
              repositoryId: portableId,
              ref: `refs/mesh/result/disp-b/${portableId}`,
              commit: secondCommit,
            },
          ],
        }),
      );

      await expect(
        integrateResults({
          integrationId: 'int-4',
          runId: 'run-1',
          workspaceId,
          dispatchIds: ['disp-a', 'disp-b'],
        }),
      ).rejects.toThrow('base-diverged');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('re-binds to a persisted run instead of re-allocating refs after restart', async () => {
    const { workspaceId, portableId, repo, base } = seedFixture('restart');
    try {
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-a',
        files: { 'a.txt': 'changed\n' },
      });
      const input = {
        integrationId: 'int-restart',
        runId: 'run-1',
        workspaceId,
        dispatchIds: ['disp-a'],
      };
      const first = await integrateResults(input);
      expect(first.state).toBe('integrated');

      // Simulated restart: in-memory context cleared, durable row survives.
      resetMeshIntegrationForTests();
      configureMeshIntegrationContext(() => ({ userDataDir }));
      const second = await integrateResults(input);
      expect(second).toEqual(first);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('throws on a missing dispatch rather than silently skipping it', async () => {
    const { workspaceId, repo } = seedFixture('missing');
    try {
      await expect(
        integrateResults({
          integrationId: 'int-5',
          runId: 'run-1',
          workspaceId,
          dispatchIds: ['disp-ghost'],
        }),
      ).rejects.toThrow('dispatch not found');
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe('applyIntegrationRepository', () => {
  it('fast-forwards a clean named source branch to the verified commit exactly once', async () => {
    const fixture = await createVerifiedIntegration('apply-success', 'int-apply-success');
    try {
      meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
      const repository = fixture.integration.repositories[0]!;
      expect(fixture.integration.appliedAt).toBeNull();
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.base);

      const applied = await applyIntegrationRepository({
        integrationId: 'int-apply-success',
        runId: 'run-apply-success',
        repositoryId: fixture.portableId,
        permissionMode: 'on-request',
      });
      expect(applied.repositories[0]!.appliedAt).toBeTruthy();
      expect(applied.repositories[0]!.destinationBranch).toBe('main');
      expect(applied.repositories[0]!.appliedCommit).toBe(repository.integratedCommit);
      expect(applied.appliedAt).toBeTruthy();
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(repository.integratedCommit);
      expect(git(fixture.repo, 'status', '--porcelain')).toBe('');
      expect(meshVerificationDialog.showMessageBox).toHaveBeenCalledTimes(1);

      const retried = await applyIntegrationRepository({
        integrationId: 'int-apply-success',
        runId: 'run-apply-success',
        repositoryId: fixture.portableId,
        permissionMode: 'on-request',
      });
      expect(retried.repositories[0]!.appliedCommit).toBe(repository.integratedCommit);
      expect(meshVerificationDialog.showMessageBox).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('reconciles a persisted apply intent when the checkout reached its exact target before the receipt was saved', async () => {
    const fixture = await createVerifiedIntegration('apply-reconcile', 'int-apply-reconcile');
    try {
      const repository = fixture.integration.repositories[0]!;
      git(fixture.repo, 'merge', '--ff-only', repository.integratedCommit!);

      const persisted = getIntegration('int-apply-reconcile')!;
      persisted.repositories[0]!.applyIntent = {
        startedAt: new Date().toISOString(),
        baseCommit: persisted.repositories[0]!.baseCommit,
        integratedCommit: repository.integratedCommit!,
        destinationBranch: 'main',
      };
      db.prepare('UPDATE mesh_integrations SET result_json = ? WHERE integration_id = ?').run(
        JSON.stringify(persisted),
        'int-apply-reconcile',
      );
      meshVerificationDialog.showMessageBox.mockClear();

      const reconciled = await applyIntegrationRepository({
        integrationId: 'int-apply-reconcile',
        runId: 'run-apply-reconcile',
        repositoryId: fixture.portableId,
        permissionMode: 'on-request',
      });

      expect(reconciled.repositories[0]!.appliedCommit).toBe(repository.integratedCommit);
      expect(reconciled.repositories[0]!.destinationBranch).toBe('main');
      expect(reconciled.repositories[0]!.applyIntent).toBeUndefined();
      expect(reconciled.repositories[0]!.appliedAt).toBeTruthy();
      expect(reconciled.appliedAt).toBeTruthy();
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('marks prior verification stale when the retained integration checkout changes before apply', async () => {
    const fixture = await createVerifiedIntegration('apply-stale', 'int-apply-stale');
    try {
      const repository = fixture.integration.repositories[0]!;
      const priorVerification = fixture.integration.verification;
      writeFileSync(join(repository.worktreePath, 'a.txt'), 'changed after verification\n');
      meshVerificationDialog.showMessageBox.mockClear();

      const result = await applyIntegrationRepository({
        integrationId: 'int-apply-stale',
        runId: 'run-apply-stale',
        repositoryId: fixture.portableId,
        permissionMode: 'on-request',
      });

      expect(result.verificationState).toBe('stale');
      expect(result.verification).toEqual(priorVerification);
      expect(result.repositories[0]!.applyError).toContain('changed after verification');
      expect(result.repositories[0]!.appliedAt).toBeNull();
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.base);
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('preserves dirty or moved source checkouts and refuses unverified commits', async () => {
    const dirty = await createVerifiedIntegration('apply-dirty', 'int-apply-dirty');
    try {
      meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
      writeFileSync(join(dirty.repo, 'local.txt'), 'keep me\n');
      const result = await applyIntegrationRepository({
        integrationId: 'int-apply-dirty',
        runId: 'run-apply-dirty',
        repositoryId: dirty.portableId,
        permissionMode: 'workspace-auto',
      });
      expect(result.repositories[0]!.applyError).toContain(
        'staged, unstaged, or untracked changes',
      );
      expect(result.repositories[0]!.appliedAt).toBeNull();
      expect(git(dirty.repo, 'rev-parse', 'HEAD')).toBe(dirty.base);
      expect(readFileSync(join(dirty.repo, 'local.txt'), 'utf8')).toBe('keep me\n');
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(dirty.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }

    const moved = await createVerifiedIntegration('apply-moved', 'int-apply-moved');
    try {
      meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
      const retainedWorktree = moved.integration.repositories[0]!;
      expect(git(retainedWorktree.worktreePath, 'rev-parse', 'HEAD')).toBe(
        retainedWorktree.integratedCommit,
      );
      expect(git(retainedWorktree.worktreePath, 'status', '--porcelain')).toBe('');
      writeFileSync(join(moved.repo, 'later.txt'), 'later commit\n');
      commitAll(moved.repo, 'move source branch');
      expect(git(retainedWorktree.worktreePath, 'rev-parse', 'HEAD')).toBe(
        retainedWorktree.integratedCommit,
      );
      expect(git(retainedWorktree.worktreePath, 'status', '--porcelain')).toBe('');
      const movedHead = git(moved.repo, 'rev-parse', 'HEAD');
      const result = await applyIntegrationRepository({
        integrationId: 'int-apply-moved',
        runId: 'run-apply-moved',
        repositoryId: moved.portableId,
        permissionMode: 'workspace-auto',
      });
      expect(result.repositories[0]!.applyError).toContain(
        'HEAD no longer matches the recorded base commit',
      );
      expect(result.repositories[0]!.appliedAt).toBeNull();
      expect(git(moved.repo, 'rev-parse', 'HEAD')).toBe(movedHead);
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(moved.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }

    const unverified = seedFixture('apply-failed-check');
    try {
      seedResultRef({
        ...unverified,
        dispatchId: 'disp-apply-failed-check',
        files: { 'a.txt': 'failed check result\n' },
      });
      const failed = await integrateResults({
        integrationId: 'int-apply-failed-check',
        runId: 'run-apply-failed-check',
        workspaceId: unverified.workspaceId,
        dispatchIds: ['disp-apply-failed-check'],
        verification: ['exit 1'],
        permissionMode: 'workspace-auto',
      });
      expect(failed.verificationState).toBe('failed');
      meshVerificationDialog.showMessageBox.mockClear().mockResolvedValue({ response: 0 });
      await expect(
        applyIntegrationRepository({
          integrationId: 'int-apply-failed-check',
          runId: 'run-apply-failed-check',
          repositoryId: unverified.portableId,
          permissionMode: 'workspace-auto',
        }),
      ).rejects.toThrow('Run passing verification checks');
      expect(meshVerificationDialog.showMessageBox).not.toHaveBeenCalled();
    } finally {
      rmSync(unverified.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('persists per-repository receipts when a multi-repository apply is partial', async () => {
    const first = seedFixture('apply-partial-a');
    const secondRepo = mkdtempSync(join(tmpdir(), 'anvil-int-apply-partial-b-'));
    git(secondRepo, 'init', '-b', 'main');
    writeFileSync(join(secondRepo, 'a.txt'), 'base\n');
    const secondBase = commitAll(secondRepo, 'base');
    const secondPortableId = 'p-apply-partial-b';
    db.prepare(
      `INSERT INTO repos (id, name, path, status, created_at, updated_at)
       VALUES ('repo-apply-partial-b', 'second repo', ?, 'connected', datetime('now'), datetime('now'))`,
    ).run(secondRepo);
    db.prepare(
      `INSERT INTO workspace_repo_definitions
       (workspace_id, portable_id, name, mapped_repo_id, created_at, updated_at)
       VALUES (?, ?, 'second repo', 'repo-apply-partial-b', datetime('now'), datetime('now'))`,
    ).run(first.workspaceId, secondPortableId);
    try {
      seedResultRef({
        ...first,
        dispatchId: 'disp-apply-partial-a',
        files: { 'a.txt': 'first result\n' },
      });
      seedResultRef({
        workspaceId: first.workspaceId,
        portableId: secondPortableId,
        repo: secondRepo,
        base: secondBase,
        dispatchId: 'disp-apply-partial-b',
        files: { 'a.txt': 'second result\n' },
      });
      const integrated = await integrateResults({
        integrationId: 'int-apply-partial',
        runId: 'run-apply-partial',
        workspaceId: first.workspaceId,
        dispatchIds: ['disp-apply-partial-a', 'disp-apply-partial-b'],
        verification: ['test -f a.txt'],
        permissionMode: 'on-request',
      });
      expect(integrated.repositories).toHaveLength(2);

      const firstApplied = await applyIntegrationRepository({
        integrationId: 'int-apply-partial',
        runId: 'run-apply-partial',
        repositoryId: first.portableId,
        permissionMode: 'workspace-auto',
      });
      expect(firstApplied.repositories[0]!.appliedAt).toBeTruthy();
      expect(firstApplied.appliedAt).toBeNull();

      writeFileSync(join(secondRepo, 'local.txt'), 'keep me\n');
      const partial = await applyIntegrationRepository({
        integrationId: 'int-apply-partial',
        runId: 'run-apply-partial',
        repositoryId: secondPortableId,
        permissionMode: 'workspace-auto',
      });
      expect(
        partial.repositories.find((repo) => repo.repositoryId === first.portableId)?.appliedAt,
      ).toBeTruthy();
      expect(
        partial.repositories.find((repo) => repo.repositoryId === secondPortableId)?.applyError,
      ).toContain('staged, unstaged, or untracked changes');
      expect(partial.appliedAt).toBeNull();
      expect(getIntegration('int-apply-partial')).toEqual(partial);
    } finally {
      rmSync(first.repo, { recursive: true, force: true });
      rmSync(secondRepo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('requires verification in the originating permission mode', async () => {
    const fixture = await createVerifiedIntegration('apply-readonly', 'int-apply-readonly');
    try {
      await expect(
        applyIntegrationRepository({
          integrationId: 'int-apply-readonly',
          runId: 'run-apply-readonly',
          repositoryId: fixture.portableId,
          permissionMode: 'read-only',
        }),
      ).rejects.toThrow('Read-only delegations cannot apply');
      expect(git(fixture.repo, 'rev-parse', 'HEAD')).toBe(fixture.base);
    } finally {
      rmSync(fixture.repo, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
