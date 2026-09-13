// WS-03: bootstrap policy + approval records + journaled runs (spec §7).
//
// A workspace definition may carry a `bootstrap` recipe — executable
// repository code. Before it runs, a LOCAL approval record must pin the
// sha256 digest of recipe content + exact repository commits + the
// effective execution policy. A changed recipe, commit, or policy produces
// a different digest, so no stale approval can silently cover new work.
// Approvals never sync: each target approves for itself, and the backend
// cannot use synced configuration to loosen a target's local policy.
//
// Runs are journaled (bootstrap_runs + bootstrap_run_steps) with step
// transitions reported by the runner. A run whose digest lacks approval
// parks in 'awaiting-approval' — unknown outcomes are never auto-replayed.

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../db/database.js';
import {
  bootstrapDigestInput,
  type BootstrapRecipe,
  type BootstrapStep,
} from '../../../cloud/contract/bootstrap.js';
import {
  runBootstrapRecipe,
  type BootstrapRunHandle,
  type BootstrapRunResult,
} from './bootstrap-runner.service.js';

function nowIso(): string {
  return new Date().toISOString();
}

export function computeBootstrapDigest(input: {
  recipe: BootstrapRecipe;
  repositoryCommits: Readonly<Record<string, string>>;
  executionPolicy: unknown;
}): string {
  return createHash('sha256').update(bootstrapDigestInput(input)).digest('hex');
}

// ---------------------------------------------------------------------------
// Approval UX payload — "explain this at approval" (spec §7)
// ---------------------------------------------------------------------------

export interface BootstrapExplanation {
  stepCount: number;
  usesShell: boolean;
  /** Package-manager-style invocations run executable repository code. */
  installsPackages: boolean;
  /** Env bindings the recipe asks the target to supply. */
  envNames: string[];
  steps: Array<{
    id: string;
    kind: string;
    summary: string;
    shell: boolean;
    timeoutMs: number;
    retry: string;
  }>;
}

const PACKAGE_MANAGERS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'cargo', 'go',
  'gem', 'bundler', 'composer', 'mvn', 'mvnw', 'gradle', 'gradlew', 'brew',
  'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'nuget', 'dotnet',
]);

function stepSummary(step: BootstrapStep): string {
  if (step.shell !== undefined) return step.shell;
  return (step.argv ?? []).join(' ');
}

export function explainBootstrapRecipe(recipe: BootstrapRecipe): BootstrapExplanation {
  const envNames = new Set<string>();
  let usesShell = false;
  let installsPackages = false;
  const steps = recipe.steps.map((step) => {
    for (const name of step.envNames) envNames.add(name);
    if (step.shell !== undefined) usesShell = true;
    const cmd = step.argv?.[0] ?? '';
    if (PACKAGE_MANAGERS.has(cmd) || PACKAGE_MANAGERS.has(cmd.split('/').pop() ?? '')) {
      installsPackages = true;
    }
    return {
      id: step.id,
      kind: step.kind,
      summary: stepSummary(step),
      shell: step.shell !== undefined,
      timeoutMs: step.timeoutMs,
      retry: step.retry,
    };
  });
  return {
    stepCount: steps.length,
    usesShell,
    installsPackages,
    envNames: [...envNames].sort(),
    steps,
  };
}

// ---------------------------------------------------------------------------
// Approval records
// ---------------------------------------------------------------------------

export interface BootstrapApprovalInput {
  recipe: BootstrapRecipe;
  repositoryCommits: Readonly<Record<string, string>>;
  executionPolicy: unknown;
  /** Explicit consent to shell steps — required when the recipe uses any. */
  shellApproved: boolean;
}

export interface BootstrapApproval {
  id: string;
  workspaceId: string;
  digest: string;
  shellApproved: boolean;
  createdAt: string;
}

