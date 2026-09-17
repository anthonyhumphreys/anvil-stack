/**
 * Step-5 two-profile workflow acceptance gate.
 *
 * Two isolated desktop profiles — each with its own `userDataDir`, encrypted
 * session file, and file-backed SQLite — converge through the REAL backend
 * worker over real HTTP. Enrollment uses production feature paths only
 * (enrollment codes; no spike auth, no injected RPC).
 *
 * Prerequisites:
 *   cd cloud/backend && pnpm dev            # wrangler dev --env dev on :8787
 *   ANVIL_BACKEND_URL=http://127.0.0.1:8787 pnpm vitest run \
 *     src/main/services/__tests__/sync-two-profile.acceptance.test.ts
 *
 * The suite skips when no worker is reachable so `pnpm test` stays green on
 * machines without a running backend.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import type { WorkflowNode } from '../../../shared/types';
import { SPIKE_DATASET_EPOCH } from '../../../shared/sync-runtime';
import { type SyncScope } from '../../../shared/sync-mesh';
import type { BackendDescriptor } from '../../../../cloud/contract/discovery';

const BACKEND_URL = (process.env.ANVIL_BACKEND_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN_TOKEN = process.env.ANVIL_ADMIN_TOKEN ?? 'dev-admin-token';

const backendReachable = await fetch(`${BACKEND_URL}/.well-known/anvil-backend`)
  .then((r) => r.ok)
  .catch(() => false);

let activeDb: Database.Database;

vi.mock('../../db/database.js', () => ({ getDb: () => activeDb }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf-8').slice('enc:'.length),
  },
}));

import {
  beginDataExport,
  bindLocalEntities,
  enableSync,
  enrollWithEnrollmentCode,
  getRuntimeStatus,
  initSyncRuntime,
  issueEnrollmentCode,
  listDevices,
  pageDataExport,
  renameDevice,
  requestSync,
  resetSyncRuntimeForTests,
  revokeDevice,
  setMeshWorkerOptIn,
  signOutSync,
} from '../sync-runtime.service';
import { initiateHandoff } from '../mesh-handoff.service';
import { unsealScopedJson } from '../sync-keyring.service';
import { isSealedCheckpoint } from '../../../../cloud/contract/handoff';
import type { SessionCheckpoint } from '../../../../cloud/contract/handoff';
import { readSessionOwnership, writeSessionOwnership } from '../mesh-ownership.service';
import {
  buildDevicePolicy,
  createDiagnosticJob,
  createPrepareWorkspaceJob,
  decideMeshApproval,
  getMeshJob,
  listMeshApprovals,
} from '../mesh-worker.service';
import { recordBootstrapApproval } from '../bootstrap-policy.service';
import { observeAttempt, type AttemptActivity } from '../mesh-observe.service';
import { downloadMeshArtifact, listMeshArtifacts } from '../mesh-artifact.service';
import { pinBackend } from '../sync-backend.service';
import { saveWorkflowTemplate } from '../workflow.service';
import type { SyncRuntimeStatus } from '../../../shared/sync-runtime';

interface Profile {
  dir: string;
  dbPath: string;
  db: Database.Database;
}

function openProfile(name: string): Profile {
  resetSyncRuntimeForTests();
  const dir = mkdtempSync(join(tmpdir(), `anvil-profile-${name}-`));
  const dbPath = join(dir, 'anvil.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  activeDb = db;
  initSyncRuntime(dir);
  return { dir, dbPath, db };
}

function reopenProfile(profile: Profile): Profile {
  profile.db.close();
  resetSyncRuntimeForTests();
  const db = new Database(profile.dbPath);
  activeDb = db;
  initSyncRuntime(profile.dir);
  return { ...profile, db };
}

let cachedDescriptor: BackendDescriptor | undefined;
async function backendDescriptor(): Promise<BackendDescriptor> {
  cachedDescriptor ??= (await (
    await fetch(`${BACKEND_URL}/.well-known/anvil-backend`)
  ).json()) as BackendDescriptor;
  return cachedDescriptor;
}

async function mintCode(accountId: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/v1/enrollment-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ accountId }),
  });
  if (!res.ok) {
    throw new Error(`admin enrollment-code issuance failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { code: string }).code;
}

async function enrollProfile(profile: Profile, code: string): Promise<SyncRuntimeStatus> {
  pinBackend({ baseUrl: BACKEND_URL, descriptor: await backendDescriptor() });
  const snapshot = await enrollWithEnrollmentCode(code);
  expect(snapshot.state).toBe('signed-in');
  const status = enableSync();
  expect(status.syncEnabled).toBe(true);
  expect(status.auth.accountId).toBe(snapshot.accountId);
  return status;
}

function scopeFor(status: SyncRuntimeStatus, deploymentId: string): SyncScope {
  const accountId = status.auth.accountId;
  if (accountId === null) throw new Error('profile must be signed in');
  return { backendId: deploymentId, accountId, datasetEpoch: SPIKE_DATASET_EPOCH };
}

function node(id: string): WorkflowNode {
  return {
    id,
    name: id,
    prompt: `Run ${id}`,
    personaId: 'coder',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    executionStrategy: 'adaptive',
    position: { x: 0, y: 0 },
  };
}

const openProfiles: Profile[] = [];
afterEach(() => {
  resetSyncRuntimeForTests();
});

describe.skipIf(!backendReachable)('two-profile acceptance gate (real worker)', () => {
  it(
    'create/update/delete converge across profiles over real auth + HTTP',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}`;
      const descriptor = await backendDescriptor();

      // ---- Profile A: enroll through a real admin-minted code, create, push.
      const a = openProfile('a');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aScope = scopeFor(aStatus, descriptor.deploymentId);
      const template = saveWorkflowTemplate({
        name: 'gate-workflow',
        description: 'created on profile A',
        nodes: [node('n1')],
        edges: [],
        orchestration: DEFAULT_ORCHESTRATION,
      });
      bindLocalEntities(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      // ---- Profile A issues a real pairing code for profile B.
      const pairing = await issueEnrollmentCode();
      expect(pairing.accountId).toBe(accountId);

      // ---- Profile B: isolated dir + SQLite, redeems the code, scans, sees A's row.
      const b = openProfile('b');
      openProfiles.push(b);
      const bStatus = await enrollProfile(b, pairing.code);
      expect(bStatus.auth.accountId).toBe(accountId);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const bCopy = b.db
        .prepare('SELECT id, name, description FROM workflow_templates WHERE id = ?')
        .get(template.id) as { name: string; description: string } | undefined;
      expect(bCopy?.name).toBe('gate-workflow');
      expect(bCopy?.description).toBe('created on profile A');

      // ---- B updates the workflow; A converges after a pull.
      saveWorkflowTemplate(
        {
          name: 'gate-workflow-v2',
          description: 'renamed on profile B',
          nodes: [node('n1'), node('n2')],
          edges: [],
          orchestration: DEFAULT_ORCHESTRATION,
        },
        template.id,
      );
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      // ---- A "restarts": close SQLite, re-init from the same userDataDir.
      // The encrypted session reloads; no re-enrollment happens.
      const restarted = reopenProfile(a);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const aCopy = restarted.db
        .prepare('SELECT name, description FROM workflow_templates WHERE id = ?')
        .get(template.id) as { name: string; description: string } | undefined;
      expect(aCopy?.name).toBe('gate-workflow-v2');
      expect(aCopy?.description).toBe('renamed on profile B');

      // ---- A deletes; B converges on the tombstone.
      const { deleteWorkflowTemplate } = await import('../workflow.service');
      deleteWorkflowTemplate(template.id);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      const b2 = reopenProfile(b);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const bGone = b2.db
        .prepare('SELECT id FROM workflow_templates WHERE id = ?')
        .get(template.id);
      expect(bGone).toBeUndefined();

      // ---- Sign-out revokes the device session remotely: the same access
      // token can no longer reach the account, and profile A signs out cleanly.
      await signOutSync();
      expect(getRuntimeStatus().auth.state).toBe('signed-out');
    },
  );

  it(
    'rejects replay of a used enrollment code and revoked session tokens',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-reuse`;
      const code = await mintCode(accountId);

      const a = openProfile('a-reuse');
      openProfiles.push(a);
      await enrollProfile(a, code);

      // The same code on a second profile must be rejected by the real worker.
      const b = openProfile('b-reuse');
      openProfiles.push(b);
      pinBackend({ baseUrl: BACKEND_URL, descriptor: await backendDescriptor() });
      await expect(enrollWithEnrollmentCode(code)).rejects.toThrow();
      expect(getRuntimeStatus().auth.state).not.toBe('signed-in');

      // A's session still works; sign-out revokes it remotely.
      openProfiles[openProfiles.length - 2] = reopenProfile(a);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      await signOutSync();
      expect(getRuntimeStatus().auth.state).toBe('signed-out');
    },
  );

  it(
    'restores the full account dataset onto a wiped device (OPS-01 restore drill)',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-restore`;
      const descriptor = await backendDescriptor();

      // ---- Profile A: enroll, create two workflows, push both.
      const a = openProfile('a-restore');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aScope = scopeFor(aStatus, descriptor.deploymentId);
      const first = saveWorkflowTemplate({
        name: 'restore-alpha',
        nodes: [node('r1')],
        edges: [],
        orchestration: DEFAULT_ORCHESTRATION,
      });
      const second = saveWorkflowTemplate({
        name: 'restore-beta',
        nodes: [node('r2'), node('r3')],
        edges: [],
        orchestration: DEFAULT_ORCHESTRATION,
      });
      bindLocalEntities(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      // ---- Pairing code issued through the production path on A.
      const pairing = await issueEnrollmentCode();
      expect(pairing.accountId).toBe(accountId);

      // ---- Profile C: a completely fresh device — new userDataDir, new
      // SQLite, no prior cursors or bindings. Redeeming the code and running
      // one cycle must materialize the account's entire dataset.
      const c = openProfile('c-restore');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      expect(cStatus.auth.accountId).toBe(accountId);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      expect(getRuntimeStatus().pendingCount).toBe(0);

      const rows = c.db
        .prepare(
          `SELECT id, name FROM workflow_templates WHERE id IN ('${first.id}', '${second.id}') ORDER BY name`,
        )
        .all() as Array<{ id: string; name: string }>;
      expect(rows).toEqual([
        { id: first.id, name: 'restore-alpha' },
        { id: second.id, name: 'restore-beta' },
      ]);
      const bindings = c.db
        .prepare(
          `SELECT entity_id FROM sync_bindings WHERE entity_id IN ('${first.id}', '${second.id}')`,
        )
        .all() as Array<{ entity_id: string }>;
      expect(bindings).toHaveLength(2);
      await signOutSync();
    },
  );

  it(
    'runs a diagnostic job end-to-end across profiles (MESH-02)',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-mesh`;
      const descriptor = await backendDescriptor();

      // ---- Profile A: enroll. Worker profile C is created first so its
      // enrollment id exists to target.
      const a = openProfile('a-mesh');
      openProfiles.push(a);
      await enrollProfile(a, await mintCode(accountId));
      const pairing = await issueEnrollmentCode();
      expect(pairing.accountId).toBe(accountId);

      // ---- Profile C: enroll, opt in as a worker (policy publish + leased
      // incarnation + capabilities over the real worker RPC surface).
      const c = openProfile('c-mesh');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      expect(cStatus.auth.accountId).toBe(accountId);
      const cEnrollmentId = cStatus.auth.enrollmentId;
      expect(cEnrollmentId).not.toBeNull();
      const worker = await setMeshWorkerOptIn(true);
      expect(worker.enabled).toBe(true);
      expect(worker.connected).toBe(true);
      expect(worker.workerIncarnation).not.toBeNull();

      // ---- Back on A: create the diagnostic job targeted at C. Idempotent
      // by requestId + payload hash.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const job = await createDiagnosticJob({
        requestId: `diag-${Date.now()}`,
        targetEnrollmentId: cEnrollmentId ?? undefined,
      });
      expect(job.targetEnrollmentId).toBe(cEnrollmentId);
      expect(job.state).toBe('queued');
      const again = await createDiagnosticJob({
        requestId: job.requestId,
        targetEnrollmentId: cEnrollmentId ?? undefined,
      });
      expect(again.id).toBe(job.id);

      // ---- Back on C: reopening re-arms the worker; the durable claim sweep
      // finds the queued job, claims it, journals, runs the diagnostic, and
      // reports — no socket frame needed.
      const c2 = reopenProfile(c);
      expect(getRuntimeStatus().auth.state).toBe('signed-in');
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();

      const deadline = Date.now() + 20_000;
      let attemptState: string | null = null;
      while (Date.now() < deadline) {
        const row = c2.db
          .prepare('SELECT state FROM mesh_attempts WHERE job_id = ?')
          .get(job.id) as { state: string } | undefined;
        attemptState = row?.state ?? null;
        if (attemptState === 'completed') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(attemptState).toBe('completed');

      // ---- Source reads the terminal state.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const final = await getMeshJob(job.id);
      expect(final?.state).toBe('completed');
      await signOutSync();
    },
  );

  it(
    'replays attempt events and round-trips an R2 artifact (MESH-03)',
    { timeout: 60_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-observe`;
      const descriptor = await backendDescriptor();

      // ---- A enrolls, C pairs in as the worker.
      const a = openProfile('a-observe');
      openProfiles.push(a);
      await enrollProfile(a, await mintCode(accountId));
      const pairing = await issueEnrollmentCode();

      const c = openProfile('c-observe');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      const cEnrollmentId = cStatus.auth.enrollmentId;
      expect(cEnrollmentId).not.toBeNull();
      const worker = await setMeshWorkerOptIn(true);
      expect(worker.connected).toBe(true);

      // ---- A creates the job; C claims via the durable sweep and runs it.
      // The worker uploads the diagnostic result as an R2 artifact while the
      // attempt is active, then reports.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const job = await createDiagnosticJob({
        requestId: `diag-obs-${Date.now()}`,
        targetEnrollmentId: cEnrollmentId ?? undefined,
      });

      const c2 = reopenProfile(c);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();

      const deadline = Date.now() + 20_000;
      let attemptId: string | null = null;
      while (Date.now() < deadline) {
        const row = c2.db
          .prepare('SELECT id, state FROM mesh_attempts WHERE job_id = ?')
          .get(job.id) as { id: string; state: string } | undefined;
        if (row?.state === 'completed') {
          attemptId = row.id;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(attemptId).not.toBeNull();

      // ---- Back on A: the durable event journal replays the attempt's
      // lifecycle + activity through observeAttempt's event.pull path.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();

      const seen: AttemptActivity[] = [];
      const detach = observeAttempt(attemptId ?? '', (item) => seen.push(item));
      try {
        const replayDeadline = Date.now() + 15_000;
        while (Date.now() < replayDeadline && seen.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(seen.length).toBeGreaterThan(0);
        // Lifecycle rows reach observers as status items; the journal must
        // contain the attempt's creation/completion history.
        const kinds = seen.map((item) => item.kind);
        expect(kinds).toContain('status');
      } finally {
        detach();
      }

      // ---- Artifact: listed account-side, manifest matches, bytes
      // round-trip byte-for-byte through the private R2 route.
      const artifacts = await listMeshArtifacts({ attemptId: attemptId ?? '' });
      expect(artifacts.length).toBeGreaterThan(0);
      const evidence = artifacts[0];
      expect(evidence.mediaType).toBe('application/json');
      const bytes = await downloadMeshArtifact(evidence.id);
      const decoded = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      expect(decoded).toBeTypeOf('object');
      await signOutSync();
    },
  );

  it(
    'runs prepare-workspace on a remote worker against a pinned manifest (SESSION-02)',
    { timeout: 90_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-prepare`;
      const descriptor = await backendDescriptor();

      // ---- Shared fixture: a real repo the source resolves HEAD on. The
      // synced remote_url is https (local transports are rejected for synced
      // definitions); the target maps its own checkout, so nothing clones.
      const repoDir = mkdtempSync(join(tmpdir(), 'anvil-gate-repo-'));
      execFileSync('git', ['init'], { cwd: repoDir });
      execFileSync(
        'git',
        [
          '-c',
          'user.email=gate@t',
          '-c',
          'user.name=gate',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: repoDir },
      );
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
      const recipe = {
        schemaVersion: 1,
        steps: [
          {
            id: 's1',
            kind: 'command',
            workingDirectory: '.',
            argv: ['/bin/echo', 'mesh-bootstrap-ok'],
            timeoutMs: 10_000,
            envNames: [],
            retry: 'safe',
          },
        ],
      };

      // ---- Profile A: enroll, create the workspace + repo + recipe, sync.
      const a = openProfile('a-prepare');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aScope = scopeFor(aStatus, descriptor.deploymentId);
      a.db
        .prepare(
          `INSERT INTO repos (id, name, path, remote_url, default_branch, status, created_at, updated_at)
           VALUES ('repo-gate', 'gate-repo', ?, 'https://example.test/gate-repo.git', 'main', 'connected', datetime('now'), datetime('now'))`,
        )
        .run(repoDir);
      a.db
        .prepare(
          `INSERT INTO workspaces (id, name, bootstrap_json, created_at, updated_at)
           VALUES ('ws-gate', 'gate-workspace', ?, datetime('now'), datetime('now'))`,
        )
        .run(JSON.stringify(recipe));
      a.db
        .prepare(
          `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
           VALUES ('ws-gate', 'repo-gate', datetime('now'))`,
        )
        .run();
      bindLocalEntities(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const pairing = await issueEnrollmentCode();

      // ---- Profile C: enroll as worker, sync the workspace, then map its
      // own checkout of the same commit and PRE-APPROVE the exact bootstrap
      // digest locally (the "operator already approved this recipe" path —
      // no remote approval is requested).
      const c = openProfile('c-prepare');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      const cEnrollmentId = cStatus.auth.enrollmentId;
      expect(cEnrollmentId).not.toBeNull();
      const worker = await setMeshWorkerOptIn(true);
      expect(worker.connected).toBe(true);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      const cDef = c.db
        .prepare(
          `SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = 'ws-gate'`,
        )
        .get() as { portable_id: string } | undefined;
      expect(cDef).toBeDefined();
      const cCheckout = mkdtempSync(join(tmpdir(), 'anvil-gate-checkout-'));
      execFileSync('git', ['clone', `file://${repoDir}`, cCheckout]);
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cCheckout }).toString().trim()).toBe(
        head,
      );
      c.db
        .prepare(
          `INSERT INTO repos (id, name, path, remote_url, default_branch, status, created_at, updated_at)
           VALUES ('repo-gate-c', 'gate-repo', ?, 'https://example.test/gate-repo.git', 'main', 'connected', datetime('now'), datetime('now'))`,
        )
        .run(cCheckout);
      c.db
        .prepare(
          `UPDATE workspace_repo_definitions SET mapped_repo_id = 'repo-gate-c'
           WHERE workspace_id = 'ws-gate' AND portable_id = ?`,
        )
        .run(cDef!.portable_id);
      c.db.prepare(`UPDATE workspaces SET definition_state = 'ready' WHERE id = 'ws-gate'`).run();
      recordBootstrapApproval('ws-gate', {
        recipe: recipe as never,
        repositoryCommits: { [cDef!.portable_id]: head },
        executionPolicy: buildDevicePolicy(),
        shellApproved: false,
      });

      // ---- Back on A: create the pinned prepare-workspace job for C.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const job = await createPrepareWorkspaceJob({
        requestId: `prep-${Date.now()}`,
        workspaceId: 'ws-gate',
        targetEnrollmentId: cEnrollmentId ?? undefined,
      });
      expect(job.state).toBe('queued');

      // ---- C claims via the durable sweep, verifies the pins, runs the
      // approved recipe, reports — poll the local attempt journal.
      const c2 = reopenProfile(c);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const deadline = Date.now() + 30_000;
      let attempt: { state: string; journal_json: string } | undefined;
      while (Date.now() < deadline) {
        attempt = c2.db
          .prepare('SELECT state, journal_json FROM mesh_attempts WHERE job_id = ?')
          .get(job.id) as { state: string; journal_json: string } | undefined;
        if (attempt !== undefined && ['completed', 'failed'].includes(attempt.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(attempt?.state).toBe('completed');
      expect(attempt?.journal_json).toContain('materialized');

      const run = c2.db
        .prepare(`SELECT state FROM bootstrap_runs WHERE workspace_id = 'ws-gate'`)
        .get() as { state: string } | undefined;
      expect(run?.state).toBe('verified');

      // ---- Source reads the terminal state.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const final = await getMeshJob(job.id);
      expect(final?.state).toBe('completed');
      await signOutSync();
    },
  );

  it(
    'gates remote bootstrap behind a durable approval the source can deny (SESSION-02)',
    { timeout: 90_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-approval`;
      const descriptor = await backendDescriptor();

      const repoDir = mkdtempSync(join(tmpdir(), 'anvil-gate-repo2-'));
      execFileSync('git', ['init'], { cwd: repoDir });
      execFileSync(
        'git',
        [
          '-c',
          'user.email=gate@t',
          '-c',
          'user.name=gate',
          'commit',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: repoDir },
      );
      const recipe = {
        schemaVersion: 1,
        steps: [
          {
            id: 's1',
            kind: 'command',
            workingDirectory: '.',
            argv: ['/bin/echo', 'needs-approval'],
            timeoutMs: 10_000,
            envNames: [],
            retry: 'safe',
          },
        ],
      };

      const a = openProfile('a-approval');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aScope = scopeFor(aStatus, descriptor.deploymentId);
      a.db
        .prepare(
          `INSERT INTO repos (id, name, path, remote_url, default_branch, status, created_at, updated_at)
           VALUES ('repo-gate', 'gate-repo', ?, 'https://example.test/gate-repo.git', 'main', 'connected', datetime('now'), datetime('now'))`,
        )
        .run(repoDir);
      a.db
        .prepare(
          `INSERT INTO workspaces (id, name, bootstrap_json, created_at, updated_at)
           VALUES ('ws-gate', 'gate-workspace', ?, datetime('now'), datetime('now'))`,
        )
        .run(JSON.stringify(recipe));
      a.db
        .prepare(
          `INSERT INTO workspace_repos (workspace_id, repo_id, added_at)
           VALUES ('ws-gate', 'repo-gate', datetime('now'))`,
        )
        .run();
      bindLocalEntities(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const pairing = await issueEnrollmentCode();

      // ---- C: worker with the repo mapped but NO bootstrap approval — the
      // recipe gate must request a durable remote approval.
      const c = openProfile('c-approval');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      const cEnrollmentId = cStatus.auth.enrollmentId;
      const worker = await setMeshWorkerOptIn(true);
      expect(worker.connected).toBe(true);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();
      const cDef = c.db
        .prepare(
          `SELECT portable_id FROM workspace_repo_definitions WHERE workspace_id = 'ws-gate'`,
        )
        .get() as { portable_id: string } | undefined;
      expect(cDef).toBeDefined();
      const cCheckout = mkdtempSync(join(tmpdir(), 'anvil-gate-checkout2-'));
      execFileSync('git', ['clone', `file://${repoDir}`, cCheckout]);
      c.db
        .prepare(
          `INSERT INTO repos (id, name, path, remote_url, default_branch, status, created_at, updated_at)
           VALUES ('repo-gate-c', 'gate-repo', ?, 'https://example.test/gate-repo.git', 'main', 'connected', datetime('now'), datetime('now'))`,
        )
        .run(cCheckout);
      c.db
        .prepare(
          `UPDATE workspace_repo_definitions SET mapped_repo_id = 'repo-gate-c'
           WHERE workspace_id = 'ws-gate' AND portable_id = ?`,
        )
        .run(cDef!.portable_id);
      c.db.prepare(`UPDATE workspaces SET definition_state = 'ready' WHERE id = 'ws-gate'`).run();

      // ---- A creates the job; C claims it and parks at the approval gate.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const job = await createPrepareWorkspaceJob({
        requestId: `prep-approval-${Date.now()}`,
        workspaceId: 'ws-gate',
        targetEnrollmentId: cEnrollmentId ?? undefined,
      });

      const c2 = reopenProfile(c);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      // Wait until the worker's journal proves the backend registered the
      // durable request ('approval-registered') before switching profiles —
      // the request is only durable once its row exists.
      const requestDeadline = Date.now() + 30_000;
      let journal = '';
      while (Date.now() < requestDeadline) {
        const row = c2.db
          .prepare('SELECT journal_json FROM mesh_attempts WHERE job_id = ?')
          .get(job.id) as { journal_json: string } | undefined;
        journal = row?.journal_json ?? '';
        if (journal.includes('approval-registered')) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(journal).toContain('approval-registered');

      // ---- A sees the pending request and denies it: the job fails durably.
      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const listDeadline = Date.now() + 15_000;
      let pending: Awaited<ReturnType<typeof listMeshApprovals>> = [];
      while (Date.now() < listDeadline) {
        pending = (await listMeshApprovals({ jobId: job.id })).filter(
          (row) => row.state === 'pending',
        );
        if (pending.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(pending.length).toBe(1);
      const decision = await decideMeshApproval(pending[0]!.id, 'denied', 'gate test denial');
      expect(decision.job.state).toBe('failed');
      const final = await getMeshJob(job.id);
      expect(final?.state).toBe('failed');
      const stored = await listMeshApprovals({ approvalId: pending[0]!.id });
      expect(stored[0]?.state).toBe('denied');
      await signOutSync();
    },
  );

  it(
    'LAUNCH-01 journey legs: device lifecycle, handoff transfer, export (real worker)',
    { timeout: 90_000 },
    async () => {
      const accountId = `acct-gate-${Date.now()}-launch`;
      const descriptor = await backendDescriptor();

      // ---- A enrolls; C pairs in as the second device (handoff target).
      const a = openProfile('a-launch');
      openProfiles.push(a);
      const aStatus = await enrollProfile(a, await mintCode(accountId));
      const aEnrollment = aStatus.auth.enrollmentId;
      expect(aEnrollment).not.toBeNull();
      const aScope = scopeFor(aStatus, descriptor.deploymentId);

      // A synced entity so export has real content.
      const template = saveWorkflowTemplate({
        name: 'launch-workflow',
        description: 'created on profile A for export',
        nodes: [node('n1')],
        edges: [],
        orchestration: DEFAULT_ORCHESTRATION,
      });
      bindLocalEntities(aScope);
      await requestSync();
      expect(getRuntimeStatus().lastError).toBeNull();

      const pairing = await issueEnrollmentCode();
      const c = openProfile('c-launch');
      openProfiles.push(c);
      const cStatus = await enrollProfile(c, pairing.code);
      const cEnrollment = cStatus.auth.enrollmentId;
      expect(cEnrollment).not.toBeNull();

      // ---- Device lifecycle over the real backend via the shipped wrappers.
      const a2 = reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      const listed = await listDevices();
      expect(listed.devices).toHaveLength(2);
      expect(listed.devices.find((d) => d.enrollmentId === aEnrollment)?.self).toBe(true);
      await renameDevice(cEnrollment ?? '', 'Launch worker');
      const renamed = await listDevices();
      expect(renamed.devices.find((d) => d.enrollmentId === cEnrollment)?.displayName).toBe(
        'Launch worker',
      );

      // ---- Handoff: a real session + repo fixtures on A; initiateHandoff
      // drives the durable backend state machine to ownership-transferred.
      const bareDir = join(a.dir, 'handoff-remote.git');
      const repoDir = join(a.dir, 'handoff-repo');
      execFileSync('git', ['init', '--bare', bareDir]);
      execFileSync('git', ['clone', bareDir, repoDir]);
      execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'gate@example.com']);
      execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Gate']);
      writeFileSync(join(repoDir, 'README.md'), 'launch acceptance\n');
      execFileSync('git', ['-C', repoDir, 'add', '.']);
      execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init']);
      execFileSync('git', ['-C', repoDir, 'push', '-u', 'origin', 'HEAD']);
      const headCommit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'])
        .toString('utf8')
        .trim();

      const sessionId = randomUUID();
      const threadId = randomUUID();
      const repoId = 'repo-launch-handoff';
      a2.db
        .prepare('INSERT INTO repos (id, name, path) VALUES (?, ?, ?)')
        .run(repoId, 'handoff', repoDir);
      a2.db
        .prepare(
          'INSERT INTO chat_threads (id, persona_id, title, repo_ids_json) VALUES (?, ?, ?, ?)',
        )
        .run(threadId, 'coder', 'Launch handoff', JSON.stringify([repoId]));
      a2.db
        .prepare('INSERT INTO chat_sessions (id, thread_id, provider) VALUES (?, ?, ?)')
        .run(sessionId, threadId, 'codex');
      a2.db
        .prepare('INSERT INTO chat_messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), threadId, 'assistant', 'checkpoint summary for the handoff');
      writeSessionOwnership(sessionId, 1, aEnrollment ?? '', 'owned');

      const initiated = await initiateHandoff({
        sessionId,
        targetEnrollmentId: cEnrollment ?? '',
      });
      expect(initiated.ok).toBe(true);
      if (initiated.ok) {
        expect(initiated.handoff.state).toBe('ownership-transferred');
        // The checkpoint carries the exact commit + bounded context. On a
        // scoped session it travels sealed — open it the same way the
        // handoff target does before reading the plaintext fields.
        const wire = initiated.handoff.checkpoint;
        const opened: SessionCheckpoint | null =
          wire === null
            ? null
            : isSealedCheckpoint(wire)
              ? (unsealScopedJson(
                  aScope,
                  `anvil/checkpoint/v1:${initiated.handoff.id}`,
                  wire,
                ) as SessionCheckpoint)
              : wire;
        expect(opened?.repositories[0]?.commit).toBe(headCommit);
      }
      const ownership = readSessionOwnership(sessionId);
      expect(ownership?.state).toBe('relinquished');
      const journalRow = a2.db
        .prepare('SELECT state FROM mesh_handoff_journal WHERE handoff_id = ?')
        .get(initiated.ok ? initiated.handoff.id : '') as { state: string } | undefined;
      expect(journalRow?.state).toBe('ownership-transferred');

      // ---- Data portability: the synced entity leaves the account over the
      // real export path.
      const begin = await beginDataExport();
      const entities: unknown[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const page = await pageDataExport(begin.operationId, cursor);
        entities.push(...page.entities);
        if (page.done) break;
        cursor = page.nextCursor;
      }
      expect(
        entities.some(
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            (e as { entityId?: string }).entityId === template.id,
        ),
      ).toBe(true);

      // ---- Revoke C: its stored credential must die remotely — the next RPC
      // through the shipped path returns unauthenticated.
      await revokeDevice(cEnrollment ?? '');
      reopenProfile(c);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await expect(listDevices()).rejects.toMatchObject({ code: 'unauthenticated' });

      reopenProfile(a);
      pinBackend({ baseUrl: BACKEND_URL, descriptor });
      enableSync();
      await signOutSync();
    },
  );
});
