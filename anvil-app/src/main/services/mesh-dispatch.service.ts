// FLOW-02: parent-side workflow-node dispatch (spec §449).
//
// The parent run persists each remote node's dispatch BEFORE creating
// the job: dispatch id → job id, the pinned manifest, attempt/output
// references, and cancellation intent all live in mesh_node_dispatches.
// Because the job's requestId derives from the dispatch id, re-dispatch
// after a restart re-binds to the same backend job instead of minting a
// second one — a lost response never duplicates work.
//
// Result transfer is ref-based: the worker publishes each attempt branch
// as a git bundle artifact; the parent downloads the bundle and fetches
// it into the mapped local checkout under refs/mesh/result/<dispatch>/,
// never touching the user's working tree.

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../db/database.js';
import { rpc as backendRpc } from './sync-backend-client.service.js';
import { downloadMeshArtifact } from './mesh-artifact.service.js';
import { createWorkflowNodeJob } from './mesh-worker.service.js';
import { runGit, withRepoRefLock } from './mesh-worktree.service.js';
import type {
  AttemptResultManifest,
  JobGetResult,
  JobSummary,
} from '../../../cloud/contract/jobs.js';

interface DispatchContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
}

let contextProvider: (() => DispatchContext | null) | null = null;

export function configureMeshDispatchContext(provider: () => DispatchContext | null): void {
  contextProvider = provider;
}

