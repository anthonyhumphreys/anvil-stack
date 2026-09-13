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
  type AuthErrorCode,
  type DeviceListResult,
  type DeviceRenameResult,
  type DeviceRevokeResult,
  type DeviceSession,
  type DeviceSummary,
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
import { verifyOidcPkceProof } from './oidc';
import { isRecord, rpcErrorResponse } from './rpc';
import { SESSION_SCHEMA } from './schema';

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_GRACE_MS = 30 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_CODES_PER_ACCOUNT = 20;
const MAX_DEVICE_NAME_CHARS = 128;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Revoked sessions are retained this long for audit, then swept (OPS-01). */
const REVOKED_SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

function authError(code: AuthErrorCode | 'unauthenticated' | 'throttled' | 'malformed-request') {
  const status = code === 'unauthenticated' || code === 'malformed-request'
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

export class SessionCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(SESSION_SCHEMA);
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
          const response = await this.ctx.blockConcurrencyWhile(() => this.handleIssueCode(request));
          await this.ensureSweepAlarm();
          return response;
        }
        case 'POST /internal/validate':
          return await this.handleValidate(request);
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
        case 'POST /internal/sweep':
          return Response.json(await this.runSweep(Date.now()));
        default:
          return rpcErrorResponse(undefined, 'not-found');
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
    return session;
  }

  private async issueTokens(
    enrollmentId: string,
    accountId: string,
    installationId: string,
    displayName: string | null,
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
        pending_rotated_session, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      enrollmentId,
      accountId,
      installationId,
      displayName,
      accessHash,
      accessExpiresAt,
      refreshHash,
      now,
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
        return row.account_id;
      });
      if (consumed === null) {
        return authError('enrollment-code-used');
      }
      accountId = consumed;
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
    } else {
      return authError('invalid-proof');
    }

    const enrollmentId = `enr_${crypto.randomUUID()}`;
    const session = await this.issueTokens(
      enrollmentId,
      accountId,
      params.installationId,
      displayName,
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
    if (row === null || row.revoked_at !== null) {
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
        presentedHash === row.refresh_token_hash ||
        presentedHash === row.prev_refresh_token_hash;
    }
    if (!authorized) {
      const bearer = parseDeviceBearer(request.headers.get('Authorization'));
      if (bearer !== null) {
        const bearerHash = await sha256Hex(bearer);
        authorized =
          bearerHash === row.access_token_hash && row.revoked_at === null;
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
      if (session === null || session.revoked_at !== null || session.access_expires_at <= Date.now()) {
        return authError('unauthenticated');
      }
      accountId = session.account_id;
      issuedBy = session.enrollment_id;
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

    const { code, normalized } = generateEnrollmentCode();
    const codeHash = await sha256Hex(normalized);
    const displayName = typeof body['displayName'] === 'string' ? body['displayName'] : null;
    this.ctx.storage.sql.exec(
      `INSERT INTO enrollment_codes
        (code_hash, account_id, issued_by, display_name, expires_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      codeHash,
      accountId,
      issuedBy,
      displayName,
      now + CODE_TTL_MS,
      now,
    );
    const result: EnrollmentCodeIssueResult = {
      code,
      expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
      accountId,
    };
    return Response.json(result, { status: 200 });
  }

  /** Worker-internal: bearer → verified identity for routing. */
  private async handleValidate(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['accessToken'] !== 'string') {
      return authError('malformed-request');
    }
    const hash = await sha256Hex(body['accessToken']);
    const row = this.sessionByAccessHash(hash);
    if (row === null || row.revoked_at !== null || row.access_expires_at <= Date.now()) {
      return authError('unauthenticated');
    }
    return Response.json(
      { accountId: row.account_id, enrollmentId: row.enrollment_id },
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
    if (row === null || row.revoked_at !== null || row.access_expires_at <= Date.now()) {
      return authError('unauthenticated');
    }
    const meta = await this.accountMeta(row.account_id);
    const result: SessionDescribeResult = {
      accountId: row.account_id,
      enrollmentId: row.enrollment_id,
      datasetEpoch: meta.epoch,
      credentialGeneration: row.credential_generation,
      accessExpiresAt: new Date(row.access_expires_at).toISOString(),
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      ...(meta.stats === undefined ? {} : { accountStats: meta.stats }),
    };
    return Response.json(result, { status: 200 });
  }

  /**
   * Verified-identity gate for `/internal/device-*` routes: the worker
   * already validated the bearer; this re-checks that the enrollment's
   * session row is live on the claimed account (fail-closed across a
   * revocation race).
   */
  private verifiedCaller(request: Request): VerifiedAuth | null {
    const verified = parseVerifiedAuth(request);
    if (verified === null) return null;
    const row = this.sessionByEnrollment(verified.enrollmentId);
    if (
      row === null ||
      row.account_id !== verified.accountId ||
      row.revoked_at !== null
    ) {
      return null;
    }
    return verified;
  }

  /** `device.list` — every session on the caller's account, revoked included. */
  private async handleDeviceList(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT enrollment_id, installation_id, display_name,
                credential_generation, revoked_at, created_at
         FROM device_sessions WHERE account_id = ? ORDER BY created_at ASC`,
        caller.accountId,
      )
      .toArray() as unknown as SessionRow[];
    const devices: DeviceSummary[] = rows.map((row) => ({
      enrollmentId: row.enrollment_id,
      ...(row.display_name === null ? {} : { displayName: row.display_name }),
      installationId: row.installation_id,
      credentialGeneration: row.credential_generation,
      revoked: row.revoked_at !== null,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      self: row.enrollment_id === caller.enrollmentId,
    }));
    const result: DeviceListResult = { devices };
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
    const row = this.sessionByEnrollment(body['enrollmentId']);
    if (row === null || row.account_id !== caller.accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET display_name = ? WHERE enrollment_id = ?',
      body['displayName'].length === 0 ? null : body['displayName'],
      row.enrollment_id,
    );
    const result: DeviceRenameResult = { renamed: true, enrollmentId: row.enrollment_id };
    return Response.json(result, { status: 200 });
  }

  /**
   * `device.revoke` — account-scoped revocation: any live session on the
   * account may revoke any other (or itself — a remote sign-out). The
   * session row flips `revoked_at`; the account object then closes the
   * enrollment's sockets and revokes its worker record (best effort —
   * token validation is authoritative).
   */
  private async handleDeviceRevoke(request: Request): Promise<Response> {
    const caller = this.verifiedCaller(request);
    if (caller === null) return authError('unauthenticated');
    const body = await readJson(request);
    if (!isRecord(body) || typeof body['enrollmentId'] !== 'string') {
      return authError('malformed-request');
    }
    const row = this.sessionByEnrollment(body['enrollmentId']);
    if (row === null || row.account_id !== caller.accountId) {
      return rpcErrorResponse(undefined, 'not-found');
    }
    this.ctx.storage.sql.exec(
      'UPDATE device_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE enrollment_id = ?',
      Date.now(),
      row.enrollment_id,
    );
    try {
      const id = this.env.ACCOUNT.idFromName(row.account_id);
      await this.env.ACCOUNT.get(id).fetch(
        'https://internal.anvil/internal/revoke-enrollment',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enrollmentId: row.enrollment_id }),
        },
      );
    } catch {
      // Socket cleanup is best effort; the revoked session row is authoritative.
    }
    const result: DeviceRevokeResult = { revoked: true, enrollmentId: row.enrollment_id };
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
        .exec<{ n: number }>(
          'DELETE FROM device_sessions WHERE revoked_at IS NOT NULL AND revoked_at < ? RETURNING 1 AS n',
          now - REVOKED_SESSION_RETENTION_MS,
        )
        .toArray().length;
    });
    await this.ctx.storage.setAlarm(Date.now() + SESSION_SWEEP_INTERVAL_MS);
    return { deletedCodes, clearedGrace, deletedSessions };
  }
}
