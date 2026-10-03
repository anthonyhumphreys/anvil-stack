#!/usr/bin/env node
// Anvil Sync & Mesh — non-Cloudflare reference fixture (BYOB-02).
//
// A minimal IN-MEMORY backend implementing the `sync/1` profile over plain
// Node http: no Cloudflare, no Durable Objects, no R2 — proving the frozen
// wire contract is provider-neutral. It exists so the conformance suite
// (suite.mjs) has a second implementation to run against, and so the
// unmodified desktop can connect to something that is not Cloudflare.
//
// Deliberately a fixture, not a production backend: state is per-process
// memory, tokens are stored as SHA-256 hashes but everything else trades
// durability for clarity. Advertised profiles: ['sync/1'] only.
//
//   node fixture-server.mjs [--port 8790]
//   ADMIN_TOKEN default: 'fixture-admin-token'

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const PORT = Number(flag('port', '8790'));
const ADMIN_TOKEN = flag('admin-token', 'fixture-admin-token');
const PROTOCOL = 'anvil-backend/1';
const EPOCH = 'fixture-epoch-1';
const PAGE_BYTES = 1024 * 1024;
const ENTITY_BYTES = 256 * 1024;
const BATCH_CHANGES = 500;
const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 15 * 60 * 1000;

// ---- canonical JSON + hashing (contract sync.ts) -------------------------

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
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---- fixture state --------------------------------------------------------

/** accountId → account record */
const accounts = new Map();
/** accessTokenHash → session row */
const sessions = new Map();
/** refreshTokenHash → session row */
const sessionsByRefresh = new Map();
/** codeHash → { accountId, expiresAt, consumedAt, displayName } */
const codes = new Map();
/** accountId → { generation, startedAt, deletedAt } — tombstones outlive data */
const tombstones = new Map();
/** operationId → data operation row */
const dataOps = new Map();
/** scanId → { accountId, watermarkStart, epoch, createdAt, done, entityCursor } */
const scans = new Map();

function account(id) {
  let a = accounts.get(id);
  if (a === undefined) {
    a = {
      nextSequence: 1,
      entities: new Map(), // `${type}\n${id}` → row
      changes: [], // append-only journal
      receipts: new Map(), // `${enr}:${seq}` → {contentHash, result}
      enrollments: new Map(), // enrollmentId → { highWater }
    };
    accounts.set(id, a);
  }
  return a;
}

function issueSession(accountId, enrollmentId, installationId, displayName) {
  const accessToken = `anvil_at_${randomUUID().replace(/-/g, '')}`;
  const refreshToken = `anvil_rt_${randomUUID().replace(/-/g, '')}`;
  const prev = [...sessions.values()].find(
    (s) => s.enrollmentId === enrollmentId && s.accountId === accountId && !s.revokedAt,
  );
  const generation = prev === undefined ? 1 : prev.credentialGeneration + 1;
  const session = {
    accountId,
    enrollmentId,
    installationId,
    displayName: displayName ?? null,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    credentialGeneration: generation,
    accessExpiresAt: Date.now() + ACCESS_TTL_MS,
    revokedAt: null,
    createdAt: Date.now(),
  };
  sessions.set(session.accessTokenHash, session);
  sessionsByRefresh.set(session.refreshTokenHash, session);
  return {
    accessToken,
    accessExpiresAt: new Date(session.accessExpiresAt).toISOString(),
    refreshToken,
    credentialGeneration: generation,
    enrollmentId,
    accountId,
    datasetEpoch: EPOCH,
    ...(session.displayName === null ? {} : { displayName: session.displayName }),
  };
}

// ---- HTTP plumbing ----------------------------------------------------------

function rpcError(requestId, code, status, details) {
  const retriable = code === 'unavailable' || code === 'throttled';
  return json(
    {
      ...(requestId === undefined ? {} : { requestId }),
      error: { code, retryable: retriable, ...(details === undefined ? {} : { details }) },
    },
    status,
  );
}

function rpcOk(requestId, result) {
  return json({ requestId, result, serverTime: new Date().toISOString() }, 200);
}

