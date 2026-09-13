/**
 * WS-02 (spec §7): journalled workspace materialisation — clone, link, and
 * safe removal of local checkouts for workspace repo definitions.
 *
 * Invariants:
 * - Journal rows are written BEFORE the matching filesystem mutation, so a
 *   crash mid-operation is reconstructable from `workspace_materialization_*`.
 * - Clone goes to an operation-owned staging dir under
 *   `userData/mesh-staging/<opId>/<portableId>` and is only moved into place
 *   after verification. Ownership is proven by the journal, never inferred
 *   from a matching directory name.
 * - Git is invoked argument-safe (execFile argv, never a shell string).
 *   Approved transports are authenticated HTTPS and SSH; credentials come
 *   from target-local config — no tokens are injected here.
 */
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs, { type Stats } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type {
  WorkspaceCloneRepoRequest,
  WorkspaceCloneRequest,
  WorkspaceCloneResult,
  WorkspaceLinkResult,
  WorkspaceMaterializationOpSummary,
  WorkspaceMaterializationRepoResult,
  WorkspaceMaterializationStage,
  WorkspaceRemoveCheckoutResult,
} from '../../shared/types.js';
import { SYNC_ENTITY_WORKSPACE_DEFINITION } from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import { canonicalJson, listSyncScopesForEntity } from './sync-persistence.service.js';
import { recomputeWorkspaceDefinitionState } from './sync-entity-domain.js';
import { mapWorkspaceRepoToCheckout } from './workspace.service.js';
import { connectRepoPath } from './repo-connect.service.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_BUFFER_BYTES = 16 * 1024 * 1024;
const MIN_FREE_DISK_BYTES = 256 * 1024 * 1024;
const MAX_LFS_SCAN_FILES = 2_000;
const LFS_POINTER_PREFIX = 'version https://git-lfs';
const MAX_CLONE_RESTARTS = 2;
const ACTIVE_ATTEMPT_STATES = ['claimed', 'preparing', 'running', 'stopping'] as const;
const SUCCESS_STAGES: WorkspaceMaterializationStage[] = [
  'mapping-published',
  'detached',
  'quarantined',
];
const TERMINAL_STAGES: WorkspaceMaterializationStage[] = [
  ...SUCCESS_STAGES,
  'failed',
  'unsupported',
];

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface OpRow {
  id: string;
  workspace_id: string;
  kind: 'clone' | 'link' | 'remove';
  definition_revision: string | null;
  request_key: string;
  request_json: string;
  state: 'running' | 'completed' | 'failed' | 'awaiting-review';
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface StageRow {
  op_id: string;
  portable_id: string;
  remote_url: string | null;
  requested_ref: string | null;
  requested_commit: string | null;
  destination: string | null;
  staging_path: string | null;
  ownership_intent: 'anvil-created' | 'linked';
  stage: WorkspaceMaterializationStage;
  stage_reason: string | null;
  resolved_commit: string | null;
  repo_id: string | null;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

interface RepoDefinitionRow {
  portable_id: string;
  name: string;
  remote_url: string | null;
  default_branch: string | null;
  mapped_repo_id: string | null;
}

export class MaterializationConflictError extends Error {
  readonly code = 'conflict';
  constructor(message: string) {
    super(message);
    this.name = 'MaterializationConflictError';
  }
}

// ---------------------------------------------------------------------------
// Paths (root is injectable for tests)
// ---------------------------------------------------------------------------

let userDataRootOverride: string | null = null;

/** Test hook: point staging/quarantine roots at a tmpdir. */
export function setWorkspaceMaterializationRootForTests(root: string | null): void {
  userDataRootOverride = root;
}

function opsRoot(): string {
  return userDataRootOverride ?? app.getPath('userData');
}
function stagingRoot(): string {
  return path.join(opsRoot(), 'mesh-staging');
}
function quarantineRoot(): string {
  return path.join(opsRoot(), 'quarantine');
}
function stagingPathFor(opId: string, portableId: string): string {
  return path.join(stagingRoot(), opId, portableId);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Argument-safe git invocation
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function gitResult(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_BUFFER_BYTES,
      env: {
        ...process.env,
        // Never prompt for credentials interactively — auth failures must
        // surface as errors, not a hung prompt. Credential helpers and ssh
        // config come from target-local git configuration only.
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr:
        typeof e.stderr === 'string'
          ? e.stderr
          : typeof e.message === 'string'
            ? e.message
            : String(err),
    };
  }
}

const AUTH_FAILURE_PATTERN =
  /authentication failed|could not read (username|password|credentials)|permission denied|invalid username or password|not authorized|authorization failed/i;

export function classifyCloneFailure(output: string): 'auth-failed' | 'clone-failed' {
  return AUTH_FAILURE_PATTERN.test(output) ? 'auth-failed' : 'clone-failed';
}

// ---------------------------------------------------------------------------
// Transport policy (spec §7: approved = authenticated HTTPS or SSH)
// ---------------------------------------------------------------------------

type RemoteTransport = 'https' | 'ssh' | 'local' | 'helper' | 'credentials' | 'other';

interface RemoteClassification {
  transport: RemoteTransport;
  /** Normalised scheme+host identity used to detect mid-operation changes. */
  identity: string | null;
}

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+/;
const HELPER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*::/;

function classifyRemoteUrl(raw: string): RemoteClassification {
  const trimmed = raw.trim();
  if (trimmed === '') return { transport: 'other', identity: null };
  // ext:: and other remote helpers are never approved.
  if (HELPER_SCHEME.test(trimmed)) return { transport: 'helper', identity: null };
  // scp-like SSH syntax (user@host:path) — must not contain '://'.
  if (SCP_LIKE.test(trimmed) && !trimmed.includes('://')) {
    const host = trimmed.slice(trimmed.indexOf('@') + 1, trimmed.indexOf(':')).toLowerCase();
    return { transport: 'ssh', identity: `ssh://${host}` };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Bare filesystem path — not a URL.
    return { transport: 'local', identity: null };
  }
  if (url.username !== '' || url.password !== '') {
    return { transport: 'credentials', identity: null };
  }
  if (url.protocol === 'https:') {
    return { transport: 'https', identity: `https://${url.host.toLowerCase()}` };
  }
  if (url.protocol === 'ssh:') {
    return { transport: 'ssh', identity: `ssh://${url.host.toLowerCase()}` };
  }
  if (url.protocol === 'file:') return { transport: 'local', identity: null };
  // Single-letter schemes like 'c:' are Windows paths, not transports.
  if (/^[a-z]:$/i.test(url.protocol)) return { transport: 'local', identity: null };
  return { transport: 'other', identity: `${url.protocol}//${url.host.toLowerCase()}` };
}

/**
 * Enforce the transport policy. A synced workspace definition must never
 * trigger a local-path read; embedded credentials and remote helpers are
 * always rejected. Returns a machine-readable reason when rejected.
 */
export function transportRejection(
  remoteUrl: string,
  opts: { fromSyncedDefinition: boolean },
): string | null {
  switch (classifyRemoteUrl(remoteUrl).transport) {
    case 'https':
    case 'ssh':
      return null;
    case 'helper':
      return 'remote-helper-rejected';
    case 'credentials':
      return 'embedded-credentials-rejected';
    case 'local':
      return opts.fromSyncedDefinition ? 'local-remote-rejected' : null;
    default:
      return 'transport-not-approved';
  }
}

/** Normalise a remote URL for equality comparison (link verification). */
function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (SCP_LIKE.test(trimmed) && !trimmed.includes('://')) {
    const at = trimmed.indexOf('@');
    const colon = trimmed.indexOf(':');
    const user = trimmed.slice(0, at);
    const host = trimmed.slice(at + 1, colon).toLowerCase();
    const rest = trimmed.slice(colon + 1);
    return `ssh://${user}@${host}/${stripGitSuffix(rest)}`;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') {
      return `file://${realpathOrSelf(decodeURIComponent(url.pathname))}`;
    }
    const pathname = stripGitSuffix(url.pathname.replace(/\/+$/, ''));
    const auth = url.username !== '' ? `${url.username}@` : '';
    return `${url.protocol}//${auth}${url.host.toLowerCase()}${pathname}`;
  } catch {
    return `path://${realpathOrSelf(trimmed)}`;
  }
}

