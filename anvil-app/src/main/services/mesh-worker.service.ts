// MESH-02: device-local worker runtime.
//
// Sync enrollment does not authorize Mesh. A device opts in locally via
// `setMeshWorkerEnabled(true)`, which publishes a `device.policy` whose
// worker section allows jobs; every backend worker.* op fails closed
// without it. The worker maintains a leased incarnation via periodic
// `worker.connect`, publishes capabilities, claims `job.available` work,
// writes a local attempt journal BEFORE doing any work (spec §9), renews
// attempt leases on the 30s cadence, and reports fenced outcomes.
//
// This module never imports sync-runtime: the runtime injects a context
// provider (apiUrl + token + enrollment) via `configureMeshWorkerContext`
// and calls the lifecycle hooks below on enable/disable/frame events.

import { createHash, randomUUID } from 'node:crypto';
import { platform, totalmem } from 'node:os';
import { getDb } from '../db/database.js';
import { LEASE_RENEW_INTERVAL_MS } from '../../../cloud/contract/version.js';
import { canonicalJson } from './sync-persistence.service.js';
import { rpc as backendRpc, BackendRpcError } from './sync-backend-client.service.js';
import type {
  DevicePolicy,
  WorkerCapabilities,
  WorkerConnectResult,
} from '../../../cloud/contract/workers.js';
import type {
  AttemptRenewResult,
  ExecutionAttempt,
  ExecutionManifest,
  JobClaimResult,
  JobGetResult,
  JobListResult,
  JobSummary,
  MeshJob,
} from '../../../cloud/contract/jobs.js';

export type { MeshWorkerStatus } from '../../shared/sync-runtime.js';
import type { MeshWorkerStatus } from '../../shared/sync-runtime.js';

interface MeshWorkerContext {
  apiUrl: string;
  accessToken: string;
  enrollmentId: string;
  /**
   * Sends a frame on the account's live socket when one is connected.
   * Activity frames are an accelerator — the durable journal is the record —
   * so a null sender (socket down) just skips emission.
   */
  sendFrame?: (frame: unknown) => void;
}

interface AttemptRow {
  id: string;
  job_id: string;
  enrollment_id: string;
  incarnation: string;
  fence: number;
  kind: string;
  state: string;
  manifest_json: string;
  journal_json: string;
  result_json: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
}

interface WorkerStateRow {
  enabled: number;
  incarnation: string | null;
  lease_expires_at: string | null;
  connected_at: string | null;
  last_error: string | null;
}

let contextProvider: (() => MeshWorkerContext | null) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let connectInFlight = false;

const DEFAULT_MAX_CONCURRENT_JOBS = 1;
const WORKER_CAPABILITIES = ['diagnostic'];

export function configureMeshWorkerContext(provider: () => MeshWorkerContext | null): void {
  contextProvider = provider;
}

function workerContext(): MeshWorkerContext | null {
  return contextProvider?.() ?? null;
}

