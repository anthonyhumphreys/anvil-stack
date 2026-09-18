// SessionCoordinator (AUTH-01): single global Durable Object owning device
// sessions, rotating refresh credentials, and single-use enrollment codes.
//
// Tokens are opaque `anvil_at_*`/`anvil_rt_*` values; only SHA-256 hashes are
// stored. Refresh rotation keeps the superseded credential redeemable for a
// short grace window: re-presenting it replays the stored rotation response
// verbatim (idempotent recovery for a lost response). Presenting it after the
// window is reuse: the enrollment is revoked and the caller gets 401.
//
// Routes are worker-internal; index.ts decides which public routes forward
// here. `/internal/validate` is how the worker turns a device bearer into a
// verified {accountId, enrollmentId} for routing.

import { DurableObject } from 'cloudflare:workers';

import {
  authErrorHttpStatus,
  type AccountDeleteResult,
  type AccountDeletionStatusResult,
  type AuthErrorCode,
  type DeviceListResult,
  type DeviceRenameResult,
  type DeviceRevokeResult,
  type DeviceSession,
  type DeviceSummary,
  type EnrollmentClass,
  type EnrollmentCodeIssueResult,
  type EnrollParams,
  type SessionDescribeResult,
  type SessionRefreshParams,
  type SessionRevokeParams,
  type SyncAccountStats,
} from '../../contract/auth';
import {
  generateDeviceToken,
  parseDeviceBearer,
  parseVerifiedAuth,
  type VerifiedAuth,
} from './auth';
import { sha256Hex } from './hash';
import {
  checkHostedAccess,
  resolveAccountEntitlement,
  ENTITLEMENT_CACHE_DDL,
} from './hosted/enforcement';
import type {
  ShareCreateResult,
  ShareFinalizeResult,
  ShareListResult,
  ShareRevokeResult,
  SharedArtifactDescriptor,
  SharedArtifactState,
} from '../../contract/shares';
import { verifyOidcPkceProof } from './oidc';
import { isRecord, rpcErrorResponse } from './rpc';
import { SESSION_SCHEMA } from './schema';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_GRACE_MS = 30 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_CODES_PER_ACCOUNT = 20;
// ENV-01 ephemeral enrollment bounds: cloud environments get their own
// active-session quota (device quota untouched) and a hard session TTL —
// an env that outlives its window stops authenticating even unreaped.
const MAX_EPHEMERAL_SESSIONS_PER_ACCOUNT = 20;
const EPHEMERAL_DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const EPHEMERAL_MAX_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const EPHEMERAL_MIN_SESSION_TTL_MS = 60 * 1000;
const MAX_PROVIDER_ID_CHARS = 128;
const MAX_DEVICE_NAME_CHARS = 128;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Revoked sessions are retained this long for audit, then swept (OPS-01). */
const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Hosted artifact sharing bounds (contract shares.ts).
const SHARE_UPLOAD_TTL_MS = 15 * 60 * 1000;
const SHARE_MAX_BYTES = 16 * 1024 * 1024;
const SHARE_ACCOUNT_MAX_BYTES = 256 * 1024 * 1024;
const SHARE_MAX_TITLE_BYTES = 256;
const SHARE_MAX_MEDIA_TYPE_CHARS = 128;
const SHARE_DEFAULT_EXPIRES_DAYS = 30;
const SHARE_MAX_EXPIRES_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionRow {
  enrollment_id: string;
  account_id: string;
  installation_id: string;
  display_name: string | null;
  credential_generation: number;
  access_token_hash: string;
  access_expires_at: number;
  refresh_token_hash: string;
  prev_refresh_token_hash: string | null;
  prev_refresh_grace_until: number | null;
  pending_rotated_session: string | null;
  revoked_at: number | null;
  [key: string]: string | number | null;
}

interface CodeRow {
  code_hash: string;
  account_id: string;
  expires_at: number;
  consumed_at: number | null;
  [key: string]: string | number | null;
}

interface SharedArtifactRow {
  share_id: string;
  account_id: string;
  enrollment_id: string;
  title: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  expires_in_days: number;
  state: string;
  r2_key: string;
  upload_expires_at: number;
  created_at: number;
  published_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  sealed: number;
  plaintext_bytes: number | null;
  [key: string]: string | number | null;
}

function authError(code: AuthErrorCode | 'unauthenticated' | 'throttled' | 'malformed-request') {
  const status =
    code === 'unauthenticated' || code === 'malformed-request'
      ? authErrorHttpStatus('invalid-proof')
      : code === 'throttled'
        ? 429
        : authErrorHttpStatus(code);
  return Response.json(
    { error: { code, retryable: code === 'throttled' } },
    { status: code === 'malformed-request' ? 400 : status },
  );
}

/**
 * Normalizes a user-entered code to the raw alphabet characters that are
 * hashed: drops the `anvil-ec-` prefix (if present), dashes, spaces, and case.
 */
function normalizeEnrollmentCode(code: string): string {
  return code
    .trim()
    .replace(/^anvil-ec-/i, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function generateEnrollmentCode(): { code: string; normalized: string } {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) {
    raw += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return {
    code: `anvil-ec-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`,
    normalized: raw,
  };
}

async function readJson(request: Request): Promise<unknown | null> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * ENV-01: an ephemeral session dies at its enrollment expiry — treated
 * exactly like a revoked row everywhere a liveness check runs. Returns
 * false for device-class rows (their expiry column stays NULL).
 */
function enrollmentExpired(row: SessionRow, now: number): boolean {
  const expires = row.enrollment_expires_at;
  return typeof expires === 'number' && expires <= now;
}

/**
 * Parses optional ENV-01 issuance fields from an enrollment-code request
 * body. Returns null on malformed input.
 */
function parseIssueOptions(body: Record<string, unknown>): {
  enrollmentClass: EnrollmentClass;
  provider: string | null;
  sessionTtlSeconds: number | null;
  environmentId: string | null;
} | null {
  const rawClass = body['enrollmentClass'];
  if (rawClass !== undefined && rawClass !== 'device' && rawClass !== 'ephemeral') {
    return null;
  }
  const enrollmentClass: EnrollmentClass = rawClass === 'ephemeral' ? 'ephemeral' : 'device';
  const provider = body['provider'];
  if (
    provider !== undefined &&
    (typeof provider !== 'string' || provider.length > MAX_PROVIDER_ID_CHARS)
  ) {
    return null;
  }
  const ttl = body['sessionTtlSeconds'];
  if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0)) {
    return null;
  }
  const environmentId = body['environmentId'];
  if (
    environmentId !== undefined &&
    (typeof environmentId !== 'string' || environmentId.length > MAX_PROVIDER_ID_CHARS)
  ) {
    return null;
  }
  return {
    enrollmentClass,
    provider: typeof provider === 'string' ? provider : null,
    sessionTtlSeconds: typeof ttl === 'number' ? ttl : null,
    environmentId: typeof environmentId === 'string' ? environmentId : null,
  };
}

