#!/usr/bin/env node
// Anvil Sync & Mesh — standalone conformance runner (BYOB-02).
//
// Exercises the frozen wire contract against ANY compatible backend over
// plain HTTP: discovery, enrollment-code auth, session lifecycle, durable
// sync (push/pull/scan), device ops, data portability, account deletion.
// Nothing in this file imports repository code — a third-party backend can
// run it with `node suite.mjs --url <base> --admin-token <token>` alone.
//
// The canonical-JSON + SHA-256 change hashing below intentionally
// re-implements the contract serialization: if a backend disagrees with
// this file's canonicalization, `sync.push` rejects the payload hash and
// the suite fails — the check is self-verifying.

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
const hasFlag = (name) => args.includes(`--${name}`);

// `--fixture` spawns fixture-server.mjs on an ephemeral port, waits for
// readiness, runs the suite, and tears it down — one command for the
// non-Cloudflare leg of the gate.
let spawned = null;
let BASE = flag('url', 'http://127.0.0.1:8787').replace(/\/+$/, '');
let ADMIN_TOKEN = flag('admin-token', 'test-admin-credential');
if (hasFlag('fixture')) {
  const port = flag('port', '0');
  const fixturePath = fileURLToPath(new URL('fixture-server.mjs', import.meta.url));
  ADMIN_TOKEN = flag('admin-token', 'fixture-admin-token');
  spawned = spawn(process.execPath, [fixturePath, '--port', port, '--admin-token', ADMIN_TOKEN], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let resolved = null;
  spawned.stdout.on('data', (chunk) => {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(chunk));
    if (match !== null && resolved === null) {
      resolved = `http://127.0.0.1:${match[1]}`;
      BASE = resolved;
    }
  });
  const deadline = Date.now() + 10_000;
  while (resolved === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (spawned.exitCode !== null) throw new Error('fixture exited before readiness');
  }
  if (resolved === null) throw new Error('fixture did not report a listening port');
}
const ADMIN = `Bearer ${ADMIN_TOKEN}`;
process.on('exit', () => spawned?.kill());

const PROTOCOL = 'anvil-backend/1';

// ---- canonical JSON + change hashing (contract sync.ts) ----------------

function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return 'null';
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hashedChange({ enrollmentSequence, entityId, entityType = 'workspace', schemaVersion = 1, operation = 'create', baseRevision = null, payload = { name: entityId } }) {
  const change = {
    changeId: randomUUID(),
    enrollmentSequence,
    entityType,
    entityId,
    schemaVersion,
    baseRevision,
    operation,
    ...(operation === 'delete' ? {} : { payload }),
  };
  const hashInput = canonicalize({
    baseRevision: change.baseRevision,
    entityId: change.entityId,
    entityType: change.entityType,
    operation: change.operation,
    payload: change.payload ?? null,
    schemaVersion: change.schemaVersion,
  });
  return { ...change, payloadHash: sha256Hex(hashInput) };
}

// ---- HTTP helpers -------------------------------------------------------

async function postJson(path, body, authorization) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function rpc(operation, params, authorization) {
  const requestId = randomUUID();
  const { status, body } = await postJson(
    '/v1/rpc',
    { protocol: PROTOCOL, requestId, operation, params: params ?? {} },
    authorization,
  );
  return { status, body };
}

