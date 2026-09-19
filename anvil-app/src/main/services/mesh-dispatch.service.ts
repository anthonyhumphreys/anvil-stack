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
import {
  ensureTaskKeyDelivery,
  prepareSealedJob,
  submitPreparedJob,
  workflowNodeJobRequest,
} from './mesh-worker.service.js';
import { taskKeyFor, unsealTaskResult, UnsealError } from './sync-keyring.service.js';
import type { SyncScope } from '../../shared/sync-mesh.js';
import { requestEnvironment, type RequestEnvironmentInput } from './cloud-environment.service.js';
import { runGit, withRepoRefLock } from './mesh-worktree.service.js';
import type {
  AttemptResultManifest,
  CapabilityRequirements,
  JobCreateParams,
  JobGetResult,
  JobSummary,
} from '../../../cloud/contract/jobs.js';

interface DispatchContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  scope?: SyncScope;
  mintEnvironmentCode?: (options: {
    provider: string;
    ttlSeconds: number;
    environmentId: string;
    displayName?: string;
  }) => Promise<string | null>;
}

let contextProvider: (() => DispatchContext | null) | null = null;

export function configureMeshDispatchContext(provider: () => DispatchContext | null): void {
  contextProvider = provider;
}

export async function requestWorkflowEnvironment(
  input: RequestEnvironmentInput & { environmentId: string },
): Promise<string> {
  const ctx = contextProvider?.() ?? null;
  if (ctx?.scope === undefined)
    throw new Error('Environment provisioning needs an active sync scope.');
  const result = await requestEnvironment(
    {
      backendId: ctx.scope.backendId,
      accountId: ctx.scope.accountId,
      enrollmentId: ctx.enrollmentId,
      apiUrl: ctx.apiUrl,
      accessToken: ctx.accessToken,
    },
    input,
    { mintEnvironmentCode: ctx.mintEnvironmentCode },
  );
  return result.environmentId;
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
  /** Null while the persisted job.create request is still unsubmitted. */
  jobId: string | null;
  workspaceId: string;
  state: string;
  cancelRequested: boolean;
  output: NodeDispatchOutput | null;
  /** Byte-exact job.create params persisted before submission (replay). */
  requestJson: string | null;
  placementExplanation?: string;
  resolvedEnrollmentId?: string;
}

export interface NodeDispatchOutput {
  resultManifest: AttemptResultManifest;
  /** Refs fetched into the local checkouts from the worker's bundles. */
  adoptedRefs: Array<{ repositoryId: string; ref: string; commit: string }>;
  /** Decrypted rich attempt result used to build the workflow handoff. */
  result?: Record<string, unknown>;
}

interface DispatchRow {
  dispatch_id: string;
  run_id: string;
  node_id: string;
  job_id: string | null;
  workspace_id: string;
  state: string;
  cancel_requested: number;
  output_json: string | null;
  request_json: string | null;
  placement_explanation?: string | null;
  resolved_enrollment_id?: string | null;
}

const NONTERMINAL_STATES = new Set([
  'submitting',
  'queued',
  'awaiting-key-delivery',
  'running',
  'awaiting-approval',
  'cancel-requested',
]);

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
    requestJson: row.request_json,
    ...(row.placement_explanation === null || row.placement_explanation === undefined
      ? {}
      : { placementExplanation: row.placement_explanation }),
    ...(row.resolved_enrollment_id === null || row.resolved_enrollment_id === undefined
      ? {}
      : { resolvedEnrollmentId: row.resolved_enrollment_id }),
  };
}

function readDispatch(dispatchId: string): NodeDispatchRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM mesh_node_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as DispatchRow | undefined;
  return row === undefined ? null : rowToRecord(row);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read-only lookup used by workflow recovery to reattach a durable attempt. */