async function meshRpc<T>(operation: string, params: unknown): Promise<T> {
  const ctx = workerContext();
  if (ctx === null) {
    throw new Error('Mesh worker has no active sync session.');
  }
  const { result } = await backendRpc<T>(
    { apiUrl: ctx.apiUrl },
    operation,
    params,
    ctx.accessToken,
  );
  return result;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---- durable worker state -------------------------------------------------

function readWorkerState(): WorkerStateRow {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM mesh_worker_state WHERE id = 1')
    .get() as WorkerStateRow | undefined;
  return (
    row ?? {
      enabled: 0,
      incarnation: null,
      lease_expires_at: null,
      connected_at: null,
      last_error: null,
    }
  );
}

function writeWorkerState(patch: Partial<WorkerStateRow>): void {
  const db = getDb();
  const current = readWorkerState();
  const next = { ...current, ...patch };
  db.prepare(
    `INSERT INTO mesh_worker_state (
       id, enabled, incarnation, lease_expires_at, connected_at, last_error, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       incarnation = excluded.incarnation,
       lease_expires_at = excluded.lease_expires_at,
       connected_at = excluded.connected_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    next.enabled,
    next.incarnation,
    next.lease_expires_at,
    next.connected_at,
    next.last_error,
    nowIso(),
  );
}

// ---- attempt journal ------------------------------------------------------

function appendJournal(attemptId: string, event: string, detail?: Record<string, unknown>): void {
  const db = getDb();
  const row = db
    .prepare('SELECT journal_json FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { journal_json: string } | undefined;
  if (!row) return;
  const journal = JSON.parse(row.journal_json) as unknown[];
  journal.push({ at: nowIso(), event, ...(detail !== undefined ? { detail } : {}) });
  db.prepare('UPDATE mesh_attempts SET journal_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(journal),
    nowIso(),
    attemptId,
  );
}

function updateAttemptState(
  attemptId: string,
  state: string,
  patch?: { resultJson?: string | null; cancelRequested?: boolean },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE mesh_attempts SET state = ?, result_json = COALESCE(?, result_json),
       cancel_requested = MAX(cancel_requested, ?), updated_at = ? WHERE id = ?`,
  ).run(state, patch?.resultJson ?? null, patch?.cancelRequested === true ? 1 : 0, nowIso(), attemptId);
}

function activeAttempts(): AttemptRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM mesh_attempts
       WHERE state IN ('claimed', 'preparing', 'running', 'stopping')`,
    )
    .all() as AttemptRow[];
}

// ---- lifecycle ------------------------------------------------------------

export function isMeshWorkerEnabled(): boolean {
  return readWorkerState().enabled === 1;
}

export function getMeshWorkerStatus(): MeshWorkerStatus {
  const state = readWorkerState();
  const live =
    state.incarnation !== null &&
    state.lease_expires_at !== null &&
    Date.parse(state.lease_expires_at) > Date.now();
  return {
    enabled: state.enabled === 1,
    connected: live,
    workerIncarnation: state.incarnation,
    leaseExpiresAt: state.lease_expires_at,
    activeAttempts: activeAttempts().length,
    lastError: state.last_error,
  };
}

/**
 * Local opt-in. Enabling publishes an allowing device policy (fail-closed:
 * the backend rejects worker.* ops without it), connects the incarnation,
 * and publishes capabilities. Disabling publishes `allowJobs: false`, stops
 * the heartbeat, and drops the local incarnation record — in-flight local
 * attempt rows keep their journals for inspection.
 */
export async function setMeshWorkerEnabled(enabled: boolean): Promise<MeshWorkerStatus> {
  if (!enabled) {
    stopHeartbeat();
    try {
      await meshRpc('device.policy.publish', {
        worker: { allowJobs: false },
      } satisfies DevicePolicy);
    } catch {
      // Best effort: the lease expires on its own within WORKER_LEASE_MS.
    }
    // Opt-out with in-flight work: the attempt leases are now unwinnable
    // (deny policy + dropped incarnation), so fence them off locally rather
    // than leaving them marked running forever.
    for (const attempt of activeAttempts()) {
      appendJournal(attempt.id, 'worker-disabled');
      updateAttemptState(attempt.id, 'unknown-outcome');
    }
    writeWorkerState({
      enabled: 0,
      incarnation: null,
      lease_expires_at: null,
      connected_at: null,
    });
    return getMeshWorkerStatus();
  }

  writeWorkerState({ enabled: 1, last_error: null });
  // Arm before connect: if the first connect fails (offline, policy lag),
  // the 30s tick retries instead of leaving the worker enabled-but-dead.
  armHeartbeat();
  await publishWorkerPolicy();
  await connectWorker();
  return getMeshWorkerStatus();
}

function buildDevicePolicy(): DevicePolicy {
  return {
    worker: {
      allowJobs: true,
      allowedSources: ['same-account'],
      maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
    },
  };
}

async function publishWorkerPolicy(): Promise<void> {
  await meshRpc('device.policy.publish', buildDevicePolicy());
}

function buildCapabilities(): WorkerCapabilities {
  return {
    os: platform(),
    arch: process.arch,
    memoryMb: Math.round(totalmem() / (1024 * 1024)),
    capabilities: [...WORKER_CAPABILITIES],
    maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  };
}

/**
 * Registers or refreshes the worker incarnation, then publishes capabilities
 * on a fresh incarnation. Called on enable, on each heartbeat while the
 * lease is live, and lazily after expiry (a fresh incarnation is minted).
 */
async function connectWorker(): Promise<void> {
  if (connectInFlight) return;
  connectInFlight = true;
  try {
    const hadIncarnation = readWorkerState().incarnation;
    const result = await meshRpc<WorkerConnectResult>('worker.connect', {});
    writeWorkerState({
      incarnation: result.workerIncarnation,
      lease_expires_at: result.leaseExpiresAt,
      connected_at: nowIso(),
      last_error: null,
    });
    if (result.workerIncarnation !== hadIncarnation) {
      await meshRpc('worker.capabilities.publish', buildCapabilities());
      // A fresh incarnation means the backend forgot prior lease state; any
      // local attempt rows still marked active are stale — mark them for
      // inspection rather than assuming the backend still honors them.
      for (const attempt of activeAttempts()) {
        appendJournal(attempt.id, 'incarnation-expired', {
          previousIncarnation: attempt.incarnation,
        });
        updateAttemptState(attempt.id, 'unknown-outcome');
      }
    }
  } catch (error) {
    writeWorkerState({
      last_error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    connectInFlight = false;
  }
}

/** Called by the runtime when sync becomes enabled / the channel goes live. */
export function meshWorkerOnSyncReady(): void {
  if (!isMeshWorkerEnabled()) return;
  void connectWorker()
    .then(() => publishReplicas())
    .then(() => sweepClaimableJobs())
    .catch(() => undefined);
  armHeartbeat();
}

/**
 * Durable catch-up for missed `job.available` frames: on connect, claim any
 * queued job already targeted at this enrollment. The socket accelerates;
 * this read is the recovery path.
 */
async function sweepClaimableJobs(): Promise<void> {
  const ctx = workerContext();
  const state = readWorkerState();
  if (ctx === null || state.incarnation === null) return;
  let result: JobListResult;
  try {
    result = await meshRpc<JobListResult>('job.list', { state: 'queued', limit: 20 });
  } catch {
    return;
  }
  for (const job of result.jobs) {
    if (job.targetEnrollmentId !== ctx.enrollmentId) continue;
    if (activeAttempts().length >= DEFAULT_MAX_CONCURRENT_JOBS) return;
    await handleJobAvailable(job.id).catch(() => undefined);
  }
}

/** Called when sync is disabled, the session is lost, or the backend changes. */
export function meshWorkerOnSyncGone(): void {
  stopHeartbeat();
  // enabled stays set — the worker re-arms on the next ready transition.
  writeWorkerState({ incarnation: null, lease_expires_at: null });
}

function armHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, LEASE_RENEW_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer === null) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function heartbeat(): Promise<void> {
  if (!isMeshWorkerEnabled()) {
    stopHeartbeat();
    return;
  }
  const state = readWorkerState();
  const leaseExpiry = state.lease_expires_at !== null ? Date.parse(state.lease_expires_at) : 0;
  if (state.incarnation === null || leaseExpiry - Date.now() < LEASE_RENEW_INTERVAL_MS) {
    await connectWorker();
  }
  await renewActiveAttempts();
}

// ---- replicas --------------------------------------------------------------

/**
 * Publishes coarse replica readiness for local workspace definitions.
 * Metadata only — workspace ids, definition revision (updated_at), and a
 * readiness enum; paths and local config never leave the device.
 */
export async function publishReplicas(): Promise<void> {
  if (!isMeshWorkerEnabled() || readWorkerState().incarnation === null) return;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.id AS workspace_id, w.updated_at AS definition_revision, w.definition_state
       FROM workspaces w`,
    )
    .all() as Array<{
    workspace_id: string;
    definition_revision: string;
    definition_state: string;
  }>;
  if (rows.length === 0) return;
  await meshRpc('worker.replica.publish', {
    replicas: rows.map((row) => ({
      workspaceId: row.workspace_id,
      definitionRevision: row.definition_revision,
      readiness: row.definition_state === 'ready' ? 'ready' : 'not-ready',
      observedAt: nowIso(),
    })),
  });
}