function unwrap(response) {
  if (response.status !== 200 || response.body?.error) {
    throw new Error(`RPC failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.result;
}

const bearer = (session) => `Bearer ${session.accessToken}`;

// ---- check harness ------------------------------------------------------

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function freshSession(accountId, installationId = 'conf-install') {
  const issued = await postJson('/v1/enrollment-codes', { accountId }, ADMIN);
  assertEq(issued.status, 200, 'issue code status');
  const enroll = await postJson('/v1/enroll', {
    proof: { method: 'enrollment-code', code: issued.body.code },
    installationId,
    displayName: 'Conformance device',
  });
  assertEq(enroll.status, 200, `enroll status (${JSON.stringify(enroll.body)})`);
  return enroll.body;
}

async function issuePairingCode(session) {
  const issued = await postJson('/v1/enrollment-codes', {}, bearer(session));
  assertEq(issued.status, 200, 'pairing code status');
  return issued.body.code;
}

// ---- suite ---------------------------------------------------------------

console.log(`conformance: ${BASE}`);

await check('discovery descriptor advertises the frozen contract', async () => {
  const res = await fetch(`${BASE}/.well-known/anvil-backend`);
  assertEq(res.status, 200, 'descriptor status');
  const d = await res.json();
  assertEq(d.descriptorVersion, 1, 'descriptorVersion');
  assert(Array.isArray(d.protocols) && d.protocols.includes(PROTOCOL), `protocols must include ${PROTOCOL}`);
  assert(Array.isArray(d.profiles) && d.profiles.includes('sync/1'), 'profiles must include sync/1');
  assert(Array.isArray(d.authModes) && d.authModes.length > 0, 'authModes non-empty');
  for (const key of ['entityBytes', 'pageBytes', 'batchChanges', 'liveFrameBytes']) {
    assert(Number.isInteger(d.limits?.[key]) && d.limits[key] > 0, `limits.${key} positive int`);
  }
  assert(typeof d.deploymentId === 'string' && d.deploymentId.length > 0, 'deploymentId');
});

await check('rejects unauthenticated rpc', async () => {
  const res = await rpc('session.describe', {}, 'Bearer anvil_at_notreal');
  assertEq(res.status, 401, 'status');
  assertEq(res.body?.error?.code, 'unauthenticated', 'error code');
});

await check('enrollment-code enroll + session.describe identity', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  assertEq(session.accountId, accountId, 'session accountId');
  assert(session.accessToken?.startsWith('anvil_at_'), 'access token shape');
  assert(session.refreshToken?.startsWith('anvil_rt_'), 'refresh token shape');
  const described = unwrap(await rpc('session.describe', {}, bearer(session)));
  assertEq(described.accountId, accountId, 'describe accountId');
  assertEq(described.enrollmentId, session.enrollmentId, 'describe enrollmentId');
  assert(typeof described.datasetEpoch === 'string', 'datasetEpoch present');
  assert(!JSON.stringify(described).includes('anvil_at_'), 'no token material in describe');
});

await check('sync.push accepts, receipts idempotently replay, pull returns the change', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  const change = hashedChange({ enrollmentSequence: 1, entityId: 'conf-entity', payload: { name: 'One' } });
  const first = unwrap(await rpc('sync.push', { changes: [change] }, bearer(session)));
  assertEq(first.results[0]?.status, 'accepted', 'push status');
  const replay = unwrap(await rpc('sync.push', { changes: [change] }, bearer(session)));
  assertEq(JSON.stringify(replay.results), JSON.stringify(first.results), 'receipt replay');
  const pull = unwrap(await rpc('sync.pull', { cursor: null, maxBytes: 65536 }, bearer(session)));
  const found = pull.changes.find((c) => c.entityId === 'conf-entity');
  assert(found !== undefined, 'pulled change present');
  assertEq(found.revision, 1, 'revision');
  assertEq(found.payload.name, 'One', 'payload');
});

await check('sync.push rejects a mutated payload hash', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  const change = hashedChange({ enrollmentSequence: 1, entityId: 'conf-hash', payload: { name: 'Real' } });
  change.payload = { name: 'Tampered' };
  const res = await rpc('sync.push', { changes: [change] }, bearer(session));
  assert(res.status !== 200 || res.body?.result?.results?.[0]?.status !== 'accepted',
    'tampered hash must not be accepted');
});

await check('conditional revision conflict on a stale baseRevision', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  await rpc('sync.push', { changes: [hashedChange({ enrollmentSequence: 1, entityId: 'conf-rev', payload: { v: 1 } })] }, bearer(session));
  const stale = hashedChange({ enrollmentSequence: 2, entityId: 'conf-rev', operation: 'update', baseRevision: 9, payload: { v: 2 } });
  const res = unwrap(await rpc('sync.push', { changes: [stale] }, bearer(session)));
  assert(res.results[0]?.status !== 'accepted', `stale baseRevision must not apply, got ${res.results[0]?.status}`);
});

await check('sync.scan pages entities and finish reports watermark', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  for (let i = 0; i < 3; i += 1) {
    await rpc('sync.push', { changes: [hashedChange({ enrollmentSequence: i + 1, entityId: `scan-${i}`, payload: { i } })] }, bearer(session));
  }
  const begin = unwrap(await rpc('sync.scan.begin', {}, bearer(session)));
  assert(typeof begin.scanId === 'string', 'scanId');
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i += 1) {
    const page = unwrap(await rpc('sync.scan.page', { scanId: begin.scanId, cursor, maxBytes: 65536 }, bearer(session)));
    seen.push(...page.entities);
    if (page.done) break;
    cursor = page.nextCursor;
  }
  assertEq(seen.length, 3, 'scanned entities');
  const finish = unwrap(await rpc('sync.scan.finish', { scanId: begin.scanId }, bearer(session)));
  assert(finish.complete === true, 'scan complete');
  assert(typeof finish.watermarkEnd === 'number', 'watermarkEnd');
});

await check('device lifecycle: list, rename, revoke sibling', async () => {
  const accountId = `conf-${randomUUID()}`;
  const a = await freshSession(accountId, 'conf-a');
  const code = await issuePairingCode(a);
  const enrollB = await postJson('/v1/enroll', {
    proof: { method: 'enrollment-code', code },
    installationId: 'conf-b',
  });
  assertEq(enrollB.status, 200, 'pairing enroll');
  const b = enrollB.body;
  const list = unwrap(await rpc('device.list', {}, bearer(a)));
  assertEq(list.devices.length, 2, 'device count');
  assert(list.devices.find((d) => d.enrollmentId === a.enrollmentId)?.self === true, 'self marked');
  await rpc('device.rename', { enrollmentId: b.enrollmentId, displayName: 'Renamed' }, bearer(a));
  const renamed = unwrap(await rpc('device.list', {}, bearer(a)));
  assertEq(renamed.devices.find((d) => d.enrollmentId === b.enrollmentId)?.displayName, 'Renamed', 'rename');
  unwrap(await rpc('device.revoke', { enrollmentId: b.enrollmentId }, bearer(a)));
  const dead = await rpc('session.describe', {}, bearer(b));
  assertEq(dead.status, 401, 'revoked session');
  const after = unwrap(await rpc('device.list', {}, bearer(a)));
  assert(after.devices.find((d) => d.enrollmentId === b.enrollmentId)?.revoked === true, 'revoked still listed');
});

await check('session refresh rotates credentials and kills the old access token', async () => {
  const accountId = `conf-${randomUUID()}`;
  const session = await freshSession(accountId);
  const rotated = await postJson('/v1/session/refresh', {
    refreshToken: session.refreshToken,
    enrollmentId: session.enrollmentId,
  });
  assertEq(rotated.status, 200, 'refresh status');
  const next = rotated.body;
  assert(next.accessToken !== session.accessToken, 'access token rotated');
  const stale = await rpc('session.describe', {}, bearer(session));
  assertEq(stale.status, 401, 'stale access token');
  const fresh = await rpc('session.describe', {}, bearer(next));
  assertEq(fresh.status, 200, 'fresh access token');
});

await check('data.export pages entities; data.import previews and commits on another account', async () => {
  const src = await freshSession(`conf-src-${randomUUID()}`);
  const dst = await freshSession(`conf-dst-${randomUUID()}`);
  await rpc('sync.push', { changes: [hashedChange({ enrollmentSequence: 1, entityId: 'port-me', payload: { name: 'Portable' } })] }, bearer(src));

  const begin = unwrap(await rpc('data.export.begin', {}, bearer(src)));
  const entities = [];
  let cursor = null;
  for (let i = 0; i < 10; i += 1) {
    const page = unwrap(await rpc('data.export.page', { operationId: begin.operationId, cursor, maxBytes: 65536 }, bearer(src)));
    entities.push(...page.entities);
    if (page.done) break;
    cursor = page.nextCursor;
  }
  assertEq(entities.length, 1, 'exported entity count');

  const preview = unwrap(await rpc('data.import.preview', { formatVersion: 1, entities }, bearer(dst)));
  assertEq(preview.summary.creates, 1, 'preview creates');
  const commit = unwrap(await rpc('data.import.commit', { operationId: preview.operationId }, bearer(dst)));
  assertEq(commit.applied, 1, 'commit applied');
  const pull = unwrap(await rpc('sync.pull', { cursor: null, maxBytes: 65536 }, bearer(dst)));
  assertEq(pull.changes.find((c) => c.entityId === 'port-me')?.payload?.name, 'Portable', 'imported payload');
});

await check('account.delete revokes sessions, purges, and locks the accountId', async () => {
  const accountId = `conf-del-${randomUUID()}`;
  const session = await freshSession(accountId);
  await rpc('sync.push', { changes: [hashedChange({ enrollmentSequence: 1, entityId: 'doomed', payload: {} })] }, bearer(session));
  const del = unwrap(await rpc('account.delete', {}, bearer(session)));
  assert(del.state === 'deleting' || del.state === 'deleted', `delete state ${del.state}`);
  const dead = await rpc('sync.pull', { cursor: null, maxBytes: 1024 }, bearer(session));
  assertEq(dead.status, 401, 'post-delete bearer rejected');
  const status = unwrap(await rpc('account.deletionStatus', { accountId }, ADMIN));
  assertEq(status.state, 'deleted', 'purge converged');
  // Stale clients cannot recreate hosted state for the dead accountId.
  const reissue = await postJson('/v1/enrollment-codes', { accountId }, ADMIN);
  assertEq(reissue.status, 403, 'code issuance blocked');
});

// ---- report --------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} conformance checks passed`);
spawned?.kill();
process.exit(failed.length > 0 ? 1 : 0);