function json(body, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

function authError(code, status = 401) {
  return json({ error: { code, retryable: false } }, status);
}

function forbidden(reason) {
  return json(
    { error: { code: 'forbidden', retryable: false, details: { reason } } },
    403,
  );
}

function sessionFromAuth(header) {
  const m = /^Bearer (anvil_at_[A-Za-z0-9_-]+)$/.exec(header ?? '');
  if (m === null) return null;
  const session = sessions.get(sha256Hex(m[1]));
  if (session === undefined || session.revokedAt !== null || session.accessExpiresAt <= Date.now()) {
    return null;
  }
  return session;
}

function enrollment(account, enrollmentId) {
  let e = account.enrollments.get(enrollmentId);
  if (e === undefined) {
    e = { highWater: 0 };
    account.enrollments.set(enrollmentId, e);
  }
  return e;
}

// ---- sync domain ------------------------------------------------------------

function applyChange(session, change) {
  const acct = account(session.accountId);
  const enr = enrollment(acct, session.enrollmentId);
  const receiptKey = `${session.enrollmentId}:${change.enrollmentSequence}`;
  const existingReceipt = acct.receipts.get(receiptKey);
  if (existingReceipt !== undefined) {
    return existingReceipt.contentHash === change.payloadHash
      ? { result: existingReceipt.result }
      : { result: { status: 'rejected', changeId: change.changeId, reason: 'changed-content' } };
  }
  let result;
  if (change.enrollmentSequence <= enr.highWater) {
    result = { status: 'receipt-expired', changeId: change.changeId };
  } else {
    const key = `${change.entityType}\n${change.entityId}`;
    const existing = acct.entities.get(key);
    const baseOk =
      change.operation === 'create'
        ? existing === undefined || existing.operation === 'delete'
        : existing !== undefined && change.baseRevision === existing.revision;
    if (!baseOk) {
      result = {
        status: 'conflict',
        changeId: change.changeId,
        baseRevision: existing?.revision ?? null,
      };
    } else {
      const revision = existing === undefined ? 1 : existing.revision + 1;
      const sequence = acct.nextSequence++;
      const payloadJson = change.operation === 'delete' ? null : JSON.stringify(change.payload);
      acct.entities.set(key, {
        entity_type: change.entityType,
        entity_id: change.entityId,
        revision,
        operation: change.operation,
        schema_version: change.schemaVersion,
        payload: payloadJson,
        sequence,
      });
      acct.changes.push({
        sequence,
        entity_type: change.entityType,
        entity_id: change.entityId,
        revision,
        operation: change.operation,
        schema_version: change.schemaVersion,
        payload: payloadJson,
      });
      result = {
        status: 'accepted',
        changeId: change.changeId,
        revision,
        ...(change.operation === 'delete' ? {} : { content: change.payload }),
      };
    }
  }
  acct.receipts.set(receiptKey, { contentHash: change.payloadHash, result });
  enr.highWater = Math.max(enr.highWater, change.enrollmentSequence);
  return { result };
}

function validChangeShape(c) {
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.changeId === 'string' &&
    Number.isInteger(c.enrollmentSequence) &&
    typeof c.entityType === 'string' &&
    typeof c.entityId === 'string' &&
    Number.isInteger(c.schemaVersion) &&
    (c.baseRevision === null || Number.isInteger(c.baseRevision)) &&
    ['create', 'update', 'delete'].includes(c.operation) &&
    typeof c.payloadHash === 'string'
  );
}

function hashOk(change) {
  const input = canonicalize({
    baseRevision: change.baseRevision,
    entityId: change.entityId,
    entityType: change.entityType,
    operation: change.operation,
    payload: change.payload ?? null,
    schemaVersion: change.schemaVersion,
  });
  return sha256Hex(input) === change.payloadHash;
}

// ---- RPC dispatch -------------------------------------------------------------

