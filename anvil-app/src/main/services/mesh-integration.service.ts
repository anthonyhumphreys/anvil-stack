// FLOW-03: fan-out integration + verification (spec §457).
//
// An integration run takes the adopted result refs of a fan-out's node
// dispatches — in the caller's declared dependency order — and merges
// them inside a dedicated integration worktree per repository, starting
// from the pinned base all dispatches provably share. Overlapping edits
// surface as a visible conflict record (files listed, merge aborted —
// never auto-resolved). The integrated result is verified with declared
// commands BEFORE it is proposed; failed or unmerged branches are
// preserved for explicit disposal.
//
// Nothing here mutates the user's checkout: integration happens under
// `mesh/integrate/<id>` refs + worktrees, and the recorded outcome is a
// proposal the user applies deliberately.

import { join } from 'node:path';
import { getDb } from '../db/database.js';
import {
  allocateAttemptWorktrees,
  runGit,
  runVerificationCommand,
  withRepoRefLock,
} from './mesh-worktree.service.js';
import type {
  ResultManifestRepository,
  ResultManifestVerification,
} from '../../../cloud/contract/jobs.js';

interface IntegrationContext {
  userDataDir: string;
}

let contextProvider: (() => IntegrationContext | null) | null = null;

export function configureMeshIntegrationContext(provider: () => IntegrationContext | null): void {
  contextProvider = provider;
}

export interface IntegrationConflict {
  repositoryId: string;
  dispatchId: string;
  /** The commit that failed to merge. */
  ref: string;
  conflictedFiles: string[];
}

export interface IntegratedRepo {
  repositoryId: string;
  baseCommit: string;
  /** Integration branch tip — present when every declared result merged. */
  integratedCommit: string | null;
  branch: string;
  worktreePath: string;
  mergedRefs: Array<{ dispatchId: string; ref: string; commit: string }>;
  conflicts: IntegrationConflict[];
}

export interface IntegrationResult {
  state: 'integrated' | 'conflicted' | 'failed';
  repositories: IntegratedRepo[];
  verification: ResultManifestVerification[];
}

interface DispatchRow {
  dispatch_id: string;
  workspace_id: string;
  manifest_json: string;
  output_json: string | null;
}

function mergeEnvArgs(): string[] {
  return ['-c', 'user.name=Anvil Mesh', '-c', 'user.email=mesh@anvil.local'];
}

/**
 * Merges each dispatch's adopted result refs into a dedicated
 * `mesh/integrate/<integrationId>` worktree per repository, in declared
 * dependency order. Every repo whose dispatches produced changes gets a
 * worktree at the pinned base shared across those dispatches; a repo
 * whose base pins disagree across dispatches is a visible failure, not a
 * guessed merge.
 */