export function getWorkflowDispatch(dispatchId: string): NodeDispatchRecord | null {
  return readDispatch(dispatchId);
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
 * Submits (or re-submits) the persisted `job.create` request for a
 * dispatch. `job.create` is idempotent on (source, requestId) +
 * payloadHash, so replaying a stored request after a crash re-binds to the
 * same backend job rather than minting a second one.
 */
async function submitDispatch(dispatchId: string, params: JobCreateParams): Promise<JobSummary> {
  const job = await submitPreparedJob(params);
  getDb()
    .prepare(
      `UPDATE mesh_node_dispatches
       SET job_id = ?, state = ?, manifest_json = ?, placement_explanation = ?,
           resolved_enrollment_id = ?, updated_at = datetime('now')
       WHERE dispatch_id = ?`,
    )
    .run(
      job.id,
      job.keyDelivery === 'pending' ? 'awaiting-key-delivery' : job.state,
      JSON.stringify(job.inputManifest),
      job.placementExplanation,
      job.targetEnrollmentId,
      dispatchId,
    );
  return job;
}

/**
 * Dispatches a workflow node to a remote worker. The dispatch row —
 * including the byte-exact `job.create` request — is persisted BEFORE the
 * backend call: a crash between persist and create replays the stored
 * request, and a lost response re-binds via the dispatch-derived
 * requestId. Idempotent on dispatchId: an existing row is returned as-is.
 */
export async function dispatchWorkflowNode(input: {
  dispatchId: string;
  runId: string;
  nodeId: string;
  workspaceId: string;
  prompt: string;
  targetEnrollmentId?: string;
  /** PLACE-01: hard capability constraints for auto placement. */
  requirements?: CapabilityRequirements;
  verification?: string[];
  provider?: 'codex' | 'azure' | 'openai';
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  turnTimeoutMs?: number;
  requestedTarget?: JobCreateParams['requestedTarget'];
  pinnedManifest?: JobCreateParams['inputManifest'];
  resultRecipients?: string[];
}): Promise<NodeDispatchRecord> {
  const existing = readDispatch(input.dispatchId);
  if (existing !== null) {
    return existing;
  }
  const prepared = workflowNodeJobRequest({
    dispatchId: input.dispatchId,
    runId: input.runId,
    nodeId: input.nodeId,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    ...(input.targetEnrollmentId === undefined
      ? {}
      : { targetEnrollmentId: input.targetEnrollmentId }),
    ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: input.turnTimeoutMs }),
    ...(input.requestedTarget === undefined ? {} : { requestedTarget: input.requestedTarget }),
    ...(input.pinnedManifest === undefined ? {} : { pinnedManifest: input.pinnedManifest }),
    ...(input.resultRecipients === undefined ? {} : { resultRecipients: input.resultRecipients }),
  });
  // Seals the sensitive inputs and persists the TCK under the request id;
  // the returned params are byte-stable for replay.
  const params = prepareSealedJob(await prepared.build());
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mesh_node_dispatches
       (dispatch_id, run_id, node_id, job_id, request_id, workspace_id,
        manifest_json, request_json, state, cancel_requested, output_json,
        created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'submitting', 0, NULL, ?, ?)`,
    )
    .run(
      input.dispatchId,
      input.runId,
      input.nodeId,
      prepared.requestId,
      input.workspaceId,
      JSON.stringify(params.inputManifest),
      JSON.stringify(params),
      now,
      now,
    );
  await submitDispatch(input.dispatchId, params);
  return readDispatch(input.dispatchId)!;
}

/**
 * Refreshes one dispatch against the backend job. Unsubmitted requests are
 * replayed first (the stored params re-bind via requestId); persisted
 * cancellation intent is replayed until the job lands terminal; late-bound
 * targets retry task-key delivery. On a terminal `completed` job with a
 * result manifest, adopts the worker's bundle refs into the local
 * checkouts and records the output.
 */
export async function refreshDispatch(dispatchId: string): Promise<NodeDispatchRecord> {
  const row = readDispatch(dispatchId);
  if (row === null) throw new Error(`dispatch not found: ${dispatchId}`);
  if (!NONTERMINAL_STATES.has(row.state) && row.output !== null) return row;

  // Crash between persist and create: replay the byte-exact request.
  if (row.jobId === null) {
    if (row.requestJson === null) {
      throw new Error(`dispatch ${dispatchId} has no persisted job.create request`);
    }
    const job = await submitDispatch(dispatchId, JSON.parse(row.requestJson) as JobCreateParams);
    // A cancel persisted while the job was unsubmitted still applies.
    if (!row.cancelRequested) {
      writeDispatchState(dispatchId, job.state);
      return readDispatch(dispatchId)!;
    }
  }

  const bound = readDispatch(dispatchId)!;
  if (bound.jobId === null) return bound;
  if (bound.cancelRequested && NONTERMINAL_STATES.has(bound.state)) {
    // Replay until job.get confirms a terminal state — a missing ack is
    // never treated as cancelled.
    const { job } = await dispatchRpc<{ job: JobSummary }>('job.cancel', {
      jobId: bound.jobId,
    });
    writeDispatchState(dispatchId, job.state);
    return readDispatch(dispatchId)!;
  }

  const { job, attempts } = await dispatchRpc<JobGetResult>('job.get', { jobId: bound.jobId });
  void ensureTaskKeyDelivery(job).catch(() => undefined);
  const effectiveState = job.keyDelivery === 'pending' ? 'awaiting-key-delivery' : job.state;
  writeDispatchState(dispatchId, effectiveState);
  if (job.state === 'completed' && bound.output === null) {
    const completed = attempts.find((a) => a.state === 'completed');
    const ctx = contextProvider?.() ?? null;
    let completedResult: unknown = completed?.result;
    if (completed?.sealedResult !== undefined) {
      if (ctx?.scope === undefined) {
        throw new Error('Completed dispatch requires a local task-key scope.');
      }
      const taskKey = taskKeyFor(ctx.scope, bound.jobId);
      if (taskKey === null) throw new Error('Completed dispatch task key is unavailable.');
      try {
        completedResult = unsealTaskResult(
          ctx.scope,
          bound.jobId,
          completed.id,
          taskKey,
          completed.sealedResult,
        );
      } catch (error) {
        const reason = error instanceof UnsealError ? error.reason : 'unknown';
        throw new Error(`Unable to decrypt dispatch result (${reason}).`);
      }
    }
    const manifest = (completedResult as { resultManifest?: AttemptResultManifest } | undefined)
      ?.resultManifest;
    if (manifest !== undefined) {
      await importNodeResults(
        dispatchId,
        bound.workspaceId,
        manifest,
        isRecord(completedResult) ? completedResult : undefined,
      );
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
  if (NONTERMINAL_STATES.has(row.state) && row.jobId !== null) {
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
  result?: Record<string, unknown>,
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
      adoptedRefs.push({
        repositoryId: repo.repositoryId,
        ref: localRef,
        commit: repo.resultCommit,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const output: NodeDispatchOutput = {
    resultManifest: manifest,
    adoptedRefs,
    ...(result === undefined ? {} : { result }),
  };
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