export function recordBootstrapApproval(
  workspaceId: string,
  input: BootstrapApprovalInput,
): BootstrapApproval {
  const digest = computeBootstrapDigest(input);
  const id = `bap-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO bootstrap_approvals
         (id, workspace_id, digest, recipe_json, repository_commits_json, policy_json, shell_approved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, digest) DO UPDATE SET
         shell_approved = excluded.shell_approved`,
    )
    .run(
      id,
      workspaceId,
      digest,
      JSON.stringify(input.recipe),
      JSON.stringify(input.repositoryCommits),
      JSON.stringify(input.executionPolicy ?? null),
      input.shellApproved ? 1 : 0,
      nowIso(),
    );
  return { id, workspaceId, digest, shellApproved: input.shellApproved, createdAt: nowIso() };
}

export function getBootstrapApproval(
  workspaceId: string,
  digest: string,
): BootstrapApproval | null {
  const row = getDb()
    .prepare(
      'SELECT id, workspace_id, digest, shell_approved, created_at FROM bootstrap_approvals WHERE workspace_id = ? AND digest = ?',
    )
    .get(workspaceId, digest) as
    | { id: string; workspace_id: string; digest: string; shell_approved: number; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    digest: row.digest,
    shellApproved: row.shell_approved === 1,
    createdAt: row.created_at,
  };
}

export function listBootstrapApprovals(workspaceId: string): BootstrapApproval[] {
  const rows = getDb()
    .prepare(
      'SELECT id, workspace_id, digest, shell_approved, created_at FROM bootstrap_approvals WHERE workspace_id = ? ORDER BY created_at DESC',
    )
    .all(workspaceId) as Array<{
    id: string;
    workspace_id: string;
    digest: string;
    shell_approved: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    digest: row.digest,
    shellApproved: row.shell_approved === 1,
    createdAt: row.created_at,
  }));
}

export function revokeBootstrapApproval(approvalId: string): void {
  getDb().prepare('DELETE FROM bootstrap_approvals WHERE id = ?').run(approvalId);
}

/**
 * The policy gate: a run may proceed only when an approval pins this exact
 * digest AND covers shell usage when the recipe needs it. Anything else
 * parks the run in 'awaiting-approval'.
 */
export function isBootstrapApproved(
  workspaceId: string,
  digest: string,
  recipe: BootstrapRecipe,
): boolean {
  const approval = getBootstrapApproval(workspaceId, digest);
  if (approval === null) return false;
  const needsShell = recipe.steps.some((s) => s.shell !== undefined);
  return !needsShell || approval.shellApproved;
}

// ---------------------------------------------------------------------------
// Recipe storage on the workspace row
// ---------------------------------------------------------------------------

export function getWorkspaceBootstrap(workspaceId: string): BootstrapRecipe | null {
  const row = getDb()
    .prepare('SELECT bootstrap_json FROM workspaces WHERE id = ?')
    .get(workspaceId) as { bootstrap_json: string | null } | undefined;
  if (!row?.bootstrap_json) return null;
  try {
    return JSON.parse(row.bootstrap_json) as BootstrapRecipe;
  } catch {
    return null;
  }
}

export function setWorkspaceBootstrap(
  workspaceId: string,
  recipe: BootstrapRecipe | null,
): void {
  getDb()
    .prepare('UPDATE workspaces SET bootstrap_json = ?, updated_at = ? WHERE id = ?')
    .run(recipe === null ? null : JSON.stringify(recipe), nowIso(), workspaceId);
}

// ---------------------------------------------------------------------------
// Journaled run
// ---------------------------------------------------------------------------

export interface BootstrapRunSummary {
  id: string;
  workspaceId: string;
  digest: string;
  state: 'awaiting-approval' | 'running' | 'verified' | 'failed' | 'unknown-outcome';
  steps: Array<{ stepId: string; state: string; exitCode: number | null }>;
}

/**
 * Runs the recipe under journal + policy gate. Returns the run handle so
 * callers can await completion or cancel; the journal rows exist before
 * the first step spawns (crash-reconstructable).
 */