function stripGitSuffix(p: string): string {
  return p.endsWith('.git') ? p.slice(0, -'.git'.length) : p;
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDefinitionSynced(workspaceId: string): boolean {
  return listSyncScopesForEntity(SYNC_ENTITY_WORKSPACE_DEFINITION, workspaceId).length > 0;
}

// ---------------------------------------------------------------------------
// Journal helpers
// ---------------------------------------------------------------------------

function readOp(opId: string): OpRow | undefined {
  return getDb().prepare('SELECT * FROM workspace_materialization_ops WHERE id = ?').get(opId) as
    | OpRow
    | undefined;
}

function readStages(opId: string): StageRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM workspace_materialization_repo_stages WHERE op_id = ? ORDER BY created_at, portable_id',
    )
    .all(opId) as StageRow[];
}

function readStage(opId: string, portableId: string): StageRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM workspace_materialization_repo_stages WHERE op_id = ? AND portable_id = ?',
    )
    .get(opId, portableId) as StageRow | undefined;
}

function parseEvidence(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Advance a repo stage. Stage columns are write-forward only (COALESCE); a
 * fresh stage transition clears the previous stage_reason. `evidence` is
 * merged into evidence_json.
 */
function updateStage(
  opId: string,
  portableId: string,
  patch: Partial<
    Pick<
      StageRow,
      | 'stage'
      | 'stage_reason'
      | 'destination'
      | 'staging_path'
      | 'resolved_commit'
      | 'repo_id'
      | 'ownership_intent'
    >
  > & { evidence?: Record<string, unknown> },
): void {
  const db = getDb();
  const existing = readStage(opId, portableId);
  if (!existing) throw new Error(`Materialisation stage row missing: ${opId}/${portableId}`);

  const evidence =
    patch.evidence !== undefined
      ? JSON.stringify({ ...parseEvidence(existing.evidence_json), ...patch.evidence })
      : existing.evidence_json;

  db.prepare(
    `UPDATE workspace_materialization_repo_stages
     SET stage = COALESCE(?, stage),
         stage_reason = ?,
         destination = COALESCE(?, destination),
         staging_path = COALESCE(?, staging_path),
         resolved_commit = COALESCE(?, resolved_commit),
         repo_id = COALESCE(?, repo_id),
         ownership_intent = COALESCE(?, ownership_intent),
         evidence_json = ?,
         updated_at = ?
     WHERE op_id = ? AND portable_id = ?`,
  ).run(
    patch.stage ?? null,
    patch.stage_reason ?? null,
    patch.destination ?? null,
    patch.staging_path ?? null,
    patch.resolved_commit ?? null,
    patch.repo_id ?? null,
    patch.ownership_intent ?? null,
    evidence,
    nowIso(),
    opId,
    portableId,
  );
}

function finishOp(opId: string): void {
  const stages = readStages(opId);
  const allGood = stages.every((s) => SUCCESS_STAGES.includes(s.stage));
  const review = stages.some((s) => s.stage_reason === 'remote-divergence');
  getDb()
    .prepare(
      `UPDATE workspace_materialization_ops
       SET state = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      review ? 'awaiting-review' : allGood ? 'completed' : 'failed',
      allGood || review ? null : 'one or more repositories did not materialise',
      nowIso(),
      opId,
    );
}

function requestKey(kind: string, workspaceId: string, payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJson({ kind, workspaceId, request: payload }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// In-flight tracking: same-input attach + canonical-path destination locks
// ---------------------------------------------------------------------------

const runningOps = new Map<string, Promise<void>>();
const destinationLocks = new Map<string, string>(); // canonical destination -> opId

function isTerminalStage(stage: WorkspaceMaterializationStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

/** Attach to a running op: await the in-flight promise, or recover post-crash. */
async function attachToRunningOp(op: OpRow): Promise<void> {
  const existing = runningOps.get(op.id);
  if (existing) {
    await existing;
    return;
  }
  const resumed = resumeOp(op);
  runningOps.set(op.id, resumed);
  try {
    await resumed;
  } finally {
    runningOps.delete(op.id);
  }
}

/**
 * Spec §7 concurrency: different inputs for a portable id or destination
 * already covered by a running operation are a conflict.
 */
function assertNoRunningConflict(
  workspaceId: string,
  portableIds: ReadonlySet<string>,
  destinations: ReadonlySet<string>,
): void {
  const rows = getDb()
    .prepare(
      `SELECT o.workspace_id, s.portable_id, s.destination
       FROM workspace_materialization_repo_stages s
       JOIN workspace_materialization_ops o ON o.id = s.op_id
       WHERE o.state = 'running'`,
    )
    .all() as Array<{
    workspace_id: string;
    portable_id: string;
    destination: string | null;
  }>;
  for (const row of rows) {
    if (row.workspace_id === workspaceId && portableIds.has(row.portable_id)) {
      throw new MaterializationConflictError(
        `A materialisation operation is already running for repo ${row.portable_id}`,
      );
    }
    if (row.destination !== null && destinations.has(row.destination.toLowerCase())) {
      throw new MaterializationConflictError(
        `A materialisation operation is already running for destination ${row.destination}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Require `candidate` to be a direct child of `parentReal`. */
function assertChildOf(parentReal: string, candidate: string): void {
  const rel = path.relative(parentReal, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error(`Path escapes the allowed root: ${candidate}`);
  }
}

/** Require `candidate` to be strictly inside `root` (any depth). */
function assertUnderRoot(root: string, candidate: string): void {
  const rel = path.relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes its root: ${candidate}`);
  }
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function lstatOrNull(p: string): Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function dirEntryNamesLower(dir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(dir).map((e) => e.toLowerCase()));
  } catch {
    return new Set();
  }
}

function sanitizeCheckoutName(raw: string, fallback: string): string {
  // Strip path separators, Windows-reserved characters, and control chars.
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- deliberate control-char strip
    .replace(/[\\/:*?"<>|\x00-\x1f-]/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

function checkoutBaseName(remoteUrl: string | null, name: string, portableId: string): string {
  const fallback = `repo-${portableId.slice(0, 8)}`;
  if (name.trim() !== '') return sanitizeCheckoutName(name, fallback);
  if (remoteUrl !== null) {
    const base = path.basename(stripGitSuffix(remoteUrl.replace(/\/+$/, '')));
    return sanitizeCheckoutName(base, fallback);
  }
  return fallback;
}

function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EXDEV') {
      fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
      rmrf(from);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Clone request assembly
// ---------------------------------------------------------------------------

interface PinnedRepo {
  portableId: string;
  remoteUrl: string | null;
  ref: string | null;
  commit: string | null;
  /** Requested (pre-suffix) destination used for conflict detection. */
  candidateDestination: string;
}

function loadDefinition(workspaceId: string, portableId: string): RepoDefinitionRow | undefined {
  return getDb()
    .prepare(
      `SELECT portable_id, name, remote_url, default_branch, mapped_repo_id
       FROM workspace_repo_definitions WHERE workspace_id = ? AND portable_id = ?`,
    )
    .get(workspaceId, portableId) as RepoDefinitionRow | undefined;
}

function loadWorkspaceRevision(workspaceId: string): string {
  const row = getDb()
    .prepare('SELECT id, updated_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { id: string; updated_at: string } | undefined;
  if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
  return row.updated_at;
}

function buildPinnedRepos(
  workspaceId: string,
  destinationRoot: string,
  requested: WorkspaceCloneRepoRequest[] | undefined,
): { pinned: PinnedRepo[]; alreadyMapped: RepoDefinitionRow[] } {
  const db = getDb();
  let defs: RepoDefinitionRow[];
  if (requested !== undefined) {
    defs = requested.map((r) => {
      const def = loadDefinition(workspaceId, r.portableId);
      if (!def) throw new Error(`Repo definition not found: ${r.portableId}`);
      return def;
    });
  } else {
    defs = db
      .prepare(
        `SELECT portable_id, name, remote_url, default_branch, mapped_repo_id
         FROM workspace_repo_definitions WHERE workspace_id = ? AND mapped_repo_id IS NULL
         ORDER BY name`,
      )
      .all(workspaceId) as RepoDefinitionRow[];
  }

  const byId = new Map(requested?.map((r) => [r.portableId, r]) ?? []);
  const usedNames = new Set<string>();
  const pinned: PinnedRepo[] = [];
  const alreadyMapped: RepoDefinitionRow[] = [];
  for (const def of defs) {
    if (def.mapped_repo_id !== null) {
      alreadyMapped.push(def);
      continue;
    }
    const req = byId.get(def.portable_id);
    let base = checkoutBaseName(def.remote_url, def.name, def.portable_id);
    if (usedNames.has(base.toLowerCase())) {
      base = `${base}-${def.portable_id.slice(0, 8)}`;
    }
    usedNames.add(base.toLowerCase());
    pinned.push({
      portableId: def.portable_id,
      remoteUrl: def.remote_url,
      ref: req?.ref ?? def.default_branch,
      commit: req?.commit ?? null,
      candidateDestination: path.join(destinationRoot, base),
    });
  }
  pinned.sort((a, b) => a.portableId.localeCompare(b.portableId));
  return { pinned, alreadyMapped };
}

// ---------------------------------------------------------------------------
// Public API: clone
// ---------------------------------------------------------------------------

/**
 * Materialise unmapped workspace repo definitions by cloning them under
 * `destinationRoot`. Journalled end-to-end; concurrent calls with identical
 * pinned inputs attach to the same operation row.
 */
export async function startWorkspaceClone(
  input: WorkspaceCloneRequest,
): Promise<WorkspaceCloneResult> {
  if (typeof input.workspaceId !== 'string' || input.workspaceId === '') {
    throw new Error('workspaceId is required');
  }
  if (typeof input.destinationRoot !== 'string' || input.destinationRoot === '') {
    throw new Error('destinationRoot is required');
  }
  const definitionRevision = loadWorkspaceRevision(input.workspaceId);
  const destinationRoot = path.resolve(input.destinationRoot);
  const { pinned, alreadyMapped } = buildPinnedRepos(
    input.workspaceId,
    destinationRoot,
    input.repos,
  );

  const requestPayload = {
    destinationRoot,
    repos: pinned.map((p) => ({
      portableId: p.portableId,
      remoteUrl: p.remoteUrl,
      ref: p.ref,
      commit: p.commit,
      destination: p.candidateDestination,
    })),
  };
  const key = requestKey('clone', input.workspaceId, requestPayload);
  const db = getDb();

  const attach = db
    .prepare(
      `SELECT * FROM workspace_materialization_ops
       WHERE request_key = ? AND state IN ('running', 'completed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(key) as OpRow | undefined;
  if (attach) {
    if (attach.state === 'completed') return cloneResultFromOp(attach);
    await attachToRunningOp(attach);
    return cloneResultFromOp(readOp(attach.id)!);
  }

  assertNoRunningConflict(
    input.workspaceId,
    new Set(pinned.map((p) => p.portableId)),
    new Set(pinned.map((p) => p.candidateDestination.toLowerCase())),
  );

  // Journal the operation and per-repo intent BEFORE any filesystem writes.
  const opId = randomUUID();
  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO workspace_materialization_ops
           (id, workspace_id, kind, definition_revision, request_key, request_json,
            state, created_at, updated_at)
         VALUES (?, ?, 'clone', ?, ?, ?, 'running', ?, ?)`,
      ).run(
        opId,
        input.workspaceId,
        definitionRevision,
        key,
        JSON.stringify(requestPayload),
        now,
        now,
      );
      const insertStage = db.prepare(
        `INSERT INTO workspace_materialization_repo_stages
           (op_id, portable_id, remote_url, requested_ref, requested_commit, destination,
            staging_path, ownership_intent, stage, evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'anvil-created', 'pending', '{}', ?, ?)`,
      );
      for (const repo of pinned) {
        insertStage.run(
          opId,
          repo.portableId,
          repo.remoteUrl,
          repo.ref,
          repo.commit,
          repo.candidateDestination,
          stagingPathFor(opId, repo.portableId),
          now,
          now,
        );
      }
    })();
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) {
      throw new MaterializationConflictError(
        'A materialisation operation already covers this destination',
      );
    }
    throw err;
  }

  const run = (async () => {
    for (const repo of pinned) {
      await runCloneStages(opId, input.workspaceId, repo.portableId, /* isResume */ false);
    }
    finishOp(opId);
    recomputeWorkspaceDefinitionState(input.workspaceId);
  })();
  runningOps.set(opId, run);
  try {
    await run;
  } finally {
    runningOps.delete(opId);
  }

  const result = cloneResultFromOp(readOp(opId)!);
  for (const def of alreadyMapped) {
    result.repos.push({
      portableId: def.portable_id,
      stage: 'mapping-published',
      repoId: def.mapped_repo_id ?? undefined,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Clone stage machine
// ---------------------------------------------------------------------------

async function runCloneStages(
  opId: string,
  workspaceId: string,
  portableId: string,
  isResume: boolean,
): Promise<void> {
  try {
    // Guard against protocol/host changes to the definition mid-operation.
    if (isResume) {
      const stage = readStage(opId, portableId);
      const def = loadDefinition(workspaceId, portableId);
      if (stage && def && stage.remote_url !== null && def.remote_url !== null) {
        const journaled = classifyRemoteUrl(stage.remote_url);
        const current = classifyRemoteUrl(def.remote_url);
        if (journaled.identity !== current.identity) {
          updateStage(opId, portableId, {
            stage: 'failed',
            stage_reason: 'transport-changed',
          });
          return;
        }
      }
    }

    let restarts = 0;
    for (let guard = 0; guard < 24; guard += 1) {
      const stage = readStage(opId, portableId);
      if (!stage || isTerminalStage(stage.stage)) return;
      const before = stage.stage;
      switch (stage.stage) {
        case 'pending':
          stepReserveDestination(opId, workspaceId, stage);
          break;
        case 'destination-reserved':
          await stepCloneToStaging(opId, stage);
          break;
        case 'cloned-to-staging':
          await stepVerifyCheckout(opId, stage);
          break;
        case 'checkout-verified':
          await stepRecordCommit(opId, stage);
          break;
        case 'commit-recorded':
          await stepPublishMapping(opId, workspaceId, stage);
          break;
        default:
          return;
      }
      const after = readStage(opId, portableId);
      if (!after) throw new Error('Materialisation stage row disappeared');
      if (after.stage === before) {
        throw new Error(`Materialisation stage did not advance at '${before}'`);
      }
      // Wipe-and-restart regressions (unverified partial clone, lost
      // staging) are bounded so a deterministically bad remote cannot loop.
      if (
        (before === 'cloned-to-staging' || before === 'commit-recorded') &&
        after.stage === 'destination-reserved'
      ) {
        restarts += 1;
        if (restarts > MAX_CLONE_RESTARTS) {
          updateStage(opId, portableId, {
            stage: 'failed',
            stage_reason: 'unverifiable-clone',
          });
          return;
        }
      }
    }
    throw new Error('Materialisation exceeded stage guard');
  } catch (err) {
    const stage = readStage(opId, portableId);
    if (stage && !isTerminalStage(stage.stage)) {
      updateStage(opId, portableId, {
        stage: 'failed',
        stage_reason: 'internal-error',
        evidence: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    if (stage?.destination) destinationLocks.delete(stage.destination.toLowerCase());
    getDb()
      .prepare(`UPDATE workspace_materialization_ops SET error = ?, updated_at = ? WHERE id = ?`)
      .run(err instanceof Error ? err.message : String(err), nowIso(), opId);
  } finally {
    recomputeWorkspaceDefinitionState(workspaceId);
  }
}

/**
 * reserve-destination: pick a collision-free canonical destination under the
 * requested root. Validates containment, collisions (incl. case-insensitive
 * filesystems), symlinks, and available disk space. The transport policy
 * runs here first so a rejected remote never produces a filesystem write.
 */
function stepReserveDestination(opId: string, workspaceId: string, stage: StageRow): void {
  // Transport policy is enforced before any filesystem write.
  if (stage.remote_url === null || stage.remote_url.trim() === '') {
    updateStage(opId, stage.portable_id, {
      stage: 'unsupported',
      stage_reason: 'no-remote-url',
    });
    return;
  }
  const rejection = transportRejection(stage.remote_url, {
    fromSyncedDefinition: isDefinitionSynced(workspaceId),
  });
  if (rejection !== null) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: rejection,
    });
    return;
  }

  const requested = stage.destination;
  if (!requested) throw new Error('Missing requested destination in journal');
  const root = path.dirname(requested);

  // Containment: resolve the allowed root to its canonical path first.
  fs.mkdirSync(root, { recursive: true });
  const rootStat = lstatOrNull(root);
  if (!rootStat || !rootStat.isDirectory()) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'destination-root-not-directory',
    });
    return;
  }
  const rootReal = fs.realpathSync(root);
  assertChildOf(rootReal, path.join(rootReal, path.basename(requested)));

  // Disk space (best effort — statfs may be unavailable on some platforms).
  try {
    const stats = fs.statfsSync(rootReal);
    if (stats.bavail * stats.bsize < MIN_FREE_DISK_BYTES) {
      updateStage(opId, stage.portable_id, {
        stage: 'failed',
        stage_reason: 'insufficient-disk-space',
      });
      return;
    }
  } catch {
    /* statfs unavailable — continue without a free-space check */
  }

  const existingNames = dirEntryNamesLower(rootReal);
  const baseName = path.basename(requested);
  const opSuffix = opId.slice(0, 8);
  let destination: string | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name =
      attempt === 0
        ? baseName
        : attempt === 1
          ? `${baseName}-${opSuffix}`
          : `${baseName}-${opSuffix}-${attempt}`;
    const candidate = path.join(rootReal, name);
    const stat = lstatOrNull(candidate);
    // Never follow or clobber an existing entry (symlinks included), and
    // treat case-insensitive name matches as collisions.
    const collides =
      stat !== null ||
      existingNames.has(name.toLowerCase()) ||
      destinationLocks.has(candidate.toLowerCase());
    if (!collides) {
      destination = candidate;
      break;
    }
  }
  if (destination === null) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'destination-collision',
    });
    return;
  }

  destinationLocks.set(destination.toLowerCase(), opId);
  updateStage(opId, stage.portable_id, {
    stage: 'destination-reserved',
    destination,
    evidence: {
      reservedAt: nowIso(),
      canonicalDestination: destination,
      requestedDestination: requested,
    },
  });
}

/** clone-to-staging: clone into the operation-owned staging directory. */
async function stepCloneToStaging(opId: string, stage: StageRow): Promise<void> {
  const staging = stage.staging_path ?? stagingPathFor(opId, stage.portable_id);
  assertUnderRoot(stagingRoot(), staging);

  // Wipe any partial staging content (crash leftovers are op-owned).
  if (lstatOrNull(staging) !== null) rmrf(staging);
  fs.mkdirSync(path.dirname(staging), { recursive: true });

  const args = ['clone'];
  // A pinned commit wins over a floating ref: clone the default branch fully
  // so the commit stays reachable, then check it out in record-commit.
  if (stage.requested_commit === null && stage.requested_ref !== null) {
    args.push('--branch', stage.requested_ref);
  }
  args.push('--', stage.remote_url!, staging);

  const result = await gitResult(args);
  if (!result.ok || lstatOrNull(path.join(staging, '.git')) === null) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: classifyCloneFailure(`${result.stderr}\n${result.stdout}`),
      evidence: { cloneError: result.stderr.slice(0, 2_000) },
    });
    return;
  }
  updateStage(opId, stage.portable_id, {
    stage: 'cloned-to-staging',
    evidence: { clonedAt: nowIso() },
  });
}

/** verify-checkout: prove the staged clone is a real checkout + scan unsupported cases. */
async function stepVerifyCheckout(opId: string, stage: StageRow): Promise<void> {
  const staging = stage.staging_path ?? stagingPathFor(opId, stage.portable_id);
  assertUnderRoot(stagingRoot(), staging);

  const inside = await gitResult(['-C', staging, 'rev-parse', '--is-inside-work-tree']);
  const head = await gitResult(['-C', staging, 'rev-parse', 'HEAD']);
  if (!inside.ok || inside.stdout.trim() !== 'true' || !head.ok) {
    // Unverified partial clone: wipe and restart the clone stage.
    rmrf(staging);
    updateStage(opId, stage.portable_id, {
      stage: 'destination-reserved',
      evidence: { stagingWiped: 'unverified-partial-clone' },
    });
    return;
  }
  const headSha = head.stdout.trim();

  // Remote identity must match the journaled URL — a checkout pointing at a
  // different remote is not the repository the definition asked for.
  const origin = await gitResult(['-C', staging, 'remote', 'get-url', 'origin']);
  const journaledNorm = stage.remote_url !== null ? normalizeRemoteUrl(stage.remote_url) : null;
  const actualNorm = origin.ok ? normalizeRemoteUrl(origin.stdout.trim()) : null;
  if (journaledNorm !== null && actualNorm !== journaledNorm) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'remote-identity-mismatch',
      evidence: { expectedRemote: journaledNorm, actualRemote: actualNorm },
    });
    return;
  }

  const unsupported = await detectUnsupportedCheckout(staging);
  if (unsupported !== null) {
    updateStage(opId, stage.portable_id, {
      stage: 'unsupported',
      stage_reason: unsupported,
      evidence: { headSha, stagingRetained: staging },
    });
    return;
  }

  updateStage(opId, stage.portable_id, {
    stage: 'checkout-verified',
    evidence: {
      headSha,
      remoteUrl: origin.ok ? origin.stdout.trim() : null,
      unsupportedScan: { submodules: false, lfs: false, shallow: false },
    },
  });
}

/**
 * Detect unsupported cases before claiming readiness: submodules, LFS
 * pointers, and shallow history.
 */
async function detectUnsupportedCheckout(
  dir: string,
): Promise<'submodules' | 'lfs' | 'shallow' | null> {
  const shallow = await gitResult(['-C', dir, 'rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.stdout.trim() === 'true') return 'shallow';

  if (lstatOrNull(path.join(dir, '.gitmodules')) !== null) return 'submodules';

  // LFS: .gitattributes declaring filter=lfs, or a small pointer file.
  const attributes = path.join(dir, '.gitattributes');
  if (lstatOrNull(attributes) !== null) {
    try {
      if (fs.readFileSync(attributes, 'utf8').includes('filter=lfs')) return 'lfs';
    } catch {
      /* unreadable attributes — fall through to pointer scan */
    }
  }
  const listing = await gitResult(['-C', dir, 'ls-files']);
  if (listing.ok) {
    const files = listing.stdout.split('\n').filter(Boolean).slice(0, MAX_LFS_SCAN_FILES);
    for (const rel of files) {
      const filePath = path.join(dir, rel);
      const stat = lstatOrNull(filePath);
      if (stat === null || !stat.isFile() || stat.size === 0 || stat.size > 512) continue;
      try {
        const fd = fs.openSync(filePath, 'r');
        try {
          const buf = Buffer.alloc(128);
          const bytesRead = fs.readSync(fd, buf, 0, 128, 0);
          if (buf.subarray(0, bytesRead).toString('utf8').startsWith(LFS_POINTER_PREFIX)) {
            return 'lfs';
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        /* unreadable file — not an LFS pointer */
      }
    }
  }
  return null;
}

/** record-commit: resolve and record the exact checked-out commit id. */
async function stepRecordCommit(opId: string, stage: StageRow): Promise<void> {
  const staging = stage.staging_path ?? stagingPathFor(opId, stage.portable_id);
  assertUnderRoot(stagingRoot(), staging);

  if (stage.requested_commit !== null) {
    const resolved = await gitResult([
      '-C',
      staging,
      'rev-parse',
      '--verify',
      `${stage.requested_commit}^{commit}`,
    ]);
    const sha = resolved.ok ? resolved.stdout.trim() : null;
    if (
      sha === null ||
      !(sha === stage.requested_commit || sha.startsWith(stage.requested_commit))
    ) {
      updateStage(opId, stage.portable_id, {
        stage: 'failed',
        stage_reason: 'pin-miss',
      });
      return;
    }
    const checkout = await gitResult(['-C', staging, 'checkout', '--detach', sha]);
    if (!checkout.ok) {
      updateStage(opId, stage.portable_id, {
        stage: 'failed',
        stage_reason: 'pin-miss',
      });
      return;
    }
    updateStage(opId, stage.portable_id, {
      stage: 'commit-recorded',
      resolved_commit: sha,
      evidence: { resolvedCommit: sha, pinned: true },
    });
    return;
  }

  const head = await gitResult(['-C', staging, 'rev-parse', 'HEAD']);
  if (!head.ok) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'unresolved-head',
    });
    return;
  }
  updateStage(opId, stage.portable_id, {
    stage: 'commit-recorded',
    resolved_commit: head.stdout.trim(),
    evidence: { resolvedCommit: head.stdout.trim(), pinned: false },
  });
}

/**
 * publish-mapping: journal the move, rename staging into the reserved
 * destination, register the repos row, then publish mapped_repo_id.
 */
async function stepPublishMapping(
  opId: string,
  workspaceId: string,
  stage: StageRow,
): Promise<void> {
  const staging = stage.staging_path ?? stagingPathFor(opId, stage.portable_id);
  const destination = stage.destination;
  if (!destination) throw new Error('Missing reserved destination in journal');
  assertUnderRoot(stagingRoot(), staging);

  const stagingExists = lstatOrNull(staging) !== null;
  const destinationExists = lstatOrNull(destination) !== null;
  const evidence = parseEvidence(stage.evidence_json);
  const moveWasJournaled =
    typeof evidence.publish === 'object' &&
    evidence.publish !== null &&
    (evidence.publish as { to?: unknown }).to === destination;

  if (!stagingExists && !destinationExists) {
    // Crash lost the staging clone entirely — restart from the clone stage.
    updateStage(opId, stage.portable_id, {
      stage: 'destination-reserved',
      evidence: { stagingWiped: 'lost-before-publish' },
    });
    return;
  }

  if (!stagingExists && destinationExists && !moveWasJournaled) {
    // A foreign directory occupies the destination — never infer ownership.
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'destination-claimed',
    });
    destinationLocks.delete(destination.toLowerCase());
    return;
  }

  if (stagingExists) {
    if (destinationExists && !moveWasJournaled) {
      // Something claimed the destination between reserve and publish.
      updateStage(opId, stage.portable_id, {
        stage: 'failed',
        stage_reason: 'destination-claimed',
      });
      destinationLocks.delete(destination.toLowerCase());
      return;
    }
    if (!destinationExists) {
      // Record the pending move in the journal BEFORE touching the fs.
      updateStage(opId, stage.portable_id, {
        evidence: { publish: { from: staging, to: destination, at: nowIso() } },
      });
      moveDir(staging, destination);
      // Drop the op's staging dir when this was the last repo staged in it.
      try {
        fs.rmdirSync(path.dirname(staging));
      } catch {
        /* not empty — other repos still staging */
      }
    }
  }

  // The checkout is at its destination (just moved, or moved before a crash).
  // Re-verify remote identity before publishing the mapping.
  const origin = await gitResult(['-C', destination, 'remote', 'get-url', 'origin']);
  const journaledNorm = stage.remote_url !== null ? normalizeRemoteUrl(stage.remote_url) : null;
  const actualNorm = origin.ok ? normalizeRemoteUrl(origin.stdout.trim()) : null;
  if (journaledNorm !== null && actualNorm !== journaledNorm) {
    updateStage(opId, stage.portable_id, {
      stage: 'failed',
      stage_reason: 'remote-identity-mismatch',
      evidence: { expectedRemote: journaledNorm, actualRemote: actualNorm },
    });
    return;
  }

  const realDestination = fs.realpathSync(destination);
  const info = await connectRepoPath(realDestination);
  updateStage(opId, stage.portable_id, {
    repo_id: info.id,
    evidence: { publishedRepoId: info.id, publishedPath: realDestination },
  });
  mapWorkspaceRepoToCheckout(workspaceId, stage.portable_id, info.id);
  updateStage(opId, stage.portable_id, { stage: 'mapping-published' });
  destinationLocks.delete(destination.toLowerCase());
}

// ---------------------------------------------------------------------------
// Public API: link
// ---------------------------------------------------------------------------

/**
 * Map an existing local checkout to a portable definition entry. Locally
 * initiated; verifies the path is a git repo and its remote matches the
 * definition (divergence is recorded for review, not silently mapped).
 */
export async function linkWorkspaceRepo(
  workspaceId: string,
  portableId: string,
  checkoutPath: string,
  options: { allowRemoteDivergence?: boolean } = {},
): Promise<WorkspaceLinkResult> {
  if (typeof portableId !== 'string' || portableId === '') {
    throw new Error('portableId is required');
  }
  if (typeof checkoutPath !== 'string' || checkoutPath === '') {
    throw new Error('checkoutPath is required');
  }
  const definitionRevision = loadWorkspaceRevision(workspaceId);
  const def = loadDefinition(workspaceId, portableId);
  if (!def) throw new Error(`Repo definition not found: ${portableId}`);

  const resolvedPath = realpathOrSelf(checkoutPath);
  const requestPayload = {
    portableId,
    checkoutPath: resolvedPath,
    allowRemoteDivergence: options.allowRemoteDivergence === true,
  };
  const key = requestKey('link', workspaceId, requestPayload);
  const db = getDb();

  const attach = db
    .prepare(
      `SELECT * FROM workspace_materialization_ops
       WHERE request_key = ? AND state IN ('running', 'completed', 'awaiting-review')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(key) as OpRow | undefined;
  if (attach) {
    if (attach.state !== 'running') return linkResultFromOp(attach);
    await attachToRunningOp(attach);
    return linkResultFromOp(readOp(attach.id)!);
  }

  assertNoRunningConflict(
    workspaceId,
    new Set([portableId]),
    new Set([resolvedPath.toLowerCase()]),
  );

  const opId = randomUUID();
  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO workspace_materialization_ops
           (id, workspace_id, kind, definition_revision, request_key, request_json,
            state, created_at, updated_at)
         VALUES (?, ?, 'link', ?, ?, ?, 'running', ?, ?)`,
      ).run(opId, workspaceId, definitionRevision, key, JSON.stringify(requestPayload), now, now);
      db.prepare(
        `INSERT INTO workspace_materialization_repo_stages
           (op_id, portable_id, remote_url, destination, ownership_intent, stage,
            evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'linked', 'pending', '{}', ?, ?)`,
      ).run(opId, portableId, def.remote_url, resolvedPath, now, now);
    })();
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) {
      throw new MaterializationConflictError(
        'A materialisation operation already covers this destination',
      );
    }
    throw err;
  }

  const run = (async () => {
    await runLinkStage(opId, workspaceId, portableId, options.allowRemoteDivergence === true);
    finishOp(opId);
    recomputeWorkspaceDefinitionState(workspaceId);
  })();
  runningOps.set(opId, run);
  try {
    await run;
  } finally {
    runningOps.delete(opId);
  }
  return linkResultFromOp(readOp(opId)!);
}

async function runLinkStage(
  opId: string,
  workspaceId: string,
  portableId: string,
  allowDivergence: boolean,
): Promise<void> {
  const stage = readStage(opId, portableId);
  if (!stage || isTerminalStage(stage.stage)) return;
  const checkoutPath = stage.destination!;
  destinationLocks.set(checkoutPath.toLowerCase(), opId);

  try {
    const stat = lstatOrNull(checkoutPath);
    const inside =
      stat !== null && stat.isDirectory()
        ? await gitResult(['-C', checkoutPath, 'rev-parse', '--is-inside-work-tree'])
        : null;
    if (inside === null || !inside.ok || inside.stdout.trim() !== 'true') {
      updateStage(opId, portableId, {
        stage: 'failed',
        stage_reason: 'not-a-git-repo',
        evidence: { checkoutPath },
      });
      return;
    }

    const origin = await gitResult(['-C', checkoutPath, 'remote', 'get-url', 'origin']);
    const actual = origin.ok ? normalizeRemoteUrl(origin.stdout.trim()) : null;
    const expected = stage.remote_url !== null ? normalizeRemoteUrl(stage.remote_url) : null;
    if (expected !== actual && !allowDivergence) {
      updateStage(opId, portableId, {
        stage: 'failed',
        stage_reason: 'remote-divergence',
        evidence: { expectedRemote: expected, actualRemote: actual },
      });
      return;
    }

    const info = await connectRepoPath(checkoutPath);
    updateStage(opId, portableId, {
      repo_id: info.id,
      evidence: {
        expectedRemote: expected,
        actualRemote: actual,
        divergenceAccepted: allowDivergence && expected !== actual,
      },
    });
    mapWorkspaceRepoToCheckout(workspaceId, portableId, info.id);
    updateStage(opId, portableId, { stage: 'mapping-published' });
  } catch (err) {
    updateStage(opId, portableId, {
      stage: 'failed',
      stage_reason: 'internal-error',
      evidence: { error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    destinationLocks.delete(checkoutPath.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Public API: safe removal
// ---------------------------------------------------------------------------

/**
 * Default removal detaches the mapping only — files are never deleted.
 * `deleteCheckout: true` additionally quarantines the checkout, but only when
 * the journal proves Anvil created it and the checkout passes the safety
 * checks (no active attempts, no other workspace references, clean tree, no
 * unpublished commits).
 */
export async function removeWorkspaceCheckout(
  workspaceId: string,
  portableId: string,
  options: { deleteCheckout?: boolean } = {},
): Promise<WorkspaceRemoveCheckoutResult> {
  if (typeof portableId !== 'string' || portableId === '') {
    throw new Error('portableId is required');
  }
  const definitionRevision = loadWorkspaceRevision(workspaceId);
  const def = loadDefinition(workspaceId, portableId);
  if (!def) throw new Error(`Repo definition not found: ${portableId}`);
  if (def.mapped_repo_id === null) return { status: 'not-mapped' };

  const db = getDb();
  const repo = db.prepare('SELECT id, path FROM repos WHERE id = ?').get(def.mapped_repo_id) as
    | { id: string; path: string }
    | undefined;
  if (!repo) {
    // Mapping points at a repos row that no longer exists — detach only.
    db.prepare(
      `UPDATE workspace_repo_definitions SET mapped_repo_id = NULL, updated_at = datetime('now')
       WHERE workspace_id = ? AND portable_id = ?`,
    ).run(workspaceId, portableId);
    recomputeWorkspaceDefinitionState(workspaceId);
    return { status: 'detached' };
  }

  const checkoutPath = realpathOrSelf(repo.path);
  const ownership = journalProvenOwnership(repo.id, checkoutPath);
  const requestPayload = {
    portableId,
    repoId: repo.id,
    checkoutPath,
    deleteCheckout: options.deleteCheckout === true,
  };
  const key = requestKey('remove', workspaceId, requestPayload);

  const attach = db
    .prepare(
      `SELECT * FROM workspace_materialization_ops
       WHERE request_key = ? AND state IN ('running', 'completed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(key) as OpRow | undefined;
  if (attach) {
    if (attach.state === 'completed') return removeResultFromOp(attach);
    await attachToRunningOp(attach);
    return removeResultFromOp(readOp(attach.id)!);
  }

  assertNoRunningConflict(
    workspaceId,
    new Set([portableId]),
    new Set([checkoutPath.toLowerCase()]),
  );

  const opId = randomUUID();
  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO workspace_materialization_ops
           (id, workspace_id, kind, definition_revision, request_key, request_json,
            state, created_at, updated_at)
         VALUES (?, ?, 'remove', ?, ?, ?, 'running', ?, ?)`,
      ).run(opId, workspaceId, definitionRevision, key, JSON.stringify(requestPayload), now, now);
      db.prepare(
        `INSERT INTO workspace_materialization_repo_stages
           (op_id, portable_id, destination, repo_id, ownership_intent, stage,
            evidence_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', '{}', ?, ?)`,
      ).run(opId, portableId, checkoutPath, repo.id, ownership, now, now);
    })();
  } catch (err) {
    if (err instanceof Error && /unique/i.test(err.message)) {
      throw new MaterializationConflictError(
        'A materialisation operation already covers this destination',
      );
    }
    throw err;
  }

  const run = (async () => {
    await runRemoveStage(opId, workspaceId, portableId, options.deleteCheckout === true);
    finishOp(opId);
    recomputeWorkspaceDefinitionState(workspaceId);
  })();
  runningOps.set(opId, run);
  try {
    await run;
  } finally {
    runningOps.delete(opId);
  }
  return removeResultFromOp(readOp(opId)!);
}

/** Journal proof that Anvil created this checkout (spec §7 safe removal). */
function journalProvenOwnership(repoId: string, checkoutPath: string): 'anvil-created' | 'linked' {
  const row = getDb()
    .prepare(
      `SELECT s.op_id FROM workspace_materialization_repo_stages s
       JOIN workspace_materialization_ops o ON o.id = s.op_id
       WHERE o.kind = 'clone' AND s.repo_id = ? AND s.destination = ?
         AND s.ownership_intent = 'anvil-created' AND s.stage = 'mapping-published'
       LIMIT 1`,
    )
    .get(repoId, checkoutPath) as { op_id: string } | undefined;
  return row !== undefined ? 'anvil-created' : 'linked';
}

interface RemovalChecks {
  ownership: 'anvil-created' | 'linked';
  activeAttempts: number;
  otherReferences: number;
  dirty: boolean;
  unpublishedCommits: boolean;
}

async function collectRemovalChecks(workspaceId: string, stage: StageRow): Promise<RemovalChecks> {
  const db = getDb();
  const checkoutPath = stage.destination!;
  const repoId = stage.repo_id!;

  const activeAttempts = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM mesh_attempts
         WHERE state IN (${ACTIVE_ATTEMPT_STATES.map(() => '?').join(', ')})
           AND (instr(manifest_json, ?) > 0 OR instr(manifest_json, ?) > 0
                OR instr(manifest_json, ?) > 0)`,
      )
      .get(...ACTIVE_ATTEMPT_STATES, repoId, stage.portable_id, checkoutPath) as {
      count: number;
    }
  ).count;

  const otherRefs = (
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM workspace_repo_definitions
             WHERE mapped_repo_id = ? AND workspace_id != ?) +
           (SELECT COUNT(*) FROM workspace_repos
             WHERE repo_id = ? AND workspace_id != ?) AS count`,
      )
      .get(repoId, workspaceId, repoId, workspaceId) as { count: number }
  ).count;

  const status = await gitResult(['-C', checkoutPath, 'status', '--porcelain']);
  const dirty = !status.ok || status.stdout.trim() !== '';

  // Unpublished commits: a missing upstream means published state is
  // unprovable — refuse per spec §7.
  let unpublished = true;
  const upstream = await gitResult([
    '-C',
    checkoutPath,
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  if (upstream.ok && upstream.stdout.trim() !== '') {
    const ahead = await gitResult(['-C', checkoutPath, 'rev-list', '--count', '@{u}..HEAD']);
    unpublished = !ahead.ok || ahead.stdout.trim() !== '0';
  }

  return {
    ownership: stage.ownership_intent,
    activeAttempts,
    otherReferences: otherRefs,
    dirty,
    unpublishedCommits: unpublished,
  };
}

function removalRefusals(checks: RemovalChecks): string[] {
  const refusals: string[] = [];
  if (checks.ownership !== 'anvil-created') refusals.push('not-anvil-created');
  if (checks.activeAttempts > 0) refusals.push('active-attempt');
  if (checks.otherReferences > 0) refusals.push('other-workspace-references');
  if (checks.dirty) refusals.push('checkout-dirty');
  if (checks.unpublishedCommits) refusals.push('unpublished-commits');
  return refusals;
}

async function runRemoveStage(
  opId: string,
  workspaceId: string,
  portableId: string,
  deleteCheckout: boolean,
): Promise<void> {
  const db = getDb();
  const stage = readStage(opId, portableId);
  if (!stage || isTerminalStage(stage.stage)) return;

  try {
    // Phase 1: for a delete request, record safety checks before detach.
    if (deleteCheckout && stage.stage === 'pending') {
      const checks = await collectRemovalChecks(workspaceId, stage);
      const refusals = removalRefusals(checks);
      if (refusals.length > 0) {
        updateStage(opId, portableId, {
          stage: 'failed',
          stage_reason: 'refused',
          evidence: { checks: { ...checks }, refusals },
        });
        return;
      }
      updateStage(opId, portableId, {
        stage: 'checks-recorded',
        evidence: { checks: { ...checks } },
      });
    }

    // Phase 2: detach the mapping. Membership in workspace_repos stays —
    // removing it would let materializeRepoDefinitions resurrect the
    // checkout under a fresh portable id on the next membership mutation.
    db.prepare(
      `UPDATE workspace_repo_definitions SET mapped_repo_id = NULL, updated_at = datetime('now')
       WHERE workspace_id = ? AND portable_id = ?`,
    ).run(workspaceId, portableId);
    recomputeWorkspaceDefinitionState(workspaceId);

    if (!deleteCheckout) {
      updateStage(opId, portableId, { stage: 'detached' });
      return;
    }

    // Phase 3: quarantine move. The quarantine target is journaled BEFORE
    // the rename and reused verbatim on resume.
    let evidence = parseEvidence(readStage(opId, portableId)!.evidence_json);
    if (evidence.quarantine === undefined) {
      let quarantineId = `${opId}--${portableId}`;
      let quarantinePath = path.join(quarantineRoot(), quarantineId);
      for (let i = 1; lstatOrNull(quarantinePath) !== null && i < 50; i += 1) {
        quarantineId = `${opId}--${portableId}--${i}`;
        quarantinePath = path.join(quarantineRoot(), quarantineId);
      }
      updateStage(opId, portableId, {
        evidence: {
          quarantine: { from: stage.destination, to: quarantinePath, quarantineId },
        },
      });
      evidence = parseEvidence(readStage(opId, portableId)!.evidence_json);
    }
    const move = evidence.quarantine as { from: string; to: string; quarantineId: string };
    assertUnderRoot(quarantineRoot(), move.to);

    const fromExists = lstatOrNull(move.from) !== null;
    const toExists = lstatOrNull(move.to) !== null;
    if (fromExists && toExists) {
      // A partial copy-style fallback may have left both — restart the move.
      rmrf(move.to);
      moveDir(move.from, move.to);
    } else if (fromExists && !toExists) {
      fs.mkdirSync(quarantineRoot(), { recursive: true });
      moveDir(move.from, move.to);
    } else if (!fromExists && !toExists) {
      updateStage(opId, portableId, {
        evidence: { quarantineNote: 'checkout already absent at resume' },
      });
    }
    // (!fromExists && toExists) → the journaled move completed pre-crash.

    // Point the repos row at the quarantined location so adoption history
    // stays consistent while the checkout remains recoverable.
    if (lstatOrNull(move.to) !== null) {
      db.prepare("UPDATE repos SET path = ?, updated_at = datetime('now') WHERE id = ?").run(
        move.to,
        stage.repo_id,
      );
    }
    updateStage(opId, portableId, { stage: 'quarantined' });
  } catch (err) {
    updateStage(opId, portableId, {
      stage: 'failed',
      stage_reason: 'internal-error',
      evidence: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Second explicit irreversible step: purge a quarantined checkout. Only
 * paths the journal recorded as quarantined under the quarantine root are
 * eligible — never an arbitrary path.
 */
export async function purgeQuarantinedCheckout(quarantineId: string): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*, o.workspace_id FROM workspace_materialization_repo_stages s
       JOIN workspace_materialization_ops o ON o.id = s.op_id
       WHERE s.stage = 'quarantined'`,
    )
    .all() as Array<StageRow & { workspace_id: string }>;

  for (const row of rows) {
    const evidence = parseEvidence(row.evidence_json) as {
      quarantine?: { to: string; quarantineId: string };
      purgedAt?: string;
    };
    if (evidence.quarantine?.quarantineId !== quarantineId) continue;
    if (evidence.purgedAt !== undefined) return;

    fs.mkdirSync(quarantineRoot(), { recursive: true });
    const rootReal = fs.realpathSync(quarantineRoot());
    const target = path.join(rootReal, path.basename(evidence.quarantine.to));
    assertChildOf(rootReal, target);
    if (lstatOrNull(target) !== null) {
      rmrf(target);
    }
    updateStage(row.op_id, row.portable_id, {
      evidence: { purgedAt: nowIso() },
    });
    // The checkout no longer exists anywhere — mark the repos row stale.
    db.prepare("UPDATE repos SET status = 'error', updated_at = datetime('now') WHERE id = ?").run(
      row.repo_id,
    );
    recomputeWorkspaceDefinitionState(row.workspace_id);
    return;
  }
  throw new Error(`No quarantined checkout recorded for id: ${quarantineId}`);
}

// ---------------------------------------------------------------------------
// Crash recovery (spec §7: journal + operation-owned fs state only)
// ---------------------------------------------------------------------------

async function resumeOp(op: OpRow): Promise<void> {
  const stages = readStages(op.id);
  for (const stage of stages) {
    if (isTerminalStage(stage.stage)) continue;
    try {
      if (op.kind === 'clone') {
        await runCloneStages(op.id, op.workspace_id, stage.portable_id, /* isResume */ true);
      } else if (op.kind === 'link') {
        const req = JSON.parse(op.request_json) as { allowRemoteDivergence?: boolean };
        await runLinkStage(
          op.id,
          op.workspace_id,
          stage.portable_id,
          req.allowRemoteDivergence === true,
        );
      } else {
        const req = JSON.parse(op.request_json) as { deleteCheckout?: boolean };
        await runRemoveStage(
          op.id,
          op.workspace_id,
          stage.portable_id,
          req.deleteCheckout === true,
        );
      }
    } catch (err) {
      updateStage(op.id, stage.portable_id, {
        stage: 'failed',
        stage_reason: 'recovery-error',
        evidence: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  finishOp(op.id);
  recomputeWorkspaceDefinitionState(op.workspace_id);
}

/**
 * Boot-time recovery: resume operations still marked 'running' in the
 * journal. Only stages proven safe continue — unverified partial clones are
 * wiped and restarted, verified staging clones are moved into place, and
 * journaled-but-unmoved quarantines finish their rename.
 */
export async function recoverWorkspaceMaterializations(): Promise<void> {
  const running = getDb()
    .prepare(
      `SELECT * FROM workspace_materialization_ops WHERE state = 'running' ORDER BY created_at`,
    )
    .all() as OpRow[];
  for (const op of running) {
    if (runningOps.has(op.id)) continue;
    const resumed = resumeOp(op);
    runningOps.set(op.id, resumed);
    try {
      await resumed;
    } finally {
      runningOps.delete(op.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Result mapping + op listing
// ---------------------------------------------------------------------------

function stageToResult(s: StageRow): WorkspaceMaterializationRepoResult {
  return {
    portableId: s.portable_id,
    stage: s.stage,
    reason: s.stage_reason ?? undefined,
    destination: s.destination ?? undefined,
    resolvedCommit: s.resolved_commit ?? undefined,
    repoId: s.repo_id ?? undefined,
  };
}

function cloneResultFromOp(op: OpRow): WorkspaceCloneResult {
  const stages = readStages(op.id);
  const published = stages.filter((s) => s.stage === 'mapping-published').length;
  const status =
    stages.length === 0 || published === stages.length
      ? 'completed'
      : published > 0
        ? 'partial'
        : op.state === 'running'
          ? 'running'
          : 'failed';
  return { opId: op.id, status, repos: stages.map(stageToResult) };
}

function linkResultFromOp(op: OpRow): WorkspaceLinkResult {
  const stage = readStages(op.id)[0];
  if (!stage) return { opId: op.id, status: 'failed', error: 'missing stage row' };
  const evidence = parseEvidence(stage.evidence_json);
  if (stage.stage === 'mapping-published') {
    return { opId: op.id, status: 'linked', repoId: stage.repo_id ?? undefined };
  }
  if (stage.stage_reason === 'remote-divergence') {
    return {
      opId: op.id,
      status: 'divergence',
      expectedRemoteUrl:
        typeof evidence.expectedRemote === 'string' ? evidence.expectedRemote : undefined,
      actualRemoteUrl:
        typeof evidence.actualRemote === 'string' ? evidence.actualRemote : undefined,
    };
  }
  return {
    opId: op.id,
    status: 'failed',
    error: stage.stage_reason ?? 'link-failed',
  };
}

function removeResultFromOp(op: OpRow): WorkspaceRemoveCheckoutResult {
  const stage = readStages(op.id)[0];
  if (!stage) return { opId: op.id, status: 'detached' };
  if (stage.stage === 'quarantined') {
    const evidence = parseEvidence(stage.evidence_json) as {
      quarantine?: { quarantineId?: string; to?: string };
    };
    return {
      opId: op.id,
      status: 'quarantined',
      quarantineId: evidence.quarantine?.quarantineId,
      quarantinePath: evidence.quarantine?.to,
    };
  }
  if (stage.stage === 'detached') return { opId: op.id, status: 'detached' };
  if (stage.stage_reason === 'refused') {
    const evidence = parseEvidence(stage.evidence_json) as { refusals?: string[] };
    return { opId: op.id, status: 'refused', refusals: evidence.refusals ?? [] };
  }
  return { opId: op.id, status: 'refused', refusals: [stage.stage_reason ?? 'remove-failed'] };
}

/** Journal listing for review/UI surfaces (WS-03 consumes this). */
export function listWorkspaceMaterializationOps(
  workspaceId: string,
): WorkspaceMaterializationOpSummary[] {
  const ops = getDb()
    .prepare(
      `SELECT * FROM workspace_materialization_ops WHERE workspace_id = ?
       ORDER BY created_at DESC`,
    )
    .all(workspaceId) as OpRow[];
  return ops.map((op) => ({
    id: op.id,
    workspaceId: op.workspace_id,
    kind: op.kind,
    state: op.state,
    error: op.error ?? undefined,
    createdAt: op.created_at,
    updatedAt: op.updated_at,
    repos: readStages(op.id).map(stageToResult),
  }));
}