export async function integrateResults(input: {
  integrationId: string;
  runId: string;
  workspaceId: string;
  /** Declared dependency order — dispatch N+1 merges on top of N. */
  dispatchIds: string[];
  verification?: string[];
}): Promise<IntegrationResult> {
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) {
    throw new Error('Mesh integration has no userDataDir context.');
  }
  const db = getDb();

  // Idempotent re-entry: a restart or retry binds to the persisted run
  // instead of re-allocating `mesh/integrate/<id>` refs (which exist).
  const existing = getIntegration(input.integrationId);
  if (existing !== null) return existing;

  const rows = db
    .prepare(
      `SELECT dispatch_id, workspace_id, manifest_json, output_json
       FROM mesh_node_dispatches WHERE dispatch_id IN (${input.dispatchIds.map(() => '?').join(',')})`,
    )
    .all(...input.dispatchIds) as DispatchRow[];
  const byDispatch = new Map(rows.map((r) => [r.dispatch_id, r]));

  interface PendingMerge {
    dispatchId: string;
    repositoryId: string;
    ref: string;
    commit: string;
  }
  const mergesByRepo = new Map<string, PendingMerge[]>();
  const baseByRepo = new Map<string, string>();
  for (const dispatchId of input.dispatchIds) {
    const row = byDispatch.get(dispatchId);
    if (row === undefined) throw new Error(`dispatch not found: ${dispatchId}`);
    if (row.workspace_id !== input.workspaceId) {
      throw new Error(`dispatch ${dispatchId} belongs to a different workspace`);
    }
    const manifest = JSON.parse(row.manifest_json) as {
      repositories?: ResultManifestRepository[];
    };
    const output =
      row.output_json === null
        ? null
        : (JSON.parse(row.output_json) as {
            adoptedRefs?: Array<{ repositoryId: string; ref: string; commit: string }>;
          });
    for (const adopted of output?.adoptedRefs ?? []) {
      const manifestRepo = (manifest.repositories ?? []).find(
        (r) => r.repositoryId === adopted.repositoryId,
      );
      if (manifestRepo === undefined) continue;
      const pinned = baseByRepo.get(adopted.repositoryId);
      if (pinned !== undefined && pinned !== manifestRepo.baseCommit) {
        throw new Error(
          `base-diverged: ${adopted.repositoryId} pinned at ${manifestRepo.baseCommit} vs ${pinned} across dispatches`,
        );
      }
      baseByRepo.set(adopted.repositoryId, manifestRepo.baseCommit);
      (
        mergesByRepo.get(adopted.repositoryId) ??
        mergesByRepo.set(adopted.repositoryId, []).get(adopted.repositoryId)!
      ).push({
        dispatchId,
        repositoryId: adopted.repositoryId,
        ref: adopted.ref,
        commit: adopted.commit,
      });
    }
  }

  // Map each involved portable repo to its local checkout.
  const pathRows = db
    .prepare(
      `SELECT d.portable_id, r.path AS repo_path
       FROM workspace_repo_definitions d
       JOIN repos r ON r.id = d.mapped_repo_id
       WHERE d.workspace_id = ?`,
    )
    .all(input.workspaceId) as Array<{ portable_id: string; repo_path: string }>;
  const pathByPortable = new Map(pathRows.map((r) => [r.portable_id, r.repo_path]));

  const rootDir = join(ctx.userDataDir, 'mesh-integrations', input.integrationId);
  const repositories: IntegratedRepo[] = [];
  const verification: ResultManifestVerification[] = [];
  let sawConflict = false;

  for (const [repositoryId, merges] of mergesByRepo) {
    const repoPath = pathByPortable.get(repositoryId);
    const baseCommit = baseByRepo.get(repositoryId)!;
    if (repoPath === undefined) {
      throw new Error(`no mapped checkout for repository ${repositoryId}`);
    }
    const [worktree] = await allocateAttemptWorktrees({
      attemptId: input.integrationId,
      rootDir,
      branchPrefix: 'mesh/integrate',
      repositories: [{ repositoryId, sourcePath: repoPath, commit: baseCommit }],
    });
    const repo: IntegratedRepo = {
      repositoryId,
      baseCommit,
      integratedCommit: null,
      branch: worktree!.branch,
      worktreePath: worktree!.worktreePath,
      mergedRefs: [],
      conflicts: [],
    };
    for (const merge of merges) {
      const outcome = await withRepoRefLock(repoPath, async () => {
        try {
          await runGit(worktree!.worktreePath, [
            ...mergeEnvArgs(),
            'merge',
            '--no-ff',
            '--no-edit',
            merge.commit,
          ]);
          return { ok: true as const, conflictedFiles: [] as string[] };
        } catch {
          // Merge conflict — capture the visible file list, then abort so
          // the integration ref records only clean merges.
          let files: string[] = [];
          try {
            const raw = await runGit(worktree!.worktreePath, [
              'diff',
              '--name-only',
              '--diff-filter=U',
            ]);
            files = raw
              .split('\n')
              .map((f) => f.trim())
              .filter(Boolean);
          } catch {
            /* best-effort listing */
          }
          await runGit(worktree!.worktreePath, ['merge', '--abort']).catch(() => undefined);
          return { ok: false as const, conflictedFiles: files };
        }
      });
      if (!outcome.ok) {
        sawConflict = true;
        repo.conflicts.push({
          repositoryId,
          dispatchId: merge.dispatchId,
          ref: merge.ref,
          conflictedFiles: outcome.conflictedFiles,
        });
        // Dependency order is a precondition for later merges — stop this
        // repo's chain at the first conflict.
        break;
      }
      repo.mergedRefs.push({ dispatchId: merge.dispatchId, ref: merge.ref, commit: merge.commit });
    }
    if (repo.conflicts.length === 0) {
      repo.integratedCommit = (await runGit(worktree!.worktreePath, ['rev-parse', 'HEAD'])).trim();
      for (const command of input.verification ?? []) {
        const outcome = await runVerificationCommand({
          repositoryId,
          command,
          cwd: worktree!.worktreePath,
          target: {
            kind: 'integration',
            integrationId: input.integrationId,
            runId: input.runId,
          },
        });
        verification.push({
          repositoryId: outcome.repositoryId,
          command: outcome.command,
          approvalGranted: outcome.approvalGranted,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          durationMs: outcome.durationMs,
        });
      }
    }
    repositories.push(repo);
  }

  const state: IntegrationResult['state'] = sawConflict
    ? 'conflicted'
    : verification.some((v) => v.approvalGranted === false || v.exitCode !== 0 || v.timedOut)
      ? 'failed'
      : 'integrated';
  const result: IntegrationResult = { state, repositories, verification };
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO mesh_integrations
     (integration_id, run_id, workspace_id, dispatch_ids_json, state, result_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration_id) DO UPDATE SET state = excluded.state,
       result_json = excluded.result_json, updated_at = excluded.updated_at`,
  ).run(
    input.integrationId,
    input.runId,
    input.workspaceId,
    JSON.stringify(input.dispatchIds),
    state,
    JSON.stringify(result),
    now,
    now,
  );
  return result;
}

/** Reads a persisted integration run. */
export function getIntegration(integrationId: string): IntegrationResult | null {
  const row = getDb()
    .prepare('SELECT result_json FROM mesh_integrations WHERE integration_id = ?')
    .get(integrationId) as { result_json: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.result_json) as IntegrationResult);
}

/** Test seam: clears the injected context. */
export function resetMeshIntegrationForTests(): void {
  contextProvider = null;
}