export function startBootstrapRun(input: {
  workspaceId: string;
  recipe: BootstrapRecipe;
  repositoryCommits: Readonly<Record<string, string>>;
  executionPolicy: unknown;
  checkoutRoot: string;
  definitionRevision?: string;
  resolveEnv?: (name: string) => string | undefined;
  onStepLog?: (stepId: string, chunk: string) => void;
}): { runId: string; handle: BootstrapRunHandle | null } {
  const db = getDb();
  const digest = computeBootstrapDigest(input);
  const runId = `brun-${randomUUID()}`;
  const approved = isBootstrapApproved(input.workspaceId, digest, input.recipe);
  const approval = getBootstrapApproval(input.workspaceId, digest);

  db.prepare(
    `INSERT INTO bootstrap_runs (id, workspace_id, definition_revision, digest, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    input.workspaceId,
    input.definitionRevision ?? null,
    digest,
    approved ? 'running' : 'awaiting-approval',
    nowIso(),
    nowIso(),
  );
  const insertStep = db.prepare(
    `INSERT INTO bootstrap_run_steps (run_id, step_id, state, updated_at) VALUES (?, ?, 'pending', ?)`,
  );
  for (const step of input.recipe.steps) insertStep.run(runId, step.id, nowIso());

  if (!approved) {
    return { runId, handle: null };
  }

  const updateStep = db.prepare(
    `UPDATE bootstrap_run_steps SET state = ?, log_tail = COALESCE(?, log_tail), exit_code = COALESCE(?, exit_code), updated_at = ? WHERE run_id = ? AND step_id = ?`,
  );
  const appendLog = db.prepare(
    `UPDATE bootstrap_run_steps
     SET log_tail = substr(COALESCE(log_tail, '') || ?, -16384), updated_at = ?
     WHERE run_id = ? AND step_id = ?`,
  );
  const finish = db.prepare(
    `UPDATE bootstrap_runs SET state = ?, error = ?, updated_at = ? WHERE id = ?`,
  );

  const handle = runBootstrapRecipe(input.recipe, {
    checkoutRoot: input.checkoutRoot,
    resolveEnv: input.resolveEnv,
    shellApproved: approval?.shellApproved === true,
    onStepState: (stepId, state) => {
      updateStep.run(state, null, null, nowIso(), runId, stepId);
    },
    onStepLog: (stepId, chunk) => {
      appendLog.run(chunk, nowIso(), runId, stepId);
      input.onStepLog?.(stepId, chunk);
    },
  });
  void handle.done.then((result: BootstrapRunResult) => {
    for (const outcome of result.steps) {
      updateStep.run(outcome.state, outcome.log || null, outcome.exitCode, nowIso(), runId, outcome.stepId);
    }
    finish.run(result.state, null, nowIso(), runId);
  });
  return { runId, handle };
}

export function getBootstrapRun(runId: string): BootstrapRunSummary | null {
  const db = getDb();
  const run = db
    .prepare('SELECT id, workspace_id, digest, state FROM bootstrap_runs WHERE id = ?')
    .get(runId) as
    | { id: string; workspace_id: string; digest: string; state: BootstrapRunSummary['state'] }
    | undefined;
  if (!run) return null;
  const steps = db
    .prepare('SELECT step_id, state, exit_code FROM bootstrap_run_steps WHERE run_id = ? ORDER BY rowid')
    .all(runId) as Array<{ step_id: string; state: string; exit_code: number | null }>;
  return {
    id: run.id,
    workspaceId: run.workspace_id,
    digest: run.digest,
    state: run.state,
    steps: steps.map((s) => ({ stepId: s.step_id, state: s.state, exitCode: s.exit_code })),
  };
}

export function listBootstrapRuns(workspaceId: string): BootstrapRunSummary[] {
  const rows = getDb()
    .prepare('SELECT id FROM bootstrap_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(workspaceId) as Array<{ id: string }>;
  return rows.map((r) => getBootstrapRun(r.id)).filter((r): r is BootstrapRunSummary => r !== null);
}

// ---------------------------------------------------------------------------
// Crash recovery — verify postconditions, never auto-replay (spec §7)
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  workspace_id: string;
  digest: string;
  state: string;
}

/**
 * The workspace's primary checkout: the first mapped portable repo's
 * local path. Bootstrap steps' `workingDirectory` resolves against it —
 * per-repo working directories are a contract extension, not v1.
 */
export function workspaceCheckoutRoot(workspaceId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT r.path FROM workspace_repo_definitions d
       JOIN repos r ON r.id = d.mapped_repo_id
       WHERE d.workspace_id = ? AND d.mapped_repo_id IS NOT NULL
       ORDER BY d.portable_id LIMIT 1`,
    )
    .get(workspaceId) as { path: string } | undefined;
  return row?.path ?? null;
}