function handleRpcOp(session, requestId, operation, params) {
  const acct = account(session.accountId);
  switch (operation) {
    case 'session.describe':
      return rpcOk(requestId, {
        accountId: session.accountId,
        enrollmentId: session.enrollmentId,
        datasetEpoch: EPOCH,
        credentialGeneration: session.credentialGeneration,
        accessExpiresAt: new Date(session.accessExpiresAt).toISOString(),
        ...(session.displayName === null ? {} : { displayName: session.displayName }),
      });

    case 'sync.push': {
      const changes = params?.changes;
      if (!Array.isArray(changes) || changes.length > BATCH_CHANGES) {
        return rpcError(requestId, 'malformed-request', 400, { reason: 'changes' });
      }
      for (const c of changes) {
        if (!validChangeShape(c) || !hashOk(c)) {
          return rpcError(requestId, 'malformed-request', 400, { reason: 'payload-hash-mismatch' });
        }
        if (c.operation !== 'delete' && bytes(JSON.stringify(c.payload)) > ENTITY_BYTES) {
          return rpcError(requestId, 'payload-too-large', 413);
        }
      }
      const results = changes.map((c) => applyChange(session, c).result);
      return rpcOk(requestId, { results });
    }

    case 'sync.pull': {
      const after = params?.cursor === null || params?.cursor === undefined ? 0 : Number(params.cursor);
      const maxBytes = Math.min(Number(params?.maxBytes) || PAGE_BYTES, PAGE_BYTES);
      const out = [];
      let used = 0;
      let last = after;
      for (const row of acct.changes) {
        if (row.sequence <= after) continue;
        const change = {
          entityType: row.entity_type,
          entityId: row.entity_id,
          revision: row.revision,
          operation: row.operation,
          schemaVersion: row.schema_version,
          sequence: row.sequence,
          ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) }),
        };
        const size = bytes(JSON.stringify(change));
        if (out.length > 0 && used + size > maxBytes) break;
        out.push(change);
        used += size;
        last = row.sequence;
      }
      const hasMore = acct.changes.some((r) => r.sequence > last);
      return rpcOk(requestId, {
        changes: out,
        nextCursor: String(last),
        hasMore,
      });
    }

    case 'sync.scan.begin': {
      const scanId = randomUUID();
      scans.set(scanId, {
        accountId: session.accountId,
        watermarkStart: acct.nextSequence - 1,
        epoch: EPOCH,
        createdAt: Date.now(),
        done: 0,
      });
      return rpcOk(requestId, {
        scanId,
        watermarkStart: acct.nextSequence - 1,
        resumeCursor: String(acct.nextSequence - 1),
        epoch: EPOCH,
      });
    }

    case 'sync.scan.page': {
      const scan = scans.get(params?.scanId);
      if (scan === undefined || scan.accountId !== session.accountId) {
        return rpcError(requestId, 'not-found', 404, { reason: 'scan' });
      }
      if (scan.done === 1) return rpcOk(requestId, { entities: [], nextCursor: null, done: true });
      const after = params?.cursor ? JSON.parse(params.cursor) : null;
      const maxBytes = Math.min(Number(params?.maxBytes) || PAGE_BYTES, PAGE_BYTES);
      const rows = [...acct.entities.values()]
        .filter((r) => r.operation !== 'delete')
        .filter(
          (r) =>
            after === null ||
            r.entity_type > after[0] ||
            (r.entity_type === after[0] && r.entity_id > after[1]),
        )
        .sort((a, b) =>
          a.entity_type === b.entity_type
            ? a.entity_id < b.entity_id
              ? -1
              : 1
            : a.entity_type < b.entity_type
              ? -1
              : 1,
        );
      const entities = [];
      let used = 0;
      let remaining = false;
      for (const row of rows) {
        const entity = {
          entityType: row.entity_type,
          entityId: row.entity_id,
          revision: row.revision,
          schemaVersion: row.schema_version,
          payload: row.payload === null ? null : JSON.parse(row.payload),
        };
        const size = bytes(JSON.stringify(entity));
        if (entities.length > 0 && used + size > maxBytes) {
          remaining = true;
          break;
        }
        entities.push(entity);
        used += size;
      }
      if (!remaining && entities.length < rows.length) remaining = true;
      const last = entities[entities.length - 1];
      const cursor = last === undefined ? null : JSON.stringify([last.entityType, last.entityId]);
      scan.done = remaining ? 0 : 1;
      scan.entityCursor = cursor;
      return rpcOk(requestId, {
        entities,
        nextCursor: remaining ? cursor : null,
        done: !remaining,
      });
    }

    case 'sync.scan.finish': {
      const scan = scans.get(params?.scanId);
      if (scan === undefined || scan.accountId !== session.accountId) {
        return rpcError(requestId, 'not-found', 404, { reason: 'scan' });
      }
      if (scan.done !== 1) {
        return rpcError(requestId, 'malformed-request', 400, { reason: 'scan-incomplete' });
      }
      return rpcOk(requestId, {
        scanId: scan.scanId ?? params.scanId,
        complete: true,
        watermarkEnd: acct.nextSequence - 1,
        epoch: EPOCH,
        nextCursor: String(acct.nextSequence - 1),
      });
    }

    case 'device.list': {
      const devices = [...sessions.values()]
        .filter((s) => s.accountId === session.accountId)
        .map((s) => ({
          enrollmentId: s.enrollmentId,
          installationId: s.installationId,
          ...(s.displayName === null ? {} : { displayName: s.displayName }),
          credentialGeneration: s.credentialGeneration,
          revoked: s.revokedAt !== null,
          self: s.enrollmentId === session.enrollmentId,
          createdAt: new Date(s.createdAt).toISOString(),
        }));
      return rpcOk(requestId, { devices });
    }

    case 'device.rename': {
      const target = [...sessions.values()].find(
        (s) => s.enrollmentId === params?.enrollmentId && s.accountId === session.accountId,
      );
      if (target === undefined) return rpcError(requestId, 'not-found', 404);
      const name = params?.displayName;
      if (typeof name !== 'string' || name.length > 128) {
        return rpcError(requestId, 'malformed-request', 400, { reason: 'displayName' });
      }
      target.displayName = name === '' ? null : name;
      return rpcOk(requestId, {
        enrollmentId: target.enrollmentId,
        ...(target.displayName === null ? {} : { displayName: target.displayName }),
      });
    }

    case 'device.revoke': {
      const target = [...sessions.values()].find(
        (s) => s.enrollmentId === params?.enrollmentId && s.accountId === session.accountId,
      );
      if (target === undefined) return rpcError(requestId, 'not-found', 404);
      if (target.revokedAt === null) target.revokedAt = Date.now();
      return rpcOk(requestId, { revoked: true, enrollmentId: target.enrollmentId });
    }

    case 'data.export.begin': {
      const operationId = `exp_${randomUUID()}`;
      dataOps.set(operationId, {
        operationId,
        kind: 'export',
        state: 'open',
        accountId: session.accountId,
        createdAt: Date.now(),
        watermark: acct.nextSequence - 1,
        entityCursor: null,
        plan: null,
        result: null,
      });
      return rpcOk(requestId, { operationId, epoch: EPOCH, watermarkStart: acct.nextSequence - 1 });
    }

    case 'data.export.page': {
      const op = dataOps.get(params?.operationId);
      if (op === undefined || op.accountId !== session.accountId || op.kind !== 'export') {
        return rpcError(requestId, op === undefined ? 'not-found' : 'malformed-request', op === undefined ? 404 : 400);
      }
      if (op.state === 'done') {
        return rpcOk(requestId, {
          operationId: op.operationId,
          formatVersion: 1,
          epoch: EPOCH,
          entities: [],
          nextCursor: null,
          done: true,
        });
      }
      const after = params?.cursor ? JSON.parse(params.cursor) : null;
      const maxBytes = Math.min(Number(params?.maxBytes) || PAGE_BYTES, PAGE_BYTES);
      const rows = [...acct.entities.values()]
        .filter((r) => r.operation !== 'delete')
        .filter(
          (r) =>
            after === null ||
            r.entity_type > after[0] ||
            (r.entity_type === after[0] && r.entity_id > after[1]),
        )
        .sort((a, b) =>
          a.entity_type === b.entity_type
            ? a.entity_id < b.entity_id
              ? -1
              : 1
            : a.entity_type < b.entity_type
              ? -1
              : 1,
        );
      const entities = [];
      let used = 0;
      let remaining = false;
      for (const row of rows) {
        const entity = {
          entityType: row.entity_type,
          entityId: row.entity_id,
          revision: row.revision,
          schemaVersion: row.schema_version,
          payload: row.payload === null ? null : JSON.parse(row.payload),
        };
        const size = bytes(JSON.stringify(entity));
        if (entities.length > 0 && used + size > maxBytes) {
          remaining = true;
          break;
        }
        entities.push(entity);
        used += size;
      }
      if (!remaining && entities.length < rows.length) remaining = true;
      const last = entities[entities.length - 1];
      const cursor = last === undefined ? op.entityCursor : JSON.stringify([last.entityType, last.entityId]);
      op.entityCursor = cursor;
      op.state = remaining ? 'open' : 'done';
      return rpcOk(requestId, {
        operationId: op.operationId,
        formatVersion: 1,
        epoch: EPOCH,
        entities,
        nextCursor: remaining ? cursor : null,
        done: !remaining,
      });
    }

    case 'data.import.preview': {
      if (params?.formatVersion !== 1 || !Array.isArray(params?.entities)) {
        return rpcError(requestId, 'malformed-request', 400, { reason: 'import-preview-params' });
      }
      const entries = params.entities.map((e) => classifyImport(acct, e));
      const summary = { creates: 0, identical: 0, conflicts: 0, invalid: 0 };
      for (const e of entries) {
        summary[
          e.outcome === 'create' ? 'creates' : e.outcome === 'identical' ? 'identical' : e.outcome === 'conflict' ? 'conflicts' : 'invalid'
        ] += 1;
      }
      const operationId = `imp_${randomUUID()}`;
      dataOps.set(operationId, {
        operationId,
        kind: 'import',
        state: 'previewed',
        accountId: session.accountId,
        createdAt: Date.now(),
        plan: entries,
        result: null,
      });
      return rpcOk(requestId, {
        operationId,
        summary,
        entries: entries.slice(0, 200).map((e) => ({
          entityType: e.entityType,
          entityId: e.entityId,
          outcome: e.outcome,
          ...(e.reason === undefined ? {} : { reason: e.reason }),
        })),
        truncated: entries.length > 200,
      });
    }

    case 'data.import.commit': {
      const op = dataOps.get(params?.operationId);
      if (op === undefined || op.accountId !== session.accountId) {
        return rpcError(requestId, 'not-found', 404, { reason: 'data-operation' });
      }
      if (op.kind !== 'import') {
        return rpcError(requestId, 'malformed-request', 400, { reason: 'operation-kind-mismatch' });
      }
      if (op.state === 'committed') return rpcOk(requestId, op.result);
      if (op.state !== 'previewed') {
        return rpcError(requestId, 'invalid-transition', 409, { reason: 'import-not-previewed' });
      }
      let applied = 0;
      let conflicts = 0;
      let skipped = 0;
      for (const entry of op.plan) {
        const current = classifyImport(acct, entry);
        if (current.outcome !== 'create') {
          if (current.outcome === 'conflict') conflicts += 1;
          else skipped += 1;
          continue;
        }
        const key = `${entry.entityType}\n${entry.entityId}`;
        const sequence = acct.nextSequence++;
        const payloadJson = JSON.stringify(entry.payload);
        acct.entities.set(key, {
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          revision: 1,
          operation: 'create',
          schema_version: entry.schemaVersion,
          payload: payloadJson,
          sequence,
        });
        acct.changes.push({
          sequence,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          revision: 1,
          operation: 'create',
          schema_version: entry.schemaVersion,
          payload: payloadJson,
        });
        applied += 1;
      }
      op.result = { operationId: op.operationId, applied, conflicts, skipped };
      op.state = 'committed';
      return rpcOk(requestId, op.result);
    }

    case 'data.operationStatus': {
      const op = dataOps.get(params?.operationId);
      if (op === undefined || op.accountId !== session.accountId) {
        return rpcError(requestId, 'not-found', 404, { reason: 'data-operation' });
      }
      return rpcOk(requestId, {
        operationId: op.operationId,
        kind: op.kind,
        state: op.state,
        createdAt: new Date(op.createdAt).toISOString(),
        ...(op.state === 'done' || op.state === 'committed'
          ? { finishedAt: new Date(op.createdAt).toISOString() }
          : {}),
        ...(op.result === null ? {} : { detail: { result: op.result } }),
      });
    }

    case 'account.delete': {
      // Enrollments disable first, then hosted data drops; the tombstone
      // outlives the account record so the dead accountId stays locked.
      for (const s of sessions.values()) {
        if (s.accountId === session.accountId && s.revokedAt === null) {
          s.revokedAt = Date.now();
        }
      }
      accounts.delete(session.accountId);
      tombstones.set(session.accountId, {
        generation: 1,
        startedAt: Date.now(),
        deletedAt: Date.now(),
      });
      return rpcOk(requestId, {
        state: 'deleted',
        deletionGeneration: 1,
        startedAt: new Date().toISOString(),
      });
    }

    case 'account.deletionStatus': {
      const tomb = tombstones.get(session.accountId);
      if (tomb === undefined) return rpcOk(requestId, { state: 'none' });
      return rpcOk(requestId, {
        state: 'deleted',
        deletionGeneration: tomb.generation,
        startedAt: new Date(tomb.startedAt).toISOString(),
        deletedAt: new Date(tomb.deletedAt).toISOString(),
      });
    }

    default:
      return rpcError(requestId, 'unsupported-operation', 400);
  }
}