async function dispatchRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = contextProvider?.() ?? null;
  if (ctx === null) {
    throw new Error('Mesh dispatch has no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

export interface NodeDispatchRecord {
  dispatchId: string;
  runId: string;
  nodeId: string;
  jobId: string;
  workspaceId: string;
  state: string;
  cancelRequested: boolean;
  output: NodeDispatchOutput | null;
}

export interface NodeDispatchOutput {
  resultManifest: AttemptResultManifest;
  /** Refs fetched into the local checkouts from the worker's bundles. */
  adoptedRefs: Array<{ repositoryId: string; ref: string; commit: string }>;
}

interface DispatchRow {
  dispatch_id: string;
  run_id: string;
  node_id: string;
  job_id: string;
  workspace_id: string;
  state: string;
  cancel_requested: number;
  output_json: string | null;
}

const NONTERMINAL_STATES = new Set(['queued', 'running', 'awaiting-approval', 'cancel-requested']);

function rowToRecord(row: DispatchRow): NodeDispatchRecord {
  return {
    dispatchId: row.dispatch_id,
    runId: row.run_id,
    nodeId: row.node_id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    state: row.state,
    cancelRequested: row.cancel_requested === 1,
    output: row.output_json === null ? null : (JSON.parse(row.output_json) as NodeDispatchOutput),
  };
}

function readDispatch(dispatchId: string): NodeDispatchRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM mesh_node_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as DispatchRow | undefined;
  return row === undefined ? null : rowToRecord(row);
}

function writeDispatchState(dispatchId: string, state: string): void {
  getDb()
    .prepare(
      `UPDATE mesh_node_dispatches SET state = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`,
    )
    .run(state, dispatchId);
}

/**
 * Dispatches a workflow node to a remote worker. Idempotent on
 * dispatchId: an existing row (however it got there — earlier call,
 * restart, lost response) is returned as-is; the backend job is only
 * created on first dispatch and its requestId re-derives from the
 * dispatch id.
 */
export async function dispatchWorkflowNode(input: {
  dispatchId: string;
  runId: string;
  nodeId: string;
  workspaceId: string;
  prompt: string;
  targetEnrollmentId?: string;
  verification?: string[];
  provider?: 'codex' | 'azure' | 'openai';
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  turnTimeoutMs?: number;
}): Promise<NodeDispatchRecord> {
  const existing = readDispatch(input.dispatchId);
  if (existing !== null) {
    return existing;
  }
  const job = await createWorkflowNodeJob({
    dispatchId: input.dispatchId,
    runId: input.runId,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    ...(input.targetEnrollmentId === undefined
      ? {}
      : { targetEnrollmentId: input.targetEnrollmentId }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
  });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mesh_node_dispatches
       (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
        manifest_json, state, cancel_requested, output_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(
      input.dispatchId,
      input.runId,
      input.nodeId,
      job.id,
      `node-dispatch/${input.dispatchId}`,
      input.workspaceId,
      JSON.stringify(job.inputManifest),
      job.state,
      now,
      now,
    );
  return readDispatch(input.dispatchId)!;
}

/**
 * Refreshes one dispatch against the backend job. On a terminal
 * `completed` job with a result manifest, adopts the worker's bundle
 * refs into the local checkouts and records the output.
 */
export async function refreshDispatch(dispatchId: string): Promise<NodeDispatchRecord> {
  const row = readDispatch(dispatchId);
  if (row === null) throw new Error(`dispatch not found: ${dispatchId}`);
  if (!NONTERMINAL_STATES.has(row.state) && row.output !== null) return row;
  const { job, attempts } = await dispatchRpc<JobGetResult>('job.get', { jobId: row.jobId });
  writeDispatchState(dispatchId, job.state);
  if (job.state === 'completed' && row.output === null) {
    const completed = attempts.find((a) => a.state === 'completed');
    const manifest = (completed?.result as { resultManifest?: AttemptResultManifest } | undefined)
      ?.resultManifest;
    if (manifest !== undefined) {
      await importNodeResults(dispatchId, row.workspaceId, manifest);
    }
  }
  return readDispatch(dispatchId)!;
}

/** Polls every non-terminal dispatch — used by boot reconcile and callers. */
export async function refreshActiveDispatches(): Promise<void> {
  const rows = getDb()
    .prepare('SELECT dispatch_id FROM mesh_node_dispatches WHERE output_json IS NULL')
    .all() as Array<{ dispatch_id: string }>;
  for (const row of rows) {
    await refreshDispatch(row.dispatch_id).catch(() => undefined);
  }
}

/**
 * Boot-time reconciliation: non-terminal dispatch rows re-adopt their
 * persisted backend jobs. Nothing is recreated — the dispatch row is the
 * identity.
 */
export async function reconcileDispatchesOnBoot(): Promise<void> {
  await refreshActiveDispatches();
}

/**
 * Persists cancellation intent, then propagates it to the backend job.
 * The dispatch stays cancel-requested until job.get confirms a terminal
 * state — a missing ack is NOT treated as cancelled.
 */
export async function cancelNodeDispatch(dispatchId: string): Promise<NodeDispatchRecord> {
  const row = readDispatch(dispatchId);
  if (row === null) throw new Error(`dispatch not found: ${dispatchId}`);
  getDb()
    .prepare(
      `UPDATE mesh_node_dispatches SET cancel_requested = 1, updated_at = datetime('now')
       WHERE dispatch_id = ?`,
    )
    .run(dispatchId);
  if (NONTERMINAL_STATES.has(row.state)) {
    const { job } = await dispatchRpc<{ job: JobSummary }>('job.cancel', { jobId: row.jobId });
    writeDispatchState(dispatchId, job.state);
  }
  return readDispatch(dispatchId)!;
}

/**
 * Downloads each `bundle:<repositoryId>` artifact and fetches it into the
 * mapped checkout as refs/mesh/result/<dispatchId>/<repositoryId>. The
 * user's working tree is never touched — results land as inspectable
 * refs. Serialized through the per-repo ref lane.
 */
async function importNodeResults(
  dispatchId: string,
  workspaceId: string,
  manifest: AttemptResultManifest,
): Promise<void> {
  const defs = getDb()
    .prepare(
      `SELECT d.portable_id, r.path AS repo_path
       FROM workspace_repo_definitions d
       JOIN repos r ON r.id = d.mapped_repo_id
       WHERE d.workspace_id = ?`,
    )
    .all(workspaceId) as Array<{ portable_id: string; repo_path: string }>;
  const pathByPortable = new Map(defs.map((d) => [d.portable_id, d.repo_path]));

  const bundleArtifacts = new Map(
    manifest.artifacts
      .filter((a) => a.label.startsWith('bundle:'))
      .map((a) => [a.label.slice('bundle:'.length), a.artifactId]),
  );
  const adoptedRefs: NodeDispatchOutput['adoptedRefs'] = [];
  for (const repo of manifest.repositories) {
    const artifactId = bundleArtifacts.get(repo.repositoryId);
    const repoPath = pathByPortable.get(repo.repositoryId);
    // No bundle for a repo, or no mapped local checkout to fetch into —
    // the manifest still records the worker-side ref; absence is honest.
    if (artifactId === undefined || repoPath === undefined) continue;
    const bytes = await downloadMeshArtifact(artifactId);
    const scratch = mkdtempSync(join(tmpdir(), 'anvil-bundle-'));
    const bundlePath = join(scratch, 'result.bundle');
    try {
      writeFileSync(bundlePath, bytes);
      const localRef = `refs/mesh/result/${dispatchId}/${repo.repositoryId}`;
      await withRepoRefLock(repoPath, async () => {
        await runGit(repoPath, ['fetch', bundlePath, `${repo.branch}:${localRef}`]);
      });
      adoptedRefs.push({ repositoryId: repo.repositoryId, ref: localRef, commit: repo.resultCommit });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const output: NodeDispatchOutput = { resultManifest: manifest, adoptedRefs };
  getDb()
    .prepare(
      `UPDATE mesh_node_dispatches SET output_json = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`,
    )
    .run(JSON.stringify(output), dispatchId);
}

/** Test seam: clears the injected context. */
export function resetMeshDispatchForTests(): void {
  contextProvider = null;
}