const execFileAsync = promisify(execFile);

/**
 * Resolved HEAD commits for every mapped repo — the exact pins a digest
 * commits to. A floating ref is a setup preference, never this identity;
 * repos that fail `rev-parse` are omitted so the digest only covers
 * resolved commits (an unresolvable repo fails materialisation earlier).
 */
export async function resolveWorkspaceCommits(
  workspaceId: string,
): Promise<Record<string, string>> {
  const rows = getDb()
    .prepare(
      `SELECT d.portable_id, r.path FROM workspace_repo_definitions d
       JOIN repos r ON r.id = d.mapped_repo_id
       WHERE d.workspace_id = ? AND d.mapped_repo_id IS NOT NULL`,
    )
    .all(workspaceId) as Array<{ portable_id: string; path: string }>;
  const commits: Record<string, string> = {};
  for (const row of rows) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: row.path,
        timeout: 10_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      commits[row.portable_id] = String(stdout).trim();
    } catch {
      // Unresolvable checkout — omitted; the digest can't cover it.
    }
  }
  return commits;
}

/**
 * Boot-time reconciliation for runs interrupted mid-flight. The recipe's
 * `verify` steps are idempotent postcondition checks: re-running them
 * proves whether interrupted `command` effects landed. All-verified
 * postconditions mark the run `verified`; anything else is
 * `unknown-outcome` — non-idempotent uncertainty requires inspection and
 * is never silently retried.
 */
export async function recoverBootstrapRuns(checkoutRootFor: (workspaceId: string) => string | null): Promise<void> {
  const db = getDb();
  const interrupted = db
    .prepare(`SELECT id, workspace_id, digest, state FROM bootstrap_runs WHERE state = 'running'`)
    .all() as RunRow[];
  for (const run of interrupted) {
    const recipe = getWorkspaceBootstrap(run.workspace_id);
    const checkoutRoot = checkoutRootFor(run.workspace_id);
    const verifySteps =
      recipe?.steps.filter((s) => s.kind === 'verify') ?? [];
    let postconditionsProven = false;
    if (recipe !== null && checkoutRoot !== null && verifySteps.length > 0) {
      const result = await runBootstrapRecipe(
        { schemaVersion: recipe.schemaVersion, steps: verifySteps },
        { checkoutRoot },
      ).done;
      postconditionsProven = result.state === 'verified';
    }
    db.prepare(`UPDATE bootstrap_runs SET state = ?, updated_at = ? WHERE id = ?`).run(
      postconditionsProven ? 'verified' : 'unknown-outcome',
      nowIso(),
      run.id,
    );
    if (!postconditionsProven) {
      db.prepare(
        `UPDATE bootstrap_run_steps SET state = 'unknown-outcome', updated_at = ? WHERE run_id = ? AND state IN ('running','pending')`,
      ).run(nowIso(), run.id);
    }
  }
}