function classifyImport(acct, entity) {
  const base = {
    entityType: entity.entityType,
    entityId: entity.entityId,
    revision: entity.revision,
    schemaVersion: entity.schemaVersion,
    payload: entity.payload,
  };
  if (
    typeof entity.entityType !== 'string' ||
    typeof entity.entityId !== 'string' ||
    entity.entityType.length === 0 ||
    entity.entityId.length === 0 ||
    !Number.isInteger(entity.revision) ||
    entity.revision < 1 ||
    !Number.isInteger(entity.schemaVersion) ||
    entity.schemaVersion < 1 ||
    entity.payload === undefined ||
    bytes(JSON.stringify(entity.payload)) > ENTITY_BYTES
  ) {
    return { ...base, outcome: 'invalid', reason: 'malformed-entity' };
  }
  const existing = acct.entities.get(`${entity.entityType}\n${entity.entityId}`);
  if (existing === undefined || existing.operation === 'delete') {
    return { ...base, outcome: 'create' };
  }
  if (existing.payload === JSON.stringify(entity.payload)) {
    return { ...base, outcome: 'identical' };
  }
  return { ...base, outcome: 'conflict', reason: 'exists-different-content' };
}

// ---- routes -------------------------------------------------------------------

async function route(method, path, headers, body) {
  if (method === 'GET' && path === '/.well-known/anvil-backend') {
    return json({
      descriptorVersion: 1,
      deploymentId: 'fixture-0000-0000-0000-nodeinmemory',
      displayName: 'Anvil conformance fixture (in-memory Node)',
      protocols: [PROTOCOL],
      profiles: ['sync/1'],
      apiPath: 'v1',
      socketPath: 'v1/connect',
      authModes: ['enrollment-code'],
      auth: {
        issuer: 'https://enrollment.invalid',
        publicClientId: 'anvil-desktop',
        scopes: ['openid'],
      },
      limits: {
        entityBytes: ENTITY_BYTES,
        pageBytes: PAGE_BYTES,
        batchChanges: BATCH_CHANGES,
        liveFrameBytes: 64 * 1024,
      },
    });
  }

  if (method === 'POST' && path === '/v1/enrollment-codes') {
    const auth = headers['authorization'];
    let accountId;
    if (auth === `Bearer ${ADMIN_TOKEN}`) {
      if (typeof body.accountId !== 'string' || body.accountId.length === 0) {
        return authError('malformed-request', 400);
      }
      accountId = body.accountId;
    } else {
      const session = sessionFromAuth(auth);
      if (session === null) return authError('unauthenticated');
      accountId = session.accountId;
    }
    if (tombstones.has(accountId)) return forbidden('account-deleted');
    const raw = randomUUID().replace(/-/g, '').toUpperCase();
    const code = `anvil-ec-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
    const normalized = raw.slice(0, 20);
    codes.set(sha256Hex(normalized), {
      accountId,
      expiresAt: Date.now() + CODE_TTL_MS,
      consumedAt: null,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
    });
    return json({
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      accountId,
    });
  }

  if (method === 'POST' && path === '/v1/enroll') {
    const proof = body?.proof;
    if (proof?.method !== 'enrollment-code' || typeof proof.code !== 'string') {
      return authError('invalid-proof');
    }
    if (typeof body.installationId !== 'string' || body.installationId.length === 0) {
      return authError('malformed-request', 400);
    }
    const normalized = proof.code
      .trim()
      .replace(/^anvil-ec-/i, '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase();
    const row = codes.get(sha256Hex(normalized));
    if (row === undefined || row.consumedAt !== null || row.expiresAt <= Date.now()) {
      return authError('enrollment-code-used');
    }
    row.consumedAt = Date.now();
    if (tombstones.has(row.accountId)) return forbidden('account-deleted');
    const enrollmentId = `enr_${randomUUID()}`;
    return json(issueSession(row.accountId, enrollmentId, body.installationId, row.displayName ?? body.displayName));
  }

  if (method === 'POST' && path === '/v1/session/refresh') {
    const row = sessionsByRefresh.get(sha256Hex(String(body?.refreshToken ?? '')));
    if (row === undefined || row.revokedAt !== null || row.enrollmentId !== body?.enrollmentId) {
      return authError('unauthenticated');
    }
    sessions.delete(row.accessTokenHash);
    sessionsByRefresh.delete(row.refreshTokenHash);
    const rotated = issueSession(row.accountId, row.enrollmentId, row.installationId, row.displayName ?? undefined);
    rotated.credentialGeneration = row.credentialGeneration + 1;
    // Fix generation on the stored row — issueSession already incremented.
    return json(rotated);
  }

  if (method === 'POST' && path === '/v1/session/revoke') {
    const session = sessionFromAuth(headers['authorization']);
    if (session === null || session.enrollmentId !== body?.enrollmentId) {
      return authError('unauthenticated');
    }
    if (session.revokedAt === null) session.revokedAt = Date.now();
    return json({ revoked: true });
  }

  if (method === 'POST' && path === '/v1/rpc') {
    if (body?.protocol !== PROTOCOL || typeof body?.requestId !== 'string' || typeof body?.operation !== 'string') {
      return rpcError(undefined, 'malformed-request', 400);
    }
    // account.deletionStatus stays reachable after sessions die: the admin
    // credential reads a tombstone directly.
    if (body.operation === 'account.deletionStatus' && headers['authorization'] === `Bearer ${ADMIN_TOKEN}`) {
      const accountId = body.params?.accountId;
      if (typeof accountId !== 'string' || accountId.length === 0) {
        return rpcError(body.requestId, 'malformed-request', 400);
      }
      const tomb = tombstones.get(accountId);
      return rpcOk(body.requestId, tomb === undefined
        ? { state: 'none' }
        : {
            state: 'deleted',
            deletionGeneration: tomb.generation,
            startedAt: new Date(tomb.startedAt).toISOString(),
            deletedAt: new Date(tomb.deletedAt).toISOString(),
          });
    }
    const session = sessionFromAuth(headers['authorization']);
    if (session === null) return rpcError(body.requestId, 'unauthenticated', 401);
    if (tombstones.has(session.accountId)) {
      return rpcError(body.requestId, 'forbidden', 403, { reason: 'account-deleted' });
    }
    return handleRpcOp(session, body.requestId, body.operation, body.params ?? {});
  }

  return rpcError(undefined, 'not-found', 404);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    try {
      const response = await route(req.method ?? 'GET', path, req.headers, body);
      res.writeHead(response.status, response.headers);
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unavailable', retryable: true } }));
      console.error(error);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : PORT;
  console.log(`anvil conformance fixture (sync/1, in-memory) on http://127.0.0.1:${port}`);
  console.log(`admin token: ${ADMIN_TOKEN}`);
});