export class SessionCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(SESSION_SCHEMA);
    // checkHostedAccess reuses the same DO-local cache table as the
    // account object; create it so write denial checks work here too.
    this.ctx.storage.sql.exec(ENTITLEMENT_CACHE_DDL);
    // E2E: additive columns for objects created before sealed shares existed.
    this.ensureColumn(
      'shared_artifacts',
      'sealed',
      'ALTER TABLE shared_artifacts ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0',
    );
    this.ensureColumn(
      'shared_artifacts',
      'plaintext_bytes',
      'ALTER TABLE shared_artifacts ADD COLUMN plaintext_bytes INTEGER',
    );
    // ENV-01: additive columns for objects created before enrollment
    // classes existed — existing rows read as 'device' via the defaults.
    this.ensureColumn(
      'device_sessions',
      'enrollment_class',
      "ALTER TABLE device_sessions ADD COLUMN enrollment_class TEXT NOT NULL DEFAULT 'device'",
    );
    this.ensureColumn(
      'device_sessions',
      'provider',
      'ALTER TABLE device_sessions ADD COLUMN provider TEXT',
    );
    this.ensureColumn(
      'device_sessions',
      'created_by',
      'ALTER TABLE device_sessions ADD COLUMN created_by TEXT',
    );
    this.ensureColumn(
      'device_sessions',
      'enrollment_expires_at',
      'ALTER TABLE device_sessions ADD COLUMN enrollment_expires_at INTEGER',
    );
    this.ensureColumn(
      'device_sessions',
      'environment_id',
      'ALTER TABLE device_sessions ADD COLUMN environment_id TEXT',
    );
    this.ensureColumn(
      'enrollment_codes',
      'enrollment_class',
      "ALTER TABLE enrollment_codes ADD COLUMN enrollment_class TEXT NOT NULL DEFAULT 'device'",
    );
    this.ensureColumn(
      'enrollment_codes',
      'provider',
      'ALTER TABLE enrollment_codes ADD COLUMN provider TEXT',
    );
    this.ensureColumn(
      'enrollment_codes',
      'session_ttl_ms',
      'ALTER TABLE enrollment_codes ADD COLUMN session_ttl_ms INTEGER',
    );
    this.ensureColumn(
      'enrollment_codes',
      'environment_id',
      'ALTER TABLE enrollment_codes ADD COLUMN environment_id TEXT',
    );
  }

  /** Adds a column to an existing DO SQLite table when it is missing. */
  private ensureColumn(table: string, name: string, ddl: string): void {
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => row.name);
    if (!columns.includes(name)) {
      this.ctx.storage.sql.exec(ddl);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
    // Mutating routes run under blockConcurrencyWhile: Durable Objects
    // interleave requests at await points, and the refresh/grace/revoke
    // decisions must not observe a half-rotated row.
    try {
      switch (route) {
        case 'POST /enroll': {
          const response = await this.ctx.blockConcurrencyWhile(() => this.handleEnroll(request));
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /session/refresh': {
          const response = await this.ctx.blockConcurrencyWhile(() => this.handleRefresh(request));
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /session/revoke': {
          const response = await this.ctx.blockConcurrencyWhile(() => this.handleRevoke(request));
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /enrollment-codes': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleIssueCode(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/validate':
          return await this.handleValidate(request);
        case 'POST /internal/resolve-device':
          return await this.handleResolveDevice(request);
        case 'POST /internal/issue-enrollment-code': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleInternalIssueCode(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'GET /internal/deletion-state':
          return this.handleDeletionState(url);
        case 'POST /internal/describe':
          return await this.handleDescribe(request);
        case 'POST /internal/device-list':
          return await this.handleDeviceList(request);
        case 'POST /internal/device-rename':
          return await this.ctx.blockConcurrencyWhile(() => this.handleDeviceRename(request));
        case 'POST /internal/device-revoke': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleDeviceRevoke(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        // BILL-04 website channel: the worker's /internal/hosted/* surface
        // already verified the service signature and resolved the billing
        // account's sync_account_id, so these routes take an explicit
        // accountId and never see a caller session. Reachable only through
        // stub.fetch — index.ts routes no public traffic here.
        case 'POST /internal/device-list-for-account':
          return await this.handleDeviceListForAccount(request);
        case 'POST /internal/device-rename-for-account':
          return await this.ctx.blockConcurrencyWhile(() =>
            this.handleDeviceRenameForAccount(request),
          );
        case 'POST /internal/device-revoke-for-account': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleDeviceRevokeForAccount(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/account-delete': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleAccountDelete(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/delete-account-by-id': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleDeleteAccountById(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/account-deletion-status': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleAccountDeletionStatus(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        // Hosted artifact sharing: the device-facing share.* ops arrive
        // here with worker-verified identity headers (index.ts), the byte
        // upload streams into R2 on PUT /v1/shared/{shareId}, and the
        // website's signed service channel resolves published shares via
        // /internal/shared-artifact.
        case 'POST /internal/share-create': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleShareCreate(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/share-finalize':
          return await this.handleShareFinalize(request);
        case 'POST /internal/share-list':
          return await this.handleShareList(request);
        case 'POST /internal/share-revoke': {
          const response = await this.ctx.blockConcurrencyWhile(() =>
            this.handleShareRevoke(request),
          );
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/shared-artifact':
          return await this.handleSharedArtifactRead(request);
        case 'POST /internal/sweep':
          return Response.json(await this.runSweep(Date.now()));
        default: {
          // Share byte uploads stream straight into R2 under a reservation;
          // they never fit the POST-route switch above.
          const shareUploadMatch = /^\/v1\/shared\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
          if (request.method === 'PUT' && shareUploadMatch !== null) {
            return await this.handleShareUpload(request, shareUploadMatch[1] as string);
          }
          return rpcErrorResponse(undefined, 'not-found');
        }
      }
    } catch {
      return rpcErrorResponse(undefined, 'unavailable');
    }
  }

  /** The account object's epoch + OPS-01 stats (creating it lazily). */
  private async accountMeta(
    accountId: string,
  ): Promise<{ epoch: string; stats?: SyncAccountStats }> {
    const id = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(id);
    const response = await stub.fetch('https://internal.anvil/internal/meta');
    const payload = (await response.json()) as { epoch?: unknown; stats?: SyncAccountStats };
    if (typeof payload.epoch !== 'string') {
      throw new Error('account object returned no epoch');
    }
    return { epoch: payload.epoch, stats: payload.stats };
  }

  private async datasetEpoch(accountId: string): Promise<string> {
    return (await this.accountMeta(accountId)).epoch;
  }

  private sessionByEnrollment(enrollmentId: string): SessionRow | null {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM device_sessions WHERE enrollment_id = ?', enrollmentId)
      .toArray();
    return (rows[0] as SessionRow | undefined) ?? null;
  }

  private sessionByAccessHash(hash: string): SessionRow | null {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM device_sessions WHERE access_token_hash = ?', hash)
      .toArray();
    return (rows[0] as SessionRow | undefined) ?? null;
  }

  private toDeviceSession(
    row: SessionRow,
    tokens: { accessToken: string; refreshToken: string; accessExpiresAt: number },
    epoch: string,
  ): DeviceSession {
    const session: DeviceSession = {
      accessToken: tokens.accessToken,
      accessExpiresAt: new Date(tokens.accessExpiresAt).toISOString(),
      refreshToken: tokens.refreshToken,
      credentialGeneration: row.credential_generation,
      enrollmentId: row.enrollment_id,
      accountId: row.account_id,
      datasetEpoch: epoch,
    };
    if (row.display_name !== null) {
      session.displayName = row.display_name;
    }
    const enrollmentClass = row.enrollment_class as EnrollmentClass | null;
    if (enrollmentClass !== null && enrollmentClass !== 'device') {
      session.enrollmentClass = enrollmentClass;
      if (row.enrollment_expires_at !== null) {
        session.enrollmentExpiresAt = new Date(row.enrollment_expires_at).toISOString();
      }
    }
    if (typeof row.environment_id === 'string') {
      session.environmentId = row.environment_id;
    }
    return session;
  }

  private async issueTokens(
    enrollmentId: string,
    accountId: string,
    installationId: string,
    displayName: string | null,
    options?: {
      enrollmentClass?: EnrollmentClass;
      provider?: string | null;
      createdBy?: string | null;
      enrollmentExpiresAt?: number | null;
      environmentId?: string | null;
    },
  ): Promise<DeviceSession> {
    const accessToken = generateDeviceToken('at');
    const refreshToken = generateDeviceToken('rt');
    const now = Date.now();
    const accessExpiresAt = now + ACCESS_TTL_MS;
    const [accessHash, refreshHash] = await Promise.all([
      sha256Hex(accessToken),
      sha256Hex(refreshToken),
    ]);
    this.ctx.storage.sql.exec(
      `INSERT INTO device_sessions (
        enrollment_id, account_id, installation_id, display_name,
        credential_generation, access_token_hash, access_expires_at,
        refresh_token_hash, prev_refresh_token_hash, prev_refresh_grace_until,
        pending_rotated_session, revoked_at, created_at,
        enrollment_class, provider, created_by, enrollment_expires_at,
        environment_id
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      enrollmentId,
      accountId,
      installationId,
      displayName,
      accessHash,
      accessExpiresAt,
      refreshHash,
      now,
      options?.enrollmentClass ?? 'device',
      options?.provider ?? null,
      options?.createdBy ?? null,
      options?.enrollmentExpiresAt ?? null,
      options?.environmentId ?? null,
    );
    const row = this.sessionByEnrollment(enrollmentId);
    if (row === null) {
      throw new Error('session insert failed');
    }
    const epoch = await this.datasetEpoch(accountId);
    return this.toDeviceSession(row, { accessToken, refreshToken, accessExpiresAt }, epoch);
  }

  private async handleEnroll(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || !isRecord(body['proof']) || typeof body['installationId'] !== 'string') {
      return authError('malformed-request');
    }
    const params = body as unknown as EnrollParams;
    const proof = params.proof;
    const displayName = typeof params.displayName === 'string' ? params.displayName : null;
    const now = Date.now();

    let accountId: string;
    // ENV-01: fields carried by a class-bound enrollment code.
    let codeClass: EnrollmentClass = 'device';
    let codeProvider: string | null = null;
    let codeSessionTtlMs: number | null = null;
    let codeIssuedBy: string | null = null;
    let codeEnvironmentId: string | null = null;
    if (proof.method === 'enrollment-code') {
      if (typeof proof.code !== 'string' || proof.code.length === 0) {
        return authError('invalid-proof');
      }
      const codeHash = await sha256Hex(normalizeEnrollmentCode(proof.code));
      const consumed = this.ctx.storage.transactionSync(() => {
        const rows = this.ctx.storage.sql
          .exec('SELECT * FROM enrollment_codes WHERE code_hash = ?', codeHash)
          .toArray();
        const row = rows[0] as CodeRow | undefined;
        if (row === undefined || row.consumed_at !== null || row.expires_at <= now) {
          return null;
        }
        this.ctx.storage.sql.exec(
          'UPDATE enrollment_codes SET consumed_at = ? WHERE code_hash = ?',
          now,
          codeHash,
        );
        return row;
      });
      if (consumed === null) {
        return authError('enrollment-code-used');
      }
      accountId = consumed.account_id;
      // ENV-01: the code binds the session class — an 'ephemeral' code can
      // only mint an ephemeral environment session; the caller cannot
      // upgrade itself to a durable device by presenting it differently.
      codeClass = (consumed.enrollment_class as EnrollmentClass | null) ?? 'device';
      codeProvider = consumed.provider as string | null;
      codeSessionTtlMs = consumed.session_ttl_ms as number | null;
      codeIssuedBy = consumed.issued_by as string | null;
      codeEnvironmentId = consumed.environment_id as string | null;
    } else if (proof.method === 'oidc-pkce') {
      const issuer = this.env.OIDC_ISSUER;
      const clientId = this.env.OIDC_CLIENT_ID;
      if (typeof issuer !== 'string' || typeof clientId !== 'string') {
        return authError('invalid-proof');
      }
      const sub = await verifyOidcPkceProof(proof, { issuer, clientId });
      if (sub === null) {
        return authError('invalid-proof');
      }
      accountId = `oidc_${await sha256Hex(`${issuer.replace(/\/+$/, '')}:${sub}`)}`;
      // Recreated accounts get a new internal identity (spec §140): when
      // the derived accountId is tombstoned, walk to the next generation
      // (`oidc_X~2`, `oidc_X~3`, …). Each dead generation's tombstone keeps
      // its stale clients locked out; the new generation is a fresh
      // account object with its own epoch.
      if (this.deletionRow(accountId) !== null) {
        const base = accountId;
        for (let generation = 2; ; generation += 1) {
          const candidate = `${base}~${generation}`;
          if (this.deletionRow(candidate) === null) {
            accountId = candidate;
            break;
          }
        }
      }
    } else {
      return authError('invalid-proof');
    }
    // Codes bound to a tombstoned account die with it — a code issued
    // before deletion cannot enroll a session on dead state.
    if (proof.method === 'enrollment-code' && this.deletionRow(accountId) !== null) {
      return Response.json(
        {
          error: {
            code: 'forbidden',
            retryable: false,
            details: { reason: 'account-deleted' },
          },
        },
        { status: 403 },
      );
    }

    const enrollmentId = `enr_${crypto.randomUUID()}`;
    // Ephemeral environments get a hard enrollment lifetime — the session
    // stops authenticating past it even if the env itself is never reaped.
    const enrollmentExpiresAt =
      codeClass === 'ephemeral'
        ? now +
          Math.min(
            Math.max(codeSessionTtlMs ?? EPHEMERAL_DEFAULT_SESSION_TTL_MS, 0),
            EPHEMERAL_MAX_SESSION_TTL_MS,
          )
        : null;
    const session = await this.issueTokens(
      enrollmentId,
      accountId,
      params.installationId,
      displayName,
      {
        enrollmentClass: codeClass,
        provider: codeProvider,
        createdBy: codeIssuedBy,
        enrollmentExpiresAt,
        environmentId: codeEnvironmentId,
      },
    );
    return Response.json(session, { status: 200 });
  }

  /**
   * Rotating refresh with lost-response recovery. The current token rotates
   * normally. The superseded token stays redeemable for REFRESH_GRACE_MS and
   * replays the stored rotation response — a client whose response was lost
   * recovers the same credentials instead of being signed out. After the
   * window a superseded token is reuse: the enrollment is revoked.
   */
  private async handleRefresh(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['refreshToken'] !== 'string' ||
      typeof body['enrollmentId'] !== 'string'
    ) {
      return authError('malformed-request');
    }
    const params = body as unknown as SessionRefreshParams;
    const row = this.sessionByEnrollment(params.enrollmentId);
    if (row === null || row.revoked_at !== null || enrollmentExpired(row, Date.now())) {
      return authError('invalid-proof');
    }
    const now = Date.now();
    const presentedHash = await sha256Hex(params.refreshToken);

    if (
      row.prev_refresh_token_hash === presentedHash &&
      row.prev_refresh_grace_until !== null &&
      row.prev_refresh_grace_until > now &&
      row.pending_rotated_session !== null
    ) {
      // Idempotent replay of the rotation whose response may have been lost.
      return new Response(row.pending_rotated_session, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (row.refresh_token_hash !== presentedHash) {
      if (
        row.prev_refresh_token_hash === presentedHash &&
        (row.prev_refresh_grace_until === null || row.prev_refresh_grace_until <= now)
      ) {
        this.ctx.storage.sql.exec(
          'UPDATE device_sessions SET revoked_at = ? WHERE enrollment_id = ?',
          now,
          row.enrollment_id,
        );
        return authError('refresh-reuse-detected');
      }
      return authError('invalid-proof');
    }

    const accessToken = generateDeviceToken('at');
    const refreshToken = generateDeviceToken('rt');
    const accessExpiresAt = now + ACCESS_TTL_MS;
    const generation = row.credential_generation + 1;
    const [accessHash, refreshHash] = await Promise.all([
      sha256Hex(accessToken),
      sha256Hex(refreshToken),
    ]);
    const epoch = await this.datasetEpoch(row.account_id);
    const session: DeviceSession = {
      accessToken,
      accessExpiresAt: new Date(accessExpiresAt).toISOString(),
      refreshToken,
      credentialGeneration: generation,
      enrollmentId: row.enrollment_id,
      accountId: row.account_id,
      datasetEpoch: epoch,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
    };
    this.ctx.storage.sql.exec(
      `UPDATE device_sessions SET
        credential_generation = ?,
        access_token_hash = ?,
        access_expires_at = ?,
        refresh_token_hash = ?,
        prev_refresh_token_hash = ?,
        prev_refresh_grace_until = ?,
        pending_rotated_session = ?
      WHERE enrollment_id = ?`,
      generation,
      accessHash,
      accessExpiresAt,
      refreshHash,
      row.refresh_token_hash,
      now + REFRESH_GRACE_MS,
      JSON.stringify(session),
      row.enrollment_id,
    );
    return Response.json(session, { status: 200 });
  }

  private async handleRevoke(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['enrollmentId'] !== 'string') {
      return authError('malformed-request');
    }
    const params = body as unknown as SessionRevokeParams;
    const row = this.sessionByEnrollment(params.enrollmentId);
    if (row === null) {
      // Unknown enrollment: revoke is idempotent, report revoked.
      return Response.json({ revoked: true }, { status: 200 });
    }
    let authorized = false;
    if (typeof params.refreshToken === 'string') {
      const presentedHash = await sha256Hex(params.refreshToken);
      authorized =
        presentedHash === row.refresh_token_hash || presentedHash === row.prev_refresh_token_hash;
    }
    if (!authorized) {
      const bearer = parseDeviceBearer(request.headers.get('Authorization'));
      if (bearer !== null) {
        const bearerHash = await sha256Hex(bearer);
        authorized =
          bearerHash === row.access_token_hash &&
          row.revoked_at === null &&
          !enrollmentExpired(row, Date.now());
      }
    }
    if (!authorized) {
      return authError('unauthenticated');
    }
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE enrollment_id = ?',
      Date.now(),
      row.enrollment_id,
    );
    // Close live sockets on this enrollment (best effort — the account object
    // may be hibernating; validation still rejects its next request).
    try {
      const id = this.env.ACCOUNT.idFromName(row.account_id);
      await this.env.ACCOUNT.get(id).fetch('https://internal.anvil/internal/revoke-enrollment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollmentId: row.enrollment_id }),
      });
    } catch {
      // Socket cleanup is best effort; token validation is authoritative.
    }
    return Response.json({ revoked: true }, { status: 200 });
  }

  /**
   * Issues a single-use enrollment code. Two caller classes:
   * - deployment admin: `Bearer <env.ENROLLMENT_ADMIN_TOKEN>` with an explicit
   *   `accountId` in the body (bootstrap path for the first device);
   * - signed-in device: a valid `anvil_at_*` bearer; the code binds to that
   *   session's account for pairing another device.
   */
  private async handleIssueCode(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body)) {
      return authError('malformed-request');
    }
    const header = request.headers.get('Authorization');
    const adminToken = this.env.ENROLLMENT_ADMIN_TOKEN;
    let accountId: string;
    let issuedBy: string;
    if (
      typeof adminToken === 'string' &&
      adminToken.length > 0 &&
      header === `Bearer ${adminToken}`
    ) {
      if (typeof body['accountId'] !== 'string' || body['accountId'].length === 0) {
        return authError('malformed-request');
      }
      accountId = body['accountId'];
      issuedBy = 'admin';
    } else {
      const bearer = parseDeviceBearer(header);
      if (bearer === null) {
        return authError('unauthenticated');
      }
      const session = this.sessionByAccessHash(await sha256Hex(bearer));
      if (
        session === null ||
        session.revoked_at !== null ||
        session.access_expires_at <= Date.now() ||
        enrollmentExpired(session, Date.now())
      ) {
        return authError('unauthenticated');
      }
      // ENV-01: an ephemeral environment cannot mint trust — code issuance
      // is a device-class ability only.
      if (session.enrollment_class === 'ephemeral') {
        return Response.json(
          { error: { code: 'forbidden', retryable: false } },
          { status: 403 },
        );
      }
      accountId = session.account_id;
      issuedBy = session.enrollment_id;
    }
    const options = parseIssueOptions(body);
    if (options === null) {
      return authError('malformed-request');
    }
    const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : null;
    return this.issueCodeForAccount(accountId, displayName, issuedBy, options);
  }

  /**
   * Shared code-issuance path for every caller class: tombstoned accounts
   * are dead, live codes per account are capped, and only the SHA-256 of
   * the normalized code is stored. Callers own their auth checks.
   */
  private async issueCodeForAccount(
    accountId: string,
    displayName: string | null,
    issuedBy: string,
    options?: {
      enrollmentClass: EnrollmentClass;
      provider: string | null;
      sessionTtlSeconds: number | null;
      environmentId: string | null;
    },
  ): Promise<Response> {
    // A tombstoned accountId is permanently dead — deleted cloud state
    // cannot be recreated by issuing new enrollments for it.
    if (this.deletionRow(accountId) !== null) {
      return Response.json(
        {
          error: {
            code: 'forbidden',
            retryable: false,
            details: { reason: 'account-deleted' },
          },
        },
        { status: 403 },
      );
    }

    const now = Date.now();
    const active = this.ctx.storage.sql
      .exec(
        'SELECT COUNT(*) AS n FROM enrollment_codes WHERE account_id = ? AND consumed_at IS NULL AND expires_at > ?',
        accountId,
        now,
      )
      .toArray()[0] as { n: number } | undefined;
    if ((active?.n ?? 0) >= MAX_ACTIVE_CODES_PER_ACCOUNT) {
      return authError('throttled');
    }

    // ENV-01: ephemeral environments carry their own live-session quota —
    // separate from the device count so sandbox churn can't exhaust or
    // hide behind ordinary enrollments.
    if (options?.enrollmentClass === 'ephemeral') {
      const liveEnvs = this.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) AS n FROM device_sessions
           WHERE account_id = ? AND enrollment_class = 'ephemeral'
             AND revoked_at IS NULL
             AND (enrollment_expires_at IS NULL OR enrollment_expires_at > ?)`,
          accountId,
          now,
        )
        .toArray()[0] as { n: number } | undefined;
      if ((liveEnvs?.n ?? 0) >= MAX_EPHEMERAL_SESSIONS_PER_ACCOUNT) {
        return authError('throttled');
      }
    }

    const { code, normalized } = generateEnrollmentCode();
    const codeHash = await sha256Hex(normalized);
    const sessionTtlMs =
      options?.enrollmentClass === 'ephemeral' && options.sessionTtlSeconds !== null
        ? Math.min(
            Math.max(options.sessionTtlSeconds * 1000, EPHEMERAL_MIN_SESSION_TTL_MS),
            EPHEMERAL_MAX_SESSION_TTL_MS,
          )
        : options?.enrollmentClass === 'ephemeral'
          ? EPHEMERAL_DEFAULT_SESSION_TTL_MS
          : null;
    this.ctx.storage.sql.exec(
      `INSERT INTO enrollment_codes
        (code_hash, account_id, issued_by, display_name, expires_at, consumed_at, created_at,
         enrollment_class, provider, session_ttl_ms, environment_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      codeHash,
      accountId,
      issuedBy,
      displayName,
      now + CODE_TTL_MS,
      now,
      options?.enrollmentClass ?? 'device',
      options?.provider ?? null,
      sessionTtlMs,
      // ENV-01: the binding only means anything on ephemeral codes.
      options?.enrollmentClass === 'ephemeral' ? (options?.environmentId ?? null) : null,
    );
    const result: EnrollmentCodeIssueResult = {
      code,
      expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
      accountId,
    };
    return Response.json(result, { status: 200 });
  }

  /**
   * BILL-01 hosted pairing: the worker's `/internal/hosted/*` channel has
   * already verified the service signature, so this handler trusts the
   * body-supplied accountId and never sees a device credential. Reachable
   * only through `stub.fetch` — index.ts routes no public traffic here.
   */
  private async handleInternalIssueCode(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['accountId'] !== 'string' ||
      body['accountId'].length === 0
    ) {
      return authError('malformed-request');
    }
    const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : null;
    const issuedBy =
      typeof body['issuedBy'] === 'string' && body['issuedBy'].length > 0
        ? body['issuedBy']
        : 'internal';
    const options = parseIssueOptions(body);
    if (options === null) {
      return authError('malformed-request');
    }
    return this.issueCodeForAccount(body['accountId'], displayName, issuedBy, options);
  }

  /** Worker-internal: is this accountId under a deletion tombstone? */
  private handleDeletionState(url: URL): Response {
    const accountId = url.searchParams.get('accountId');
    if (accountId === null || accountId.length === 0) {
      return authError('malformed-request');
    }
    return Response.json({ tombstoned: this.deletionRow(accountId) !== null });
  }

  /**
   * Worker-internal bearer → {accountId, enrollmentId} for the hosted link
   * route — same lookup as /internal/validate, reading the Authorization
   * header instead of a JSON body so the caller need not re-wrap the token.
   */
  private async handleResolveDevice(request: Request): Promise<Response> {
    const bearer = parseDeviceBearer(request.headers.get('Authorization'));
    if (bearer === null) {
      return authError('unauthenticated');
    }
    const row = this.sessionByAccessHash(await sha256Hex(bearer));
    if (
      row === null ||
      row.revoked_at !== null ||
      row.access_expires_at <= Date.now() ||
      enrollmentExpired(row, Date.now())
    ) {
      return authError('unauthenticated');
    }
    return Response.json(
      {
        accountId: row.account_id,
        enrollmentId: row.enrollment_id,
        enrollmentClass: row.enrollment_class ?? 'device',
        ...(typeof row.environment_id === 'string'
          ? { environmentId: row.environment_id }
          : {}),
      },
      { status: 200 },
    );
  }

  /** Worker-internal: bearer → verified identity for routing. */
  private async handleValidate(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['accessToken'] !== 'string') {
      return authError('malformed-request');
    }
    const hash = await sha256Hex(body['accessToken']);
    const row = this.sessionByAccessHash(hash);
    if (
      row === null ||
      row.revoked_at !== null ||
      row.access_expires_at <= Date.now() ||
      enrollmentExpired(row, Date.now())
    ) {
      return authError('unauthenticated');
    }
    // enrollmentClass + environmentId ride along so the worker can forward
    // them to the account object — ephemeral environments carry a
    // restricted op set and a bound environment record.
    return Response.json(
      {
        accountId: row.account_id,
        enrollmentId: row.enrollment_id,
        enrollmentClass: row.enrollment_class ?? 'device',
        ...(typeof row.environment_id === 'string'
          ? { environmentId: row.environment_id }
          : {}),
      },
      { status: 200 },
    );
  }

  /** `session.describe`: authenticated identity/epoch view, never tokens. */
  private async handleDescribe(request: Request): Promise<Response> {
    const verified = parseVerifiedAuth(request);
    const bearer = parseDeviceBearer(request.headers.get('Authorization'));
    let row: SessionRow | null = null;
    if (verified !== null) {
      row = this.sessionByEnrollment(verified.enrollmentId);
      if (row !== null && row.account_id !== verified.accountId) {
        row = null;
      }
    } else if (bearer !== null) {
      row = this.sessionByAccessHash(await sha256Hex(bearer));
    }
    if (
      row === null ||
      row.revoked_at !== null ||
      row.access_expires_at <= Date.now() ||
      enrollmentExpired(row, Date.now())
    ) {
      return authError('unauthenticated');
    }
    const meta = await this.accountMeta(row.account_id);
    // BILL-03: hosted deployments surface the account's entitlement so
    // clients can render access state. Resolution failure omits the field
    // rather than failing describe; self-host (no HOSTED_DB) omits it too.
    const entitlement =
      this.env.HOSTED_DB === undefined
        ? null
        : await resolveAccountEntitlement(this.env, row.account_id, Date.now()).catch(() => null);
    const result: SessionDescribeResult = {
      accountId: row.account_id,
      enrollmentId: row.enrollment_id,
      datasetEpoch: meta.epoch,
      credentialGeneration: row.credential_generation,
      accessExpiresAt: new Date(row.access_expires_at).toISOString(),
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      ...(row.enrollment_class === null || row.enrollment_class === 'device'
        ? {}
        : { enrollmentClass: row.enrollment_class as EnrollmentClass }),
      ...(row.enrollment_expires_at === null
        ? {}
        : { enrollmentExpiresAt: new Date(row.enrollment_expires_at).toISOString() }),
      ...(typeof row.environment_id === 'string' ? { environmentId: row.environment_id } : {}),
      ...(meta.stats === undefined ? {} : { accountStats: meta.stats }),
      ...(entitlement === null ? {} : { entitlement }),
    };
    return Response.json(result, { status: 200 });
  }

  /**
   * Verified-identity gate for `/internal/device-*` routes: the worker
   * already validated the bearer; this re-checks that the enrollment's
   * session row is live on the claimed account (fail-closed across a
   * revocation race). ENV-01: ephemeral environments may not manage
   * devices, shares, or the account — class is read from the authoritative
   * session row, never the forwarded header.
   */
  private verifiedCaller(request: Request): VerifiedAuth | null {
    const verified = parseVerifiedAuth(request);
    if (verified === null) return null;
    const row = this.sessionByEnrollment(verified.enrollmentId);
    if (
      row === null ||
      row.account_id !== verified.accountId ||
      row.revoked_at !== null ||
      row.enrollment_class === 'ephemeral' ||
      enrollmentExpired(row, Date.now())
    ) {
      return null;
    }
    return verified;
  }

  /**
   * Every session row on an account as a DeviceSummary list, revoked rows
   * included. `selfEnrollmentId` marks the caller's own row; callers with
   * no session (the website channel) pass null so no row is self.
   */
  private deviceListResult(accountId: string, selfEnrollmentId: string | null): DeviceListResult {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT enrollment_id, installation_id, display_name,
                credential_generation, revoked_at, created_at,
                enrollment_class, provider, enrollment_expires_at, environment_id
         FROM device_sessions WHERE account_id = ? ORDER BY created_at ASC`,
        accountId,
      )
      .toArray() as unknown as SessionRow[];
    const devices: DeviceSummary[] = rows.map((row) => ({
      enrollmentId: row.enrollment_id,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      installationId: row.installation_id,
      credentialGeneration: row.credential_generation,
      revoked: row.revoked_at !== null,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      self: row.enrollment_id === selfEnrollmentId,
      ...(row.enrollment_class === null || row.enrollment_class === 'device'
        ? {}
        : { enrollmentClass: row.enrollment_class as EnrollmentClass }),
      ...(typeof row.provider === 'string' ? { provider: row.provider } : {}),
      ...(row.enrollment_expires_at === null
        ? {}
        : { enrollmentExpiresAt: new Date(row.enrollment_expires_at).toISOString() }),
      ...(typeof row.environment_id === 'string' ? { environmentId: row.environment_id } : {}),
    }));
    return { devices };
  }

  /** `device.list` — every session on the caller's account, revoked included. */
  private async handleDeviceList(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const result = this.deviceListResult(caller.accountId, caller.enrollmentId);
    return Response.json(result, { status: 200 });
  }

  /**
   * BILL-04: `/internal/hosted/devices` backend — the accountId arrives in
   * the verified body, so the list is identical to `device.list` except no
   * row can be `self` (the website user holds no enrollment).
   */
  private async handleDeviceListForAccount(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['accountId'] !== 'string' ||
      body['accountId'].length === 0
    ) {
      return authError('malformed-request');
    }
    return Response.json(this.deviceListResult(body['accountId'], null), { status: 200 });
  }

  /**
   * Shared rename: any session on the account may be renamed, live or
   * revoked. Unknown enrollments and cross-account rows are not-found.
   */
  private renameDeviceOnAccount(
    accountId: string,
    enrollmentId: string,
    displayName: string,
  ): Response {
    const row = this.sessionByEnrollment(enrollmentId);
    if (row === null || row.account_id !== accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET display_name = ? WHERE enrollment_id = ?',
      displayName.length === 0 ? null : displayName,
      row.enrollment_id,
    );
    const result: DeviceRenameResult = { renamed: true, enrollmentId: row.enrollment_id };
    return Response.json(result, { status: 200 });
  }

  /** `device.rename` — account-scoped; works on live or revoked rows. */
  private async handleDeviceRename(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['enrollmentId'] !== 'string' ||
      typeof body['displayName'] !== 'string' ||
      body['displayName'].length > MAX_DEVICE_NAME_CHARS
    ) {
      return authError('malformed-request');
    }
    return this.renameDeviceOnAccount(caller.accountId, body['enrollmentId'], body['displayName']);
  }

  /**
   * BILL-04: `/internal/hosted/device-rename` backend — identical scoping
   * rule (the enrollment must live on the account) with the accountId taken
   * from the verified body instead of a caller session.
   */
  private async handleDeviceRenameForAccount(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['accountId'] !== 'string' ||
      body['accountId'].length === 0 ||
      typeof body['enrollmentId'] !== 'string' ||
      typeof body['displayName'] !== 'string' ||
      body['displayName'].length > MAX_DEVICE_NAME_CHARS
    ) {
      return authError('malformed-request');
    }
    return this.renameDeviceOnAccount(body['accountId'], body['enrollmentId'], body['displayName']);
  }

  /**
   * Shared revocation: the session row flips `revoked_at` (idempotent via
   * COALESCE); the account object then closes the enrollment's sockets and
   * revokes its worker record (best effort — token validation is
   * authoritative). Unknown or cross-account enrollments are not-found.
   */
  private async revokeDeviceOnAccount(accountId: string, enrollmentId: string): Promise<Response> {
    const row = this.sessionByEnrollment(enrollmentId);
    if (row === null || row.account_id !== accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE enrollment_id = ?',
      Date.now(),
      row.enrollment_id,
    );
    try {
      const id = this.env.ACCOUNT.idFromName(row.account_id);
      await this.env.ACCOUNT.get(id).fetch('https://internal.anvil/internal/revoke-enrollment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enrollmentId: row.enrollment_id }),
      });
    } catch {
      // Socket cleanup is best effort; the revoked session row is authoritative.
    }
    const result: DeviceRevokeResult = { revoked: true, enrollmentId: row.enrollment_id };
    return Response.json(result, { status: 200 });
  }

  /**
   * `device.revoke` — account-scoped revocation: any live session on the
   * account may revoke any other (or itself — a remote sign-out).
   */
  private async handleDeviceRevoke(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['enrollmentId'] !== 'string') {
      return authError('malformed-request');
    }
    return this.revokeDeviceOnAccount(caller.accountId, body['enrollmentId']);
  }

  /**
   * BILL-04: `/internal/hosted/device-revoke` backend — the website user is
   * the account owner, so any enrollment on the account may be revoked;
   * there is no caller session to spare from revocation.
   */
  private async handleDeviceRevokeForAccount(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['accountId'] !== 'string' ||
      body['accountId'].length === 0 ||
      typeof body['enrollmentId'] !== 'string'
    ) {
      return authError('malformed-request');
    }
    return this.revokeDeviceOnAccount(body['accountId'], body['enrollmentId']);
  }

  // ---- hosted artifact shares ------------------------------------------
  // The shared_artifacts row is the state authority; the R2 object at
  // r2_key is reconciled against it. Uploads stream under a reservation,
  // finalize verifies size + sha256 before publish, and every public read
  // re-checks state/expiry/revocation — a share URL never outlives
  // revocation. Rows live here (not the account object) so the website
  // channel can resolve a share id without knowing the accountId.

  private readShare(shareId: string): SharedArtifactRow | null {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM shared_artifacts WHERE share_id = ?', shareId)
      .toArray();
    return (rows[0] as SharedArtifactRow | undefined) ?? null;
  }

  private shareDescriptor(row: SharedArtifactRow): SharedArtifactDescriptor {
    return {
      shareId: row.share_id,
      title: row.title,
      mediaType: row.media_type,
      byteLength: row.byte_length,
      sha256: row.sha256,
      state: row.state as SharedArtifactState,
      createdAt: new Date(row.created_at).toISOString(),
      publishedAt: row.published_at === null ? null : new Date(row.published_at).toISOString(),
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
      sealed: row.sealed === 1,
      ...(row.plaintext_bytes === null ? {} : { plaintextBytes: row.plaintext_bytes }),
    };
  }

  /**
   * Lazy expiry for one share: `uploaded`/`published` rows past their
   * deadline become `expired` and the R2 object is deleted best-effort.
   * Reserved rows lapse via the sweep's orphan cleanup instead.
   */
  private async expireShareIfDue(row: SharedArtifactRow, now: number): Promise<SharedArtifactRow> {
    if (
      (row.state === 'published' || row.state === 'uploaded') &&
      row.expires_at !== null &&
      row.expires_at <= now
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE shared_artifacts SET state = 'expired' WHERE share_id = ?",
        row.share_id,
      );
      row.state = 'expired';
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
    }
    return row;
  }

  /** Streams + verifies an R2 object's sha256 without buffering it whole. */
  private async readShareObjectDigest(
    r2Key: string,
  ): Promise<{ size: number; sha256: string } | null> {
    const obj = await this.env.ARTIFACTS.get(r2Key);
    if (obj === null) {
      return null;
    }
    if (typeof crypto.DigestStream === 'function' && obj.body !== null) {
      const stream = new crypto.DigestStream('SHA-256');
      await obj.body.pipeTo(stream);
      const digest = await stream.digest;
      const bytes = new Uint8Array(digest);
      let hex = '';
      for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0');
      }
      return { size: obj.size, sha256: hex };
    }
    const bytes = await obj.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const byte of digest) {
      hex += byte.toString(16).padStart(2, '0');
    }
    return { size: obj.size, sha256: hex };
  }

  /**
   * `share.create` (user actor): a byte-length + sha256 reservation under
   * per-share and per-account quotas. Returns the bounded upload route and
   * its expiry; the R2 key is `shared/{shareId}`.
   */
  private async handleShareCreate(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['title'] !== 'string' ||
      body['title'].length === 0 ||
      new TextEncoder().encode(body['title']).byteLength > SHARE_MAX_TITLE_BYTES ||
      typeof body['mediaType'] !== 'string' ||
      !/^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(body['mediaType']) ||
      body['mediaType'].length > SHARE_MAX_MEDIA_TYPE_CHARS ||
      typeof body['byteLength'] !== 'number' ||
      !Number.isInteger(body['byteLength']) ||
      body['byteLength'] < 1 ||
      body['byteLength'] > SHARE_MAX_BYTES ||
      typeof body['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(body['sha256']) ||
      (body['expiresInDays'] !== undefined &&
        (typeof body['expiresInDays'] !== 'number' ||
          !Number.isInteger(body['expiresInDays']) ||
          body['expiresInDays'] < 1 ||
          body['expiresInDays'] > SHARE_MAX_EXPIRES_DAYS)) ||
      (body['sealed'] !== undefined && typeof body['sealed'] !== 'boolean') ||
      (body['plaintextBytes'] !== undefined &&
        (typeof body['plaintextBytes'] !== 'number' ||
          !Number.isInteger(body['plaintextBytes']) ||
          body['plaintextBytes'] < 1))
    ) {
      return authError('malformed-request');
    }
    const now = Date.now();
    if (this.deletionRow(caller.accountId) !== null) {
      return Response.json(
        { error: { code: 'forbidden', retryable: false, details: { reason: 'account-deleted' } } },
        { status: 403 },
      );
    }
    // BILL-03: share.create is mutating — a restricted account must not
    // land new billable bytes.
    const access = await checkHostedAccess(this.ctx.storage, this.env, caller.accountId, now);
    if (!access.allowed) {
      return Response.json(
        { error: { code: 'forbidden', retryable: false, details: { reason: access.reason } } },
        { status: 403 },
      );
    }
    const used = this.ctx.storage.sql
      .exec(
        `SELECT COALESCE(SUM(byte_length), 0) AS total FROM shared_artifacts
         WHERE account_id = ? AND state NOT IN ('revoked', 'expired')`,
        caller.accountId,
      )
      .toArray()[0] as { total: number } | undefined;
    if ((used?.total ?? 0) + body['byteLength'] > SHARE_ACCOUNT_MAX_BYTES) {
      return Response.json(
        {
          error: {
            code: 'quota-exceeded',
            retryable: false,
            details: {
              reason: 'account-share-bytes',
              limitBytes: SHARE_ACCOUNT_MAX_BYTES,
              usedBytes: used?.total ?? 0,
            },
          },
        },
        { status: 403 },
      );
    }
    const shareId = `shr_${crypto.randomUUID()}`;
    const uploadExpiresAt = now + SHARE_UPLOAD_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO shared_artifacts (
         share_id, account_id, enrollment_id, title, media_type, byte_length,
         sha256, expires_in_days, state, r2_key, upload_expires_at,
         created_at, published_at, expires_at, revoked_at, sealed, plaintext_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      shareId,
      caller.accountId,
      caller.enrollmentId,
      body['title'],
      body['mediaType'],
      body['byteLength'],
      body['sha256'],
      body['expiresInDays'] ?? SHARE_DEFAULT_EXPIRES_DAYS,
      `shared/${shareId}`,
      uploadExpiresAt,
      now,
      body['sealed'] === true ? 1 : 0,
      typeof body['plaintextBytes'] === 'number' ? body['plaintextBytes'] : null,
    );
    const result: ShareCreateResult = {
      shareId,
      uploadPath: `/v1/shared/${shareId}`,
      expiresAt: new Date(uploadExpiresAt).toISOString(),
    };
    return Response.json(result, { status: 200 });
  }

  /**
   * Streams a share reservation's bytes into R2. Same rule as artifact
   * uploads: `content-length` must equal the reservation so the body
   * streams straight into R2, and the stored size is verified after write.
   */
  private async handleShareUpload(request: Request, shareId: string): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const now = Date.now();
    const access = await checkHostedAccess(this.ctx.storage, this.env, caller.accountId, now);
    if (!access.allowed) {
      return Response.json(
        { error: { code: 'forbidden', retryable: false, details: { reason: access.reason } } },
        { status: 403 },
      );
    }
    const row = this.readShare(shareId);
    if (row === null || row.account_id !== caller.accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    if (row.state !== 'reserved') {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'share-not-reserved' });
    }
    if (row.upload_expires_at <= now) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'reservation-expired' });
    }
    const declared = Number(request.headers.get('content-length') ?? 'NaN');
    if (!Number.isFinite(declared) || declared !== row.byte_length) {
      return rpcErrorResponse(undefined, 'conflict', {
        reason: 'size-mismatch',
        expected: row.byte_length,
      });
    }
    if (request.body === null) {
      return rpcErrorResponse(undefined, 'malformed-request');
    }
    let stored: R2Object;
    try {
      stored = await this.env.ARTIFACTS.put(row.r2_key, request.body, {
        httpMetadata: { contentType: row.media_type },
      });
    } catch {
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
      return rpcErrorResponse(undefined, 'unavailable', { reason: 'share-upload-failed' });
    }
    if (stored.size !== row.byte_length) {
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
      return rpcErrorResponse(undefined, 'conflict', {
        reason: 'size-mismatch',
        expected: row.byte_length,
        actual: stored.size,
      });
    }
    this.ctx.storage.sql.exec(
      "UPDATE shared_artifacts SET state = 'uploaded' WHERE share_id = ? AND state = 'reserved'",
      shareId,
    );
    return Response.json({ shareId, byteLength: stored.size, state: 'uploaded' });
  }

  /**
   * `share.finalize` (user actor): verifies the stored R2 object against
   * the reservation and publishes. A verification mismatch discards the
   * object and the row — mismatched bytes are never published.
   */
  private async handleShareFinalize(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['shareId'] !== 'string' ||
      typeof body['byteLength'] !== 'number' ||
      typeof body['sha256'] !== 'string'
    ) {
      return authError('malformed-request');
    }
    const row = this.readShare(body['shareId']);
    if (row === null || row.account_id !== caller.accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    if (row.state !== 'reserved' && row.state !== 'uploaded') {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'share-state', state: row.state });
    }
    if (body['byteLength'] !== row.byte_length || body['sha256'] !== row.sha256) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'manifest-mismatch' });
    }
    // E2E: a declared seal flag must agree with the reservation — the bytes
    // being finalized cannot silently change protection class.
    if (
      body['sealed'] !== undefined &&
      (typeof body['sealed'] !== 'boolean' || body['sealed'] !== (row.sealed === 1))
    ) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'manifest-mismatch' });
    }
    const probe = await this.readShareObjectDigest(row.r2_key);
    if (probe === null) {
      return rpcErrorResponse(undefined, 'conflict', { reason: 'share-not-uploaded' });
    }
    if (probe.size !== row.byte_length || probe.sha256 !== row.sha256) {
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
      this.ctx.storage.sql.exec('DELETE FROM shared_artifacts WHERE share_id = ?', row.share_id);
      return rpcErrorResponse(undefined, 'conflict', { reason: 'checksum-mismatch' });
    }
    const now = Date.now();
    const expiresAt = now + row.expires_in_days * DAY_MS;
    this.ctx.storage.sql.exec(
      `UPDATE shared_artifacts
       SET state = 'published', published_at = ?, expires_at = ?
       WHERE share_id = ?`,
      now,
      expiresAt,
      row.share_id,
    );
    const fresh = this.readShare(row.share_id);
    const result: ShareFinalizeResult = {
      share: this.shareDescriptor(
        fresh ?? { ...row, state: 'published', published_at: now, expires_at: expiresAt },
      ),
    };
    return Response.json(result, { status: 200 });
  }

  /** `share.list` (user actor): the caller account's shares, newest first. */
  private async handleShareList(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    const stateFilter = isRecord(body) && typeof body['state'] === 'string' ? body['state'] : null;
    const limit =
      isRecord(body) && typeof body['limit'] === 'number' && Number.isInteger(body['limit'])
        ? Math.min(Math.max(body['limit'], 1), 100)
        : 50;
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT * FROM shared_artifacts
         WHERE account_id = ?
         ORDER BY created_at DESC, share_id ASC LIMIT ?`,
        caller.accountId,
        Math.min(limit * 2, 200),
      )
      .toArray() as SharedArtifactRow[];
    const shares: SharedArtifactDescriptor[] = [];
    for (const row of rows) {
      const fresh = await this.expireShareIfDue(row, now);
      if (stateFilter !== null && fresh.state !== stateFilter) continue;
      shares.push(this.shareDescriptor(fresh));
      if (shares.length >= limit) break;
    }
    const result: ShareListResult = { shares };
    return Response.json(result, { status: 200 });
  }

  /**
   * `share.revoke` (user actor): published → revoked; in-flight
   * reservations lapse to `expired`. Terminal rows return as-is so the op
   * is idempotent. The R2 object is deleted best-effort.
   */
  private async handleShareRevoke(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['shareId'] !== 'string') {
      return authError('malformed-request');
    }
    const row = this.readShare(body['shareId']);
    if (row === null || row.account_id !== caller.accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    const now = Date.now();
    if (row.state === 'published') {
      this.ctx.storage.sql.exec(
        "UPDATE shared_artifacts SET state = 'revoked', revoked_at = ? WHERE share_id = ?",
        now,
        row.share_id,
      );
      row.state = 'revoked';
      row.revoked_at = now;
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
    } else if (row.state === 'reserved' || row.state === 'uploaded') {
      this.ctx.storage.sql.exec(
        "UPDATE shared_artifacts SET state = 'expired' WHERE share_id = ?",
        row.share_id,
      );
      row.state = 'expired';
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
    }
    const result: ShareRevokeResult = { share: this.shareDescriptor(row) };
    return Response.json(result, { status: 200 });
  }

  /**
   * `/internal/shared-artifact` — the website's signed service channel
   * resolves a share id to streamed bytes plus metadata headers. Every
   * read re-enforces state, expiry, and revocation; nothing here is a
   * long-lived public bearer.
   */
  private async handleSharedArtifactRead(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['shareId'] !== 'string') {
      return authError('malformed-request');
    }
    const now = Date.now();
    let row = this.readShare(body['shareId']);
    if (row === null) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    row = await this.expireShareIfDue(row, now);
    if (row.state !== 'published') {
      return rpcErrorResponse(undefined, 'not-found');
    }
    const obj = await this.env.ARTIFACTS.get(row.r2_key);
    if (obj === null) {
      return rpcErrorResponse(undefined, 'unavailable', { reason: 'share-object-missing' });
    }
    const headers = new Headers();
    headers.set('content-type', row.media_type);
    headers.set('content-length', String(row.byte_length));
    headers.set('x-anvil-share-id', row.share_id);
    headers.set('x-anvil-share-title', encodeURIComponent(row.title));
    headers.set('x-anvil-share-state', row.state);
    if (row.sealed === 1) {
      headers.set('x-anvil-share-sealed', '1');
      headers.set('x-anvil-share-sha256', row.sha256);
      if (row.plaintext_bytes !== null) {
        headers.set('x-anvil-share-plaintext-bytes', String(row.plaintext_bytes));
      }
    }
    if (row.published_at !== null) {
      headers.set('x-anvil-share-published-at', new Date(row.published_at).toISOString());
    }
    if (row.expires_at !== null) {
      headers.set('x-anvil-share-expires-at', new Date(row.expires_at).toISOString());
    }
    headers.set('cache-control', 'private, no-store');
    return new Response(obj.body, { headers });
  }

  /** Purges every share row + R2 object for a deleted account. */
  private async purgeAccountShares(accountId: string): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec('SELECT share_id, r2_key FROM shared_artifacts WHERE account_id = ?', accountId)
      .toArray() as { share_id: string; r2_key: string }[];
    for (const row of rows) {
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
    }
    this.ctx.storage.sql.exec('DELETE FROM shared_artifacts WHERE account_id = ?', accountId);
  }

  // ---- account deletion (spec §140) ------------------------------------
  //
  // The session object is the identity directory: it owns the durable
  // tombstone (`account_deletions`) that outlives the account object's
  // purge, blocks enrollment-code issuance for the dead id, and carries
  // the deletion generation so a restore cannot revive authority.
  // Order is fixed: tombstone, then revoke every session on the account,
  // then drive the account object's retryable purge.

  private deletionRow(accountId: string): {
    account_id: string;
    deletion_generation: number;
    started_at: number;
    deleted_at: number | null;
  } | null {
    return (
      (this.ctx.storage.sql
        .exec('SELECT * FROM account_deletions WHERE account_id = ?', accountId)
        .toArray()[0] as
        | {
            account_id: string;
            deletion_generation: number;
            started_at: number;
            deleted_at: number | null;
          }
        | undefined) ?? null
    );
  }

  /**
   * Drives one purge pass on the account object and folds the result back
   * into the tombstone. Unreachable objects are not failures — the account
   * object's alarm and this object's sweep re-drive until `deleted`.
   */
  private async driveAccountPurge(
    accountId: string,
  ): Promise<{ state: 'deleting' | 'deleted'; purgedRows?: number }> {
    try {
      const id = this.env.ACCOUNT.idFromName(accountId);
      const response = await this.env.ACCOUNT.get(id).fetch(
        'https://internal.anvil/internal/delete-account',
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => null)) as {
        state?: string;
        purgedRows?: number;
      } | null;
      if (response.ok && (body?.state === 'deleted' || body?.state === 'deleting')) {
        if (body.state === 'deleted') {
          this.ctx.storage.sql.exec(
            'UPDATE account_deletions SET deleted_at = COALESCE(deleted_at, ?) WHERE account_id = ?',
            Date.now(),
            accountId,
          );
        }
        return {
          state: body.state,
          ...(body.purgedRows === undefined ? {} : { purgedRows: body.purgedRows }),
        };
      }
    } catch {
      // Fall through: 'deleting' — the account object's alarm re-drives.
    }
    return { state: 'deleting' };
  }

  /**
   * Read-only status probe — unlike `driveAccountPurge` this never advances
   * the purge; used when the tombstone is already terminal.
   */
  private async readAccountDeletionStatus(
    accountId: string,
  ): Promise<{ state: 'none' | 'deleting' | 'deleted'; purgedRows?: number } | null> {
    try {
      const id = this.env.ACCOUNT.idFromName(accountId);
      const response = await this.env.ACCOUNT.get(id).fetch(
        'https://internal.anvil/internal/deletion-status',
        { method: 'POST' },
      );
      const body = (await response.json().catch(() => null)) as {
        state?: 'none' | 'deleting' | 'deleted';
        purgedRows?: number;
      } | null;
      if (response.ok && body !== null && body.state !== undefined) {
        return {
          state: body.state,
          ...(body.purgedRows === undefined ? {} : { purgedRows: body.purgedRows }),
        };
      }
    } catch {
      // Unreachable object — the tombstone remains authoritative.
    }
    return null;
  }

  /**
   * The §140 deletion flow, shared by the device-facing `account.delete`
   * and the BILL-04 website channel's `/internal/delete-account-by-id`:
   * tombstone, then revoke every session on the account, then drive the
   * account object's retryable purge. Safe to re-invoke — an existing
   * tombstone and revoked rows are left in place and the purge re-drives.
   */
  private async deleteAccountById(accountId: string): Promise<Response> {
    const now = Date.now();
    let tombstone = this.deletionRow(accountId);
    if (tombstone === null) {
      this.ctx.storage.sql.exec(
        'INSERT INTO account_deletions (account_id, deletion_generation, started_at) VALUES (?, 1, ?)',
        accountId,
        now,
      );
      tombstone = this.deletionRow(accountId);
    }
    if (tombstone === null) throw new Error('deletion tombstone insert failed');
    // Enrollments disable first: every session on the account is revoked
    // before the data purge begins.
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?',
      now,
      accountId,
    );
    // Shared artifacts die with the account: rows plus their R2 objects.
    await this.purgeAccountShares(accountId);
    const purge = await this.driveAccountPurge(accountId);
    const result: AccountDeleteResult = {
      state: purge.state,
      deletionGeneration: tombstone.deletion_generation,
      startedAt: new Date(tombstone.started_at).toISOString(),
    };
    return Response.json(result, { status: 200 });
  }

  /** `account.delete` — the caller must hold a live session on the account. */
  private async handleAccountDelete(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    return this.deleteAccountById(caller.accountId);
  }

  /**
   * BILL-04: `/internal/hosted/delete-account` backend — the signed service
   * channel already authenticated the website user and resolved the mapped
   * sync account, so the accountId arrives in the verified body instead of
   * a caller session.
   */
  private async handleDeleteAccountById(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (
      !isRecord(body) ||
      typeof body['accountId'] !== 'string' ||
      body['accountId'].length === 0
    ) {
      return authError('malformed-request');
    }
    return this.deleteAccountById(body['accountId']);
  }

  /**
   * `account.deletionStatus` — two caller classes: a live session on the
   * account (pre-deletion `state: 'none'`), or the deployment admin
   * credential with an explicit `accountId` (the only usable path once
   * sessions are revoked).
   */
  private async handleAccountDeletionStatus(request: Request): Promise<Response> {
    const adminToken = this.env.ENROLLMENT_ADMIN_TOKEN;
    const header = request.headers.get('Authorization');
    let accountId: string;
    if (
      typeof adminToken === 'string' &&
      adminToken.length > 0 &&
      header === `Bearer ${adminToken}`
    ) {
      const body = await readJson(request);
      if (!isRecord(body) || typeof body['accountId'] !== 'string') {
        return authError('malformed-request');
      }
      accountId = body['accountId'];
    } else {
      const caller = this.verifiedCaller(request);
      if (caller === null) return authError('unauthenticated');
      accountId = caller.accountId;
    }
    const tombstone = this.deletionRow(accountId);
    if (tombstone === null) {
      const result: AccountDeletionStatusResult = { state: 'none' };
      return Response.json(result, { status: 200 });
    }
    // A status read is also a purge driver: ask the account object for the
    // live state and fold `deleted` back into the tombstone. Once terminal,
    // a read-only probe supplies detail (purgedRows) without re-driving.
    const purge =
      tombstone.deleted_at !== null
        ? ((await this.readAccountDeletionStatus(accountId)) ?? { state: 'deleted' as const })
        : await this.driveAccountPurge(accountId);
    const fresh = this.deletionRow(accountId);
    const result: AccountDeletionStatusResult = {
      // The tombstone is authoritative — a 'none' probe can't un-delete.
      state: purge.state === 'none' ? 'deleted' : purge.state,
      deletionGeneration: tombstone.deletion_generation,
      startedAt: new Date(tombstone.started_at).toISOString(),
      ...(fresh?.deleted_at == null ? {} : { deletedAt: new Date(fresh.deleted_at).toISOString() }),
      ...(purge.purgedRows === undefined ? {} : { purgedRows: purge.purgedRows }),
    };
    return Response.json(result, { status: 200 });
  }

  /**
   * OPS-01 session sweep: expires dead enrollment codes, clears lapsed
   * refresh-grace windows (the pending rotated response and the superseded
   * credential), and drops revoked sessions past audit retention. One alarm
   * reschedules itself per pass.
   */
  async alarm(): Promise<void> {
    await this.runSweep(Date.now());
  }

  private async ensureSweepAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SESSION_SWEEP_INTERVAL_MS);
    }
  }

  private async runSweep(now: number): Promise<{
    deletedCodes: number;
    clearedGrace: number;
    deletedSessions: number;
  }> {
    let deletedCodes = 0;
    let clearedGrace = 0;
    let deletedSessions = 0;
    this.ctx.storage.transactionSync(() => {
      deletedCodes = this.ctx.storage.sql
        .exec<{ n: number }>(
          `DELETE FROM enrollment_codes
           WHERE expires_at < ? AND consumed_at IS NULL RETURNING 1 AS n`,
          now,
        )
        .toArray().length;
      clearedGrace = this.ctx.storage.sql
        .exec<{ n: number }>(
          `UPDATE device_sessions
           SET prev_refresh_token_hash = NULL, prev_refresh_grace_until = NULL,
               pending_rotated_session = NULL
           WHERE prev_refresh_grace_until IS NOT NULL AND prev_refresh_grace_until < ?
           RETURNING 1 AS n`,
          now,
        )
        .toArray().length;
      deletedSessions = this.ctx.storage.sql
        .exec<{
          n: number;
        }>('DELETE FROM device_sessions WHERE revoked_at IS NOT NULL AND revoked_at < ? RETURNING 1 AS n', now - REVOKED_SESSION_RETENTION_MS)
        .toArray().length;
      // ENV-01: ephemeral sessions past their enrollment expiry are dead —
      // mark them revoked so they join the normal audit-retention path.
      // Read-time checks already reject them; this is the durable record.
      this.ctx.storage.sql.exec(
        `UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?)
         WHERE enrollment_expires_at IS NOT NULL AND enrollment_expires_at <= ?`,
        now,
        now,
      );
    });
    // Share maintenance: lapse orphaned reservations (upload window
    // missed) and expire published/uploaded shares past their deadline,
    // deleting the R2 objects outside the transaction.
    const shareSweeps = this.ctx.storage.sql
      .exec(
        `SELECT share_id, r2_key FROM shared_artifacts
         WHERE (state = 'reserved' AND upload_expires_at < ?)
            OR (state IN ('uploaded', 'published') AND expires_at IS NOT NULL AND expires_at < ?)`,
        now,
        now,
      )
      .toArray() as { share_id: string; r2_key: string }[];
    for (const row of shareSweeps) {
      await this.env.ARTIFACTS.delete(row.r2_key).catch(() => undefined);
      this.ctx.storage.sql.exec(
        "UPDATE shared_artifacts SET state = 'expired' WHERE share_id = ?",
        row.share_id,
      );
    }
    // Terminal shares whose objects are already gone: keep the row for
    // audit until retention, then drop it.
    this.ctx.storage.sql.exec(
      `DELETE FROM shared_artifacts
       WHERE state IN ('revoked', 'expired')
         AND created_at < ?`,
      now - REVOKED_SESSION_RETENTION_MS,
    );
    // Re-drive unfinished account purges — the account object's own alarm
    // is the fast path; this covers a deletion whose request chain broke
    // before the first pass landed.
    const pending = this.ctx.storage.sql
      .exec<{
        account_id: string;
      }>('SELECT account_id FROM account_deletions WHERE deleted_at IS NULL LIMIT 8')
      .toArray();
    for (const row of pending) {
      await this.driveAccountPurge(row.account_id);
    }
    await this.ctx.storage.setAlarm(Date.now() + SESSION_SWEEP_INTERVAL_MS);
    return { deletedCodes, clearedGrace, deletedSessions };
  }
}
