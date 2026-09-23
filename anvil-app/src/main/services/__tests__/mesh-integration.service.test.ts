import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));

import {
  configureMeshIntegrationContext,
  getIntegration,
  integrateResults,
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
          baseCommit: input.base,
          resultCommit: commit,
          branch: `mesh/attempt/att-${input.dispatchId}`,
          changed: true,
        },
      ],
    }),
    JSON.stringify({
      adoptedRefs: [{ repositoryId: input.portableId, ref, commit }],
    }),
  );
  return commit;
}

beforeEach(() => {
  db.exec('DELETE FROM mesh_integrations; DELETE FROM mesh_node_dispatches;');
  db.exec('DELETE FROM workspace_repo_definitions; DELETE FROM workspaces; DELETE FROM repos;');
  userDataDir = mkdtempSync(join(tmpdir(), 'anvil-int-ud-'));
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

  it('marks a clean merge whose verification fails as failed — never proposed', async () => {
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

      expect(result.state).toBe('failed');
      expect(result.verification[0]!.exitCode).toBe(1);
      // The merged worktree is preserved for inspection, not discarded.
      expect(existsSync(result.repositories[0]!.worktreePath)).toBe(true);
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
      seedResultRef({
        repo,
        portableId,
        workspaceId,
        base,
        dispatchId: 'disp-b',
        files: { 'b.txt': 'b\n' },
      });
      db.prepare(
        `UPDATE mesh_node_dispatches SET manifest_json = ? WHERE dispatch_id = 'disp-b'`,
      ).run(
        JSON.stringify({
          repositories: [
            {
              repositoryId: portableId,
              baseCommit: 'deadbeef'.repeat(5),
              resultCommit: 'x',
              branch: 'b',
              changed: true,
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