// ---- jobs ------------------------------------------------------------------

/**
 * `job.available` frame handler. Claims are serialized through the
 * heartbeat-owned incarnation; capacity is re-checked against the local
 * active-attempt count before claiming.
 */
export async function handleJobAvailable(jobId: string): Promise<void> {
  if (!isMeshWorkerEnabled()) return;
  const state = readWorkerState();
  if (state.incarnation === null) return;
  if (activeAttempts().length >= DEFAULT_MAX_CONCURRENT_JOBS) return;

  let claimed: JobClaimResult;
  try {
    claimed = await meshRpc<JobClaimResult>('job.claim', { jobId });
  } catch (error) {
    // Raced out, expired, cancelled, or policy-changed — not claimable by us.
    if (error instanceof BackendRpcError) return;
    throw error;
  }
  const job = claimed.job;
  const attempt = claimed.attempt;

  // Local attempt journal BEFORE any work starts (spec §9): a crash between
  // claim and execution is reconstructable from this row.
  const db = getDb();
  db.prepare(
    `INSERT INTO mesh_attempts (
       id, job_id, enrollment_id, incarnation, fence, kind, state,
       manifest_json, journal_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)`,
  ).run(
    attempt.id,
    job.id,
    workerContext()?.enrollmentId ?? '',
    attempt.workerIncarnation,
    attempt.fence,
    job.kind,
    JSON.stringify(claimed.manifest),
    JSON.stringify([{ at: nowIso(), event: 'claimed', detail: { fence: attempt.fence } }]),
    nowIso(),
    nowIso(),
  );

  await runAttempt(attempt, job);
}

