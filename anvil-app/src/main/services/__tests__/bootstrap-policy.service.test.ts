import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));

import {
  computeBootstrapDigest,
  explainBootstrapRecipe,
  getBootstrapApproval,
  getBootstrapRun,
  isBootstrapApproved,
  listBootstrapRuns,
  recordBootstrapApproval,
  setWorkspaceBootstrap,
  startBootstrapRun,
} from '../bootstrap-policy.service';
import type { BootstrapRecipe } from '../../../../cloud/contract/bootstrap';

const WS = 'ws-1';

function seedWorkspace(id = WS): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, definition_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'Test WS', 'ready', new Date().toISOString(), new Date().toISOString());
}

const RECIPE: BootstrapRecipe = {
  schemaVersion: 1,
  steps: [
    {
      id: 'check',
      kind: 'verify',
      workingDirectory: '.',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      timeoutMs: 5_000,
      envNames: [],
      retry: 'safe',
    },
  ],
};

const SHELL_RECIPE: BootstrapRecipe = {
  schemaVersion: 1,
  steps: [
    {
      id: 'setup',
      kind: 'command',
      workingDirectory: '.',
      shell: 'echo hi',
      timeoutMs: 5_000,
      envNames: [],
      retry: 'safe',
    },
  ],
};

const COMMITS = { 'repo-a': 'abc123' };
const POLICY = { allowJobs: true };

beforeEach(() => {
  db.exec(
    'DELETE FROM bootstrap_run_steps; DELETE FROM bootstrap_runs; DELETE FROM bootstrap_approvals; DELETE FROM workspace_repo_definitions; DELETE FROM workspaces;',
  );
  seedWorkspace();
});

describe('bootstrap digest + approval gate', () => {
  it('pins recipe + commits + policy — any change needs re-approval', () => {
    const approval = recordBootstrapApproval(WS, {
      recipe: RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      shellApproved: false,
    });
    expect(getBootstrapApproval(WS, approval.digest)).not.toBeNull();
    expect(isBootstrapApproved(WS, approval.digest, RECIPE)).toBe(true);

    const movedCommit = computeBootstrapDigest({
      recipe: RECIPE,
      repositoryCommits: { 'repo-a': 'other' },
      executionPolicy: POLICY,
    });
    expect(movedCommit).not.toBe(approval.digest);
    expect(getBootstrapApproval(WS, movedCommit)).toBeNull();
  });

  it('shell recipes need shell consent — an approval without it does not authorize', () => {
    const approval = recordBootstrapApproval(WS, {
      recipe: SHELL_RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      shellApproved: false,
    });
    expect(isBootstrapApproved(WS, approval.digest, SHELL_RECIPE)).toBe(false);
    const withShell = recordBootstrapApproval(WS, {
      recipe: SHELL_RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      shellApproved: true,
    });
    expect(withShell.digest).toBe(approval.digest);
    expect(isBootstrapApproved(WS, approval.digest, SHELL_RECIPE)).toBe(true);
  });

  it('explain payload surfaces shell usage, env names, and package installs', () => {
    const recipe: BootstrapRecipe = {
      schemaVersion: 1,
      steps: [
        {
          id: 'deps',
          kind: 'command',
          workingDirectory: '.',
          argv: ['pnpm', 'install'],
          timeoutMs: 60_000,
          envNames: ['NODE_AUTH_TOKEN'],
          retry: 'inspect-before-retry',
        },
        {
          id: 'post',
          kind: 'command',
          workingDirectory: '.',
          shell: './scripts/setup.sh',
          timeoutMs: 30_000,
          envNames: [],
          retry: 'never',
        },
      ],
    };
    const explanation = explainBootstrapRecipe(recipe);
    expect(explanation.stepCount).toBe(2);
    expect(explanation.usesShell).toBe(true);
    expect(explanation.installsPackages).toBe(true);
    expect(explanation.envNames).toEqual(['NODE_AUTH_TOKEN']);
  });
});

describe('journaled bootstrap run', () => {
  it('parks in awaiting-approval when no approval pins the digest', async () => {
    const { runId, handle } = startBootstrapRun({
      workspaceId: WS,
      recipe: RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      checkoutRoot: '/tmp',
    });
    expect(handle).toBeNull();
    const run = getBootstrapRun(runId);
    expect(run?.state).toBe('awaiting-approval');
    expect(run?.steps[0].state).toBe('pending');
  });

  it('runs to verified under a pinned approval and journals steps', async () => {
    recordBootstrapApproval(WS, {
      recipe: RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      shellApproved: false,
    });
    const { runId, handle } = startBootstrapRun({
      workspaceId: WS,
      recipe: RECIPE,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      checkoutRoot: '/tmp',
    });
    expect(handle).not.toBeNull();
    const result = await handle!.done;
    expect(result.state).toBe('verified');
    const run = getBootstrapRun(runId);
    expect(run?.state).toBe('verified');
    expect(run?.steps).toEqual([{ stepId: 'check', state: 'verified', exitCode: 0 }]);
    expect(listBootstrapRuns(WS).map((r) => r.id)).toContain(runId);
  });

  it('journals a failed step without advancing the run', async () => {
    const failing: BootstrapRecipe = {
      schemaVersion: 1,
      steps: [
        {
          id: 'boom',
          kind: 'command',
          workingDirectory: '.',
          argv: [process.execPath, '-e', 'process.exit(2)'],
          timeoutMs: 5_000,
          envNames: [],
          retry: 'never',
        },
      ],
    };
    recordBootstrapApproval(WS, {
      recipe: failing,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      shellApproved: false,
    });
    const { runId, handle } = startBootstrapRun({
      workspaceId: WS,
      recipe: failing,
      repositoryCommits: COMMITS,
      executionPolicy: POLICY,
      checkoutRoot: '/tmp',
    });
    await handle!.done;
    const run = getBootstrapRun(runId);
    expect(run?.state).toBe('failed');
    expect(run?.steps[0].state).toBe('failed');
    expect(run?.steps[0].exitCode).toBe(2);
  });
});

describe('workspace bootstrap storage', () => {
  it('stores and clears the recipe on the workspace row', () => {
    setWorkspaceBootstrap(WS, RECIPE);
    const row = db.prepare('SELECT bootstrap_json FROM workspaces WHERE id = ?').get(WS) as {
      bootstrap_json: string | null;
    };
    expect(JSON.parse(row.bootstrap_json!)).toEqual(RECIPE);
    setWorkspaceBootstrap(WS, null);
    const cleared = db
      .prepare('SELECT bootstrap_json FROM workspaces WHERE id = ?')
      .get(WS) as { bootstrap_json: string | null };
    expect(cleared.bootstrap_json).toBeNull();
  });
});