async function renewActiveAttempts(): Promise<void> {
  const active = activeAttempts();
  if (active.length === 0) return;
  const result = await meshRpc<AttemptRenewResult>('attempt.renew', {
    renewals: active.map((a) => ({
      attemptId: a.id,
      incarnation: a.incarnation,
      fence: a.fence,
    })),
  });
  for (const item of result.results) {
    if (item.status === 'rejected') {
      appendJournal(item.attemptId, 'lease-renewal-rejected', { reason: item.reason });
      updateAttemptState(item.attemptId, 'unknown-outcome');
    }
  }
  // Cancellation has no socket frame in MESH-02 — the durable check is a
  // job.get per active attempt, bounded by maxConcurrentJobs.
  for (const attempt of activeAttempts()) {
    if (attempt.cancel_requested === 1) continue;
    try {
      const { job } = await meshRpc<JobGetResult>('job.get', { jobId: attempt.job_id });
      if (job.state === 'cancel-requested' || job.state === 'cancelled') {
        appendJournal(attempt.id, 'cancel-requested');
        updateAttemptState(attempt.id, 'stopping', { cancelRequested: true });
      }
    } catch {
      // Reachability is handled by the heartbeat connect path.
    }
  }
}

async function runAttempt(attempt: ExecutionAttempt, job: MeshJob): Promise<void> {
  const attemptId = attempt.id;
  appendJournal(attemptId, 'preparing');
  updateAttemptState(attemptId, 'preparing');
  try {
    if (job.kind !== 'diagnostic') {
      appendJournal(attemptId, 'unsupported-kind', { kind: job.kind });
      updateAttemptState(attemptId, 'failed');
      await reportAttempt(attemptId, 'failed', {
        error: `unsupported job kind: ${job.kind}`,
      });
      return;
    }
    updateAttemptState(attemptId, 'running');
    appendJournal(attemptId, 'running');
    const result = await executeDiagnostic(job.inputManifest, attemptId, attempt);
    const cancelled = isCancelRequested(attemptId);
    updateAttemptState(attemptId, cancelled ? 'cancelled' : 'completed', {
      resultJson: JSON.stringify(result),
    });
    appendJournal(attemptId, cancelled ? 'cancelled' : 'completed', { result });
    // A clean stop reports 'completed': when the job is cancel-requested the
    // backend masks it to 'cancelled' (verified stop). Reporting 'failed'
    // would wrongly end the job as failed.
    await reportAttempt(attemptId, 'completed', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendJournal(attemptId, 'failed', { error: message });
    updateAttemptState(attemptId, 'failed', {
      resultJson: JSON.stringify({ error: message }),
    });
    await reportAttempt(attemptId, 'failed', { error: message });
  }
}

function isCancelRequested(attemptId: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT cancel_requested FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { cancel_requested: number } | undefined;
  return row?.cancel_requested === 1;
}

/**
 * Emits an `activity` status frame for an attempt. Best-effort: the frame is
 * ephemeral observation, the attempt journal + report are the durable record.
 * Sequence is per-attempt monotonic so observers can detect gaps.
 */
const activitySequences = new Map<string, number>();
function emitActivity(attempt: ExecutionAttempt, text: string): void {
  const send = workerContext()?.sendFrame;
  if (send === undefined) return;
  const streamId = `attempt:${attempt.id}`;
  const sequence = (activitySequences.get(streamId) ?? 0) + 1;
  activitySequences.set(streamId, sequence);
  try {
    send({
      type: 'activity',
      version: 1,
      id: randomUUID(),
      attemptId: attempt.id,
      generation: attempt.fence,
      streamId,
      sequence,
      payload: { kind: 'status', text, byteLength: text.length, truncated: false },
    });
  } catch {
    // Socket mid-reconnect — the durable journal still records the transition.
  }
}

/**
 * The diagnostic job proves the claim→journal→renew→report pipeline without
 * an agent runner: verify the manifest's declared digest shape, record
 * timings, and return a small result. Checkpoints between steps observe the
 * cancel flag so a `job.cancel` during execution ends the attempt cleanly.
 */
async function executeDiagnostic(
  manifest: ExecutionManifest,
  attemptId: string,
  attempt?: ExecutionAttempt,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  appendJournal(attemptId, 'diagnostic.manifest', {
    workspaceDefinitionRevision: manifest.workspaceDefinitionRevision,
    repositoryCount: manifest.repositories.length,
    provider: manifest.provider,
    model: manifest.model,
  });
  if (attempt !== undefined) {
    emitActivity(attempt, 'diagnostic: manifest received');
  }
  if (isCancelRequested(attemptId)) {
    return { ok: false, cancelled: true, tookMs: Date.now() - started };
  }
  appendJournal(attemptId, 'diagnostic.environment', {
    os: platform(),
    arch: process.arch,
    capabilities: WORKER_CAPABILITIES,
  });
  if (attempt !== undefined) {
    emitActivity(attempt, 'diagnostic: environment recorded');
  }
  return {
    ok: true,
    manifestReceived: true,
    repositoriesDeclared: manifest.repositories.length,
    tookMs: Date.now() - started,
  };
}

async function reportAttempt(
  attemptId: string,
  outcome: 'completed' | 'failed',
  result: Record<string, unknown>,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT incarnation, fence FROM mesh_attempts WHERE id = ?')
    .get(attemptId) as { incarnation: string; fence: number } | undefined;
  if (!row) return;
  try {
    const report = await meshRpc<{ status: string }>('attempt.report', {
      attemptId,
      incarnation: row.incarnation,
      fence: row.fence,
      outcome,
      result,
      ...(outcome === 'failed' && typeof result['error'] === 'string'
        ? { error: result['error'] }
        : {}),
    });
    if (report.status === 'late-result-retained') {
      // Fence was stale — the backend kept the result for forensics but the
      // attempt is already terminal there.
      appendJournal(attemptId, 'report-late-result');
      updateAttemptState(attemptId, 'unknown-outcome');
    }
  } catch (error) {
    // A rejected report (stale fence, expired lease) leaves the local row
    // terminal with its journal — the backend retains it as a late result.
    appendJournal(attemptId, 'report-rejected', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof BackendRpcError && !error.retryable) {
      updateAttemptState(attemptId, 'unknown-outcome');
    }
  }
}

/**
 * Boot-time reconciliation: attempts still marked active were interrupted by
 * a crash/quit. The incarnation lease is certainly dead, so fences are stale —
 * mark them `unknown-outcome` locally and best-effort report the retained
 * result so the backend keeps it for forensics.
 */
export async function reconcileMeshAttemptsOnBoot(): Promise<void> {
  for (const attempt of activeAttempts()) {
    appendJournal(attempt.id, 'reconciled-on-boot');
    updateAttemptState(attempt.id, 'unknown-outcome');
    if (attempt.result_json !== null && isMeshWorkerEnabled()) {
      void meshRpc('attempt.report', {
        attemptId: attempt.id,
        incarnation: attempt.incarnation,
        fence: attempt.fence,
        outcome: 'failed',
        result: { error: 'interrupted; recovered on boot' },
      }).catch(() => undefined);
    }
  }
}

export function resetMeshWorkerForTests(): void {
  stopHeartbeat();
  connectInFlight = false;
  contextProvider = null;
  activitySequences.clear();
}

/** Test seam: one heartbeat tick without waiting for the 30s interval. */
export function meshWorkerHeartbeatForTests(): Promise<void> {
  return heartbeat();
}

// ---- source side ------------------------------------------------------------

// `job.create`/`job.get` are account ops, not worker ops — any enrolled device
// may request work. The diagnostic kind is the MESH-02 pipeline proof; richer
// kinds (prepare-workspace, start-session, workflow-node) land with SESSION-02+.

export interface DiagnosticJobInput {
  requestId: string;
  targetEnrollmentId?: string;
  manifest?: Partial<ExecutionManifest>;
}

/**
 * Creates a diagnostic job against a target enrollment (or auto placement).
 * Idempotent by requestId + payload hash — safe to retry after a lost
 * response without duplicating work.
 */
export async function createDiagnosticJob(input: DiagnosticJobInput): Promise<JobSummary> {
  const manifest: ExecutionManifest = {
    workspaceDefinitionRevision: 'diagnostic',
    repositories: [],
    bootstrapDigest: 'diagnostic',
    provider: 'local',
    model: 'none',
    configVersions: {},
    inputs: {},
    ...(input.manifest ?? {}),
  };
  const requestedTarget =
    input.targetEnrollmentId !== undefined
      ? { kind: 'device' as const, enrollmentId: input.targetEnrollmentId }
      : { kind: 'auto' as const };
  // The backend verifies the hash covers the canonical job payload; a replay
  // of the same requestId with a different payload is a conflict.
  const payloadHash = createHash('sha256')
    .update(
      canonicalJson({ kind: 'diagnostic', requestedTarget, inputManifest: manifest }),
      'utf8',
    )
    .digest('hex');
  const result = await meshRpc<{ job: JobSummary }>('job.create', {
    requestId: input.requestId,
    payloadHash,
    kind: 'diagnostic',
    requestedTarget,
    inputManifest: manifest,
    retryPolicy: 'never',
  });
  return result.job;
}

export async function getMeshJob(jobId: string): Promise<JobSummary | null> {
  const result = await meshRpc<JobGetResult>('job.get', { jobId });
  return result.job ?? null;
}

/**
 * Requests cancellation of a job this account created. Running jobs enter
 * `cancel-requested`; the worker's heartbeat job.get observes it and stops
 * the attempt before reporting.
 */
export async function cancelMeshJob(jobId: string): Promise<JobSummary> {
  const result = await meshRpc<{ job: JobSummary }>('job.cancel', { jobId });
  return result.job;
}
