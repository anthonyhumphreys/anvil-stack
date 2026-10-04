import { DurableObject } from 'cloudflare:workers';

import {
  MESH_MACHINE_CAPABILITIES,
  MESH_MACHINE_OPERATIONS,
  meshMachineAdmissionProofKeyAssociatedData,
  type MeshMachineAdmissionClaims,
  type MeshMachineSealedValue,
} from '../../../contract/machine';
import { isRecord } from '../rpc';
import {
  CloudflareTunnelError,
  CloudflareTunnelProvider,
  normalizeLoopbackService,
} from './cloudflare-tunnel';

export type MachineEndpointAllocationState =
  | 'unallocated'
  | 'allocating'
  | 'ready'
  | 'retiring'
  | 'failed';

export interface MachineEndpointAllocationView {
  machineId: string;
  endpointGeneration: string;
  allocationGeneration: number;
  state: MachineEndpointAllocationState;
  hostname?: string;
  url?: string;
  createdAt?: number;
  lastReachableAt?: number;
  retryAt?: number;
  errorCode?: 'provider-unavailable' | 'provider-capacity' | 'provider-failed';
}

type SqlValue = string | number | null | ArrayBuffer;

interface AllocationRow extends Record<string, SqlValue> {
  account_id: string;
  machine_id: string;
  host_enrollment_id: string;
  endpoint_generation: string;
  allocation_generation: number;
  state: MachineEndpointAllocationState;
  stable_host_label: string;
  stable_tunnel_name: string;
  hostname: string;
  local_service: string;
  provider_operation_id: string;
  provider_tunnel_id: string | null;
  provider_dns_record_id: string | null;
  request_id: string;
  created_at: number;
  updated_at: number;
  last_reachable_at: number;
  retry_at: number;
  attempts: number;
  lock_id: string | null;
  lock_until: number;
  error_code: string | null;
}

interface AdmissionRow extends Record<string, SqlValue> {
  ticket_hash: string;
  ticket: string;
  account_id: string;
  principal_id: string;
  source_enrollment_id: string | null;
  host_enrollment_id: string;
  host_machine_id: string;
  endpoint_generation: string;
  claims_json: string;
  proof_key: string | null;
  sealed_proof_key_json: string | null;
  issued_ms: number;
  expires_ms: number;
  consumed_ms: number | null;
}

interface AdmissionIssueInput {
  accountId: string;
  hostEnrollmentId: string;
  hostMachineId: string;
  endpointGeneration: string;
  clientPublicKey: string;
  bootstrapChallenge: string;
  requestId: string;
  principal:
    | { kind: 'enrollment'; sourceEnrollmentId: string; requestedCapabilities: string[]; operations: string[]; scopes: string[] }
    | { kind: 'dashboard'; grantId: string; origin: string };
}

interface AdmissionConsumeInput {
  accountId: string;
  hostEnrollmentId: string;
  hostMachineId: string;
  endpointGeneration: string;
  ticket: string;
}

interface AdmissionListInput {
  accountId: string;
}

const MAX_ACTIVE_PER_ACCOUNT = 5;
const MAX_CONCURRENT_PROVISIONING = 3;
const MAX_MUTATIONS_PER_ACCOUNT_PER_HOUR = 12;
const MAX_ADMISSIONS_PER_ACCOUNT_PER_HOUR = 120;
const ADMISSION_TTL_MS = 60_000;
const ALLOCATION_RETRY_DELAY_MS = 30_000;
const ALLOCATION_LOCK_MS = 90_000;
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const HOST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HOST_GENERATION = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Serializes endpoint allocations globally so account quotas and concurrent
 * provider work have one durable authority. Provider calls happen only after
 * the operation id and host/allocation generations have been committed.
 */
export class MachineEndpointCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS machine_endpoint_allocations (
        account_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        host_enrollment_id TEXT NOT NULL,
        endpoint_generation TEXT NOT NULL,
        allocation_generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        stable_host_label TEXT NOT NULL,
        stable_tunnel_name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        local_service TEXT NOT NULL DEFAULT '',
        provider_operation_id TEXT NOT NULL,
        provider_tunnel_id TEXT,
        provider_dns_record_id TEXT,
        request_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_reachable_at INTEGER NOT NULL,
        retry_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        lock_id TEXT,
        lock_until INTEGER NOT NULL,
        error_code TEXT,
        PRIMARY KEY (account_id, machine_id)
      );
      CREATE INDEX IF NOT EXISTS machine_endpoint_due
        ON machine_endpoint_allocations(state, retry_at, lock_until);
      CREATE TABLE IF NOT EXISTS machine_endpoint_rate_limits (
        account_id TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        PRIMARY KEY (account_id, window_start)
      );
      CREATE TABLE IF NOT EXISTS machine_endpoint_admissions (
        ticket_hash TEXT PRIMARY KEY,
        ticket TEXT NOT NULL,
        account_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        source_enrollment_id TEXT,
        host_enrollment_id TEXT NOT NULL,
        host_machine_id TEXT NOT NULL,
        endpoint_generation TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        proof_key TEXT,
        sealed_proof_key_json TEXT,
        issued_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL,
        consumed_ms INTEGER,
        request_id TEXT NOT NULL,
        UNIQUE(account_id, principal_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS machine_endpoint_admissions_due
        ON machine_endpoint_admissions(expires_ms, consumed_ms);
      CREATE TABLE IF NOT EXISTS machine_endpoint_admission_rate_limits (
        account_id TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        requests INTEGER NOT NULL,
        PRIMARY KEY (account_id, window_start)
      );
    `);
    const allocationColumns = ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(machine_endpoint_allocations)')
      .toArray();
    if (!allocationColumns.some((column) => column.name === 'local_service')) {
      ctx.storage.sql.exec(
        "ALTER TABLE machine_endpoint_allocations ADD COLUMN local_service TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/internal/list' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isRecord(body) || typeof body['accountId'] !== 'string') return jsonError(400, 'malformed-request');
      return Response.json({ allocations: this.list(body['accountId']) });
    }
    if (url.pathname === '/internal/allocate' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isAllocateInput(body)) return jsonError(400, 'malformed-request');
      return this.allocate(body);
    }
    if (url.pathname === '/internal/release' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isHostGenerationInput(body)) return jsonError(400, 'malformed-request');
      return this.release(body);
    }
    if (url.pathname === '/internal/release-enrollment' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isAccountEnrollmentInput(body)) return jsonError(400, 'malformed-request');
      return this.releaseEnrollment(body);
    }
    if (url.pathname === '/internal/release-account' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isRecord(body) || typeof body['accountId'] !== 'string' || !ACCOUNT_ID.test(body['accountId'])) {
        return jsonError(400, 'malformed-request');
      }
      return this.releaseAccount(body['accountId']);
    }
    if (url.pathname === '/internal/presence' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isTokenInput(body)) return jsonError(400, 'malformed-request');
      return this.presence(body);
    }
    if (url.pathname === '/internal/connector-token' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isTokenInput(body)) return jsonError(400, 'malformed-request');
      return this.connectorToken(body);
    }
    if (url.pathname === '/internal/admission-issue' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isAdmissionIssueInput(body)) return jsonError(400, 'malformed-request');
      return this.issueAdmission(body);
    }
    if (url.pathname === '/internal/admission-consume' && request.method === 'POST') {
      const body = await readJson(request);
      if (!isAdmissionConsumeInput(body)) return jsonError(400, 'malformed-request');
      return this.consumeAdmission(body);
    }
    if (url.pathname === '/internal/reconcile' && request.method === 'POST') {
      await this.reconcile(Date.now());
      return Response.json({ ok: true });
    }
    return jsonError(404, 'not-found');
  }

  private list(accountId: string): MachineEndpointAllocationView[] {
    if (!ACCOUNT_ID.test(accountId)) return [];
    return this.ctx.storage.sql
      .exec<AllocationRow>(
        `SELECT * FROM machine_endpoint_allocations
         WHERE account_id = ? ORDER BY machine_id LIMIT 100`,
        accountId,
      )
      .toArray()
      .map(toView);
  }

  private async allocate(input: AllocateInput): Promise<Response> {
    if (!managedProvisioningEnabled(this.env)) return jsonError(503, 'provider-unavailable');
    const provider = createProvider(this.env);
    if (provider === null) return jsonError(503, 'provider-unavailable');
    // This async hash yields control to other requests. Complete it before
    // reading quota counts so each request's count and durable reservation
    // remain in one synchronous turn.
    const stableHostLabel = await stableEndpointLabel(input.accountId, input.machineId);
    const now = Date.now();
    let existing = this.get(input.accountId, input.machineId);
    if (existing !== null) {
      const identityChanged =
        (input.endpointGeneration !== existing.endpoint_generation || input.hostEnrollmentId !== existing.host_enrollment_id) &&
        existing.state !== 'unallocated' &&
        existing.state !== 'failed';
      if (identityChanged) {
        if (existing.state !== 'retiring') {
          this.ctx.storage.sql.exec(
            `UPDATE machine_endpoint_allocations
             SET state = 'retiring', updated_at = ?, retry_at = ?, error_code = NULL
             WHERE account_id = ? AND machine_id = ? AND allocation_generation = ?`,
            now,
            now,
            input.accountId,
            input.machineId,
            existing.allocation_generation,
          );
          return Response.json({ allocation: toView({ ...existing, state: 'retiring' }) }, { status: 202 });
        }
        await this.reconcileRow(existing, now, provider);
        existing = this.get(input.accountId, input.machineId);
        if (existing !== null && existing.state !== 'unallocated') {
          return Response.json({ allocation: toView(existing) }, { status: 202 });
        }
      }
      if (existing !== null && existing.state === 'ready' && input.endpointGeneration === existing.endpoint_generation) {
        if (existing.local_service !== input.localOrigin) return jsonError(409, 'origin-changed');
        return Response.json({ allocation: toView(existing) });
      }
      if (existing !== null && (existing.state === 'allocating' || existing.state === 'retiring')) {
        if (existing.state === 'allocating' && existing.local_service !== input.localOrigin) {
          return jsonError(409, 'origin-changed');
        }
        await this.reconcileRow(existing, now, provider);
        const refreshed = this.get(input.accountId, input.machineId);
        if (refreshed !== null && refreshed.state !== 'unallocated') {
          return Response.json({ allocation: toView(refreshed) }, { status: 202 });
        }
        existing = refreshed;
      }
      if (existing?.state === 'failed' && input.requestId === existing.request_id) {
        return Response.json({ allocation: toView(existing) }, { status: 409 });
      }
    }

    if (!this.consumeRateLimit(input.accountId, now)) return jsonError(429, 'rate-limited');
    const activeCount = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM machine_endpoint_allocations
         WHERE account_id = ? AND state IN ('allocating', 'ready', 'retiring')`,
        input.accountId,
      )
      .one().count;
    if (activeCount >= MAX_ACTIVE_PER_ACCOUNT) return jsonError(429, 'quota-exceeded');
    const provisioningCount = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM machine_endpoint_allocations
         WHERE state = 'allocating' AND lock_until > ?`,
        now,
      )
      .one().count;
    if (provisioningCount >= MAX_CONCURRENT_PROVISIONING) return jsonError(429, 'capacity-exceeded');

    const allocationGeneration = (existing?.allocation_generation ?? 0) + 1;
    const stableTunnelName = `anvil-${stableHostLabel}-g${allocationGeneration}`;
    const hostname = provider.hostnameFor(stableHostLabel);
    const operationId = crypto.randomUUID();
    const lockId = crypto.randomUUID();
    const row: AllocationRow = {
      account_id: input.accountId,
      machine_id: input.machineId,
      host_enrollment_id: input.hostEnrollmentId,
      endpoint_generation: input.endpointGeneration,
      allocation_generation: allocationGeneration,
      state: 'allocating',
      stable_host_label: stableHostLabel,
      stable_tunnel_name: stableTunnelName,
      hostname,
      local_service: input.localOrigin,
      provider_operation_id: operationId,
      provider_tunnel_id: null,
      provider_dns_record_id: null,
      request_id: input.requestId,
      created_at: now,
      updated_at: now,
      last_reachable_at: now,
      retry_at: now,
      attempts: 0,
      lock_id: lockId,
      lock_until: now + ALLOCATION_LOCK_MS,
      error_code: null,
    };
    this.write(row);
    const response = await this.provision(row, provider, lockId);
    if (response !== undefined) return response;
    const current = this.get(input.accountId, input.machineId);
    return Response.json(
      { allocation: current === null ? emptyView(input.machineId, input.endpointGeneration) : toView(current) },
      { status: 202 },
    );
  }

  private async release(input: HostGenerationInput): Promise<Response> {
    const row = this.get(input.accountId, input.machineId);
    if (row === null || row.state === 'unallocated') {
      return Response.json({ allocation: emptyView(input.machineId, input.endpointGeneration) });
    }
    if (
      input.endpointGeneration !== row.endpoint_generation ||
      (input.allocationGeneration !== undefined && input.allocationGeneration !== row.allocation_generation)
    ) {
      return jsonError(409, 'stale-generation');
    }
    if (!this.consumeRateLimit(input.accountId, Date.now())) return jsonError(429, 'rate-limited');
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE machine_endpoint_allocations
       SET state = 'retiring', updated_at = ?, retry_at = ?, error_code = NULL
       WHERE account_id = ? AND machine_id = ? AND allocation_generation = ?`,
      now,
      now,
      input.accountId,
      input.machineId,
      row.allocation_generation,
    );
    const retiring = { ...row, state: 'retiring' as const, updated_at: now, retry_at: now };
    const provider = createProvider(this.env);
    if (provider !== null) await this.reconcileRow(retiring, now, provider);
    const result = this.get(input.accountId, input.machineId);
    return Response.json({ allocation: result === null ? emptyView(input.machineId, input.endpointGeneration) : toView(result) });
  }

  private async releaseEnrollment(input: AccountEnrollmentInput): Promise<Response> {
    const rows = this.ctx.storage.sql
      .exec<AllocationRow>(
        `SELECT * FROM machine_endpoint_allocations
         WHERE account_id = ? AND host_enrollment_id = ? AND state NOT IN ('unallocated', 'failed') LIMIT 20`,
        input.accountId,
        input.enrollmentId,
      )
      .toArray();
    await this.retireRows(rows);
    return Response.json({ released: rows.length });
  }

  private async releaseAccount(accountId: string): Promise<Response> {
    const rows = this.ctx.storage.sql
      .exec<AllocationRow>(
        `SELECT * FROM machine_endpoint_allocations
         WHERE account_id = ? AND state NOT IN ('unallocated', 'failed') LIMIT 100`,
        accountId,
      )
      .toArray();
    await this.retireRows(rows);
    return Response.json({ released: rows.length });
  }

  private async retireRows(rows: AllocationRow[]): Promise<void> {
    const now = Date.now();
    const provider = createProvider(this.env);
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        `UPDATE machine_endpoint_allocations SET state = 'retiring', updated_at = ?, retry_at = ?, error_code = NULL
         WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND state != 'unallocated'`,
        now,
        now,
        row.account_id,
        row.machine_id,
        row.allocation_generation,
      );
      if (provider !== null) await this.reconcileRow({ ...row, state: 'retiring', lock_until: 0 }, now, provider);
    }
  }

  private presence(input: TokenInput): Response {
    const row = this.get(input.accountId, input.machineId);
    if (row === null) return jsonError(404, 'not-found');
    if (
      row.endpoint_generation !== input.endpointGeneration ||
      row.allocation_generation !== input.allocationGeneration ||
      row.state !== 'ready'
    ) {
      return jsonError(409, 'stale-generation');
    }
    const now = Date.now();
    this.touchRow(row, now);
    return Response.json({ reachableUntil: now + OFFLINE_GRACE_MS });
  }

  private async connectorToken(input: TokenInput): Promise<Response> {
    const row = this.get(input.accountId, input.machineId);
    if (
      row === null ||
      row.state !== 'ready' ||
      row.endpoint_generation !== input.endpointGeneration ||
      row.allocation_generation !== input.allocationGeneration
    ) {
      return jsonError(409, 'stale-generation');
    }
    if (this.env.ANVIL_MESH_MANAGED_ENDPOINTS !== 'true') return jsonError(503, 'provider-unavailable');
    const provider = createProvider(this.env);
    if (provider === null) return jsonError(503, 'provider-unavailable');
    try {
      // This secret-specific route is authorized by the Worker for the exact
      // host enrollment. It is never included in discovery or list responses.
      const connectorToken = await provider.readTunnelToken(row.provider_tunnel_id!);
      this.touchRow(row, Date.now());
      return Response.json(
        { connectorToken, hostname: row.hostname, endpointGeneration: row.endpoint_generation, allocationGeneration: row.allocation_generation },
        { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
      );
    } catch {
      return jsonError(503, 'provider-unavailable');
    }
  }

  private async issueAdmission(input: AdmissionIssueInput): Promise<Response> {
    const now = Date.now();
    const existing = this.ctx.storage.sql
      .exec<AdmissionRow>(
        `SELECT * FROM machine_endpoint_admissions
         WHERE account_id = ? AND principal_id = ? AND request_id = ?`,
        input.accountId,
        admissionPrincipalId(input.principal),
        input.requestId,
      )
      .toArray()[0] ?? null;
    if (existing !== null) {
      if (
        existing.expires_ms <= now ||
        existing.consumed_ms !== null ||
        existing.host_enrollment_id !== input.hostEnrollmentId ||
        existing.host_machine_id !== input.hostMachineId ||
        existing.endpoint_generation !== input.endpointGeneration ||
        !sameAdmissionRequest(existing.claims_json, input)
      ) {
        return jsonError(409, 'ticket-replayed');
      }
      return admissionIssueResponse(existing);
    }
    if (!this.consumeAdmissionRateLimit(input.accountId, now)) return jsonError(429, 'rate-limited');

    const ticket = randomBase64Url(32);
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ADMISSION_TTL_MS).toISOString();
    const claims = {
      v: 1 as const,
      accountId: input.accountId,
      hostEnrollmentId: input.hostEnrollmentId,
      hostMachineId: input.hostMachineId,
      endpointGeneration: input.endpointGeneration,
      principal: input.principal,
      bootstrapChallenge: input.bootstrapChallenge,
      clientPublicKey: input.clientPublicKey,
      issuedAt,
      expiresAt,
    } as MeshMachineAdmissionClaims;
    let proofBytes: Uint8Array | null = null;
    let proofKey: string | null = null;
    let sealedProofKey: MeshMachineSealedValue | null = null;
    if (input.principal.kind === 'enrollment') {
      proofBytes = crypto.getRandomValues(new Uint8Array(32));
      proofKey = encodeBase64Url(proofBytes);
      try {
        sealedProofKey = await sealToX25519PublicKey(
          input.clientPublicKey,
          proofBytes,
          meshMachineAdmissionProofKeyAssociatedData(claims),
        );
      } catch {
        proofBytes.fill(0);
        return jsonError(400, 'invalid-client-key');
      }
      proofBytes?.fill(0);
    }
    const ticketHash = await sha256Hex(ticket);
    const sealedJson = sealedProofKey === null ? null : JSON.stringify(sealedProofKey);
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO machine_endpoint_admissions
         (ticket_hash, ticket, account_id, principal_id, source_enrollment_id, host_enrollment_id,
          host_machine_id, endpoint_generation, claims_json, proof_key, sealed_proof_key_json,
          issued_ms, expires_ms, consumed_ms, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ticketHash,
        ticket,
        input.accountId,
        admissionPrincipalId(input.principal),
        input.principal.kind === 'enrollment' ? input.principal.sourceEnrollmentId : null,
        input.hostEnrollmentId,
        input.hostMachineId,
        input.endpointGeneration,
        JSON.stringify(claims),
        proofKey,
        sealedJson,
        now,
        now + ADMISSION_TTL_MS,
        input.requestId,
      );
    } catch {
      proofBytes?.fill(0);
      return jsonError(409, 'ticket-replayed');
    }
    return Response.json(
      { v: 1, ticket, claims, ...(sealedProofKey === null ? {} : { sealedProofKey }) },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  private async consumeAdmission(input: AdmissionConsumeInput): Promise<Response> {
    const now = Date.now();
    const ticketHash = await sha256Hex(input.ticket);
    // A single conditional UPDATE is the replay fence. The host enrollment,
    // account, machine, and listener generation all come from verified auth
    // plus a fresh self-advertisement in the public Worker route.
    const consumed = this.ctx.storage.sql.exec<AdmissionRow>(
      `UPDATE machine_endpoint_admissions SET consumed_ms = ?
       WHERE ticket_hash = ? AND account_id = ? AND host_enrollment_id = ?
         AND host_machine_id = ? AND endpoint_generation = ?
         AND consumed_ms IS NULL AND expires_ms > ?
       RETURNING *`,
      now,
      ticketHash,
      input.accountId,
      input.hostEnrollmentId,
      input.hostMachineId,
      input.endpointGeneration,
      now,
    ).toArray()[0] ?? null;
    if (consumed === null) return jsonError(409, 'ticket-expired-or-consumed');
    let claims: MeshMachineAdmissionClaims;
    try {
      claims = JSON.parse(consumed.claims_json) as MeshMachineAdmissionClaims;
    } catch {
      return jsonError(409, 'ticket-invalid');
    }
    if (
      claims.accountId !== input.accountId ||
      claims.hostEnrollmentId !== input.hostEnrollmentId ||
      claims.hostMachineId !== input.hostMachineId ||
      claims.endpointGeneration !== input.endpointGeneration
    ) return jsonError(409, 'ticket-invalid');
    return Response.json(
      { v: 1, claims, ...(consumed.proof_key === null ? {} : { proofKey: consumed.proof_key }) },
      { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
    );
  }

  private consumeAdmissionRateLimit(accountId: string, now: number): boolean {
    const windowStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
    this.ctx.storage.sql.exec(
      `INSERT INTO machine_endpoint_admission_rate_limits(account_id, window_start, requests)
       VALUES (?, ?, 0) ON CONFLICT(account_id, window_start) DO NOTHING`,
      accountId,
      windowStart,
    );
    const row = this.ctx.storage.sql
      .exec<{ requests: number }>(
        `SELECT requests FROM machine_endpoint_admission_rate_limits
         WHERE account_id = ? AND window_start = ?`,
        accountId,
        windowStart,
      )
      .one();
    if (row.requests >= MAX_ADMISSIONS_PER_ACCOUNT_PER_HOUR) return false;
    this.ctx.storage.sql.exec(
      `UPDATE machine_endpoint_admission_rate_limits SET requests = requests + 1
       WHERE account_id = ? AND window_start = ?`,
      accountId,
      windowStart,
    );
    return true;
  }

  private async reconcile(now: number): Promise<void> {
    const due = this.ctx.storage.sql
      .exec<AllocationRow>(
        `SELECT * FROM machine_endpoint_allocations
         WHERE state IN ('allocating', 'retiring') AND retry_at <= ? AND lock_until <= ?
         ORDER BY updated_at LIMIT 20`,
        now,
        now,
      )
      .toArray();
    const provider = createProvider(this.env);
    for (const row of due) {
      if (row.state === 'ready') continue;
      if (row.state === 'allocating' && now - row.last_reachable_at > OFFLINE_GRACE_MS) {
        this.ctx.storage.sql.exec(
          `UPDATE machine_endpoint_allocations SET state = 'retiring', updated_at = ?, retry_at = ?
           WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND state = 'allocating'`,
          now,
          now,
          row.account_id,
          row.machine_id,
          row.allocation_generation,
        );
        row.state = 'retiring';
      }
      if (provider === null) continue;
      await this.reconcileRow(row, now, provider);
    }
    const offline = this.ctx.storage.sql
      .exec<AllocationRow>(
        `SELECT * FROM machine_endpoint_allocations
         WHERE state = 'ready' AND last_reachable_at < ? ORDER BY last_reachable_at LIMIT 20`,
        now - OFFLINE_GRACE_MS,
      )
      .toArray();
    for (const row of offline) {
      this.ctx.storage.sql.exec(
        `UPDATE machine_endpoint_allocations SET state = 'retiring', updated_at = ?, retry_at = ?
         WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND state = 'ready'`,
        now,
        now,
        row.account_id,
        row.machine_id,
        row.allocation_generation,
      );
      if (provider !== null) await this.reconcileRow({ ...row, state: 'retiring' }, now, provider);
    }
    this.ctx.storage.sql.exec('DELETE FROM machine_endpoint_rate_limits WHERE window_start < ?', now - 2 * 60 * 60 * 1000);
    this.ctx.storage.sql.exec('DELETE FROM machine_endpoint_admissions WHERE expires_ms <= ? OR consumed_ms IS NOT NULL', now);
    this.ctx.storage.sql.exec('DELETE FROM machine_endpoint_admission_rate_limits WHERE window_start < ?', now - 2 * 60 * 60 * 1000);
  }

  private async reconcileRow(row: AllocationRow, now: number, provider: CloudflareTunnelProvider): Promise<void> {
    if (row.lock_until > now) return;
    const lockId = crypto.randomUUID();
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE machine_endpoint_allocations SET lock_id = ?, lock_until = ?, updated_at = ?
       WHERE account_id = ? AND machine_id = ? AND allocation_generation = ?
         AND state IN ('allocating', 'retiring') AND lock_until <= ?`,
      lockId,
      now + ALLOCATION_LOCK_MS,
      now,
      row.account_id,
      row.machine_id,
      row.allocation_generation,
      now,
    );
    if (claimed.rowsWritten !== 1) return;
    const current = this.get(row.account_id, row.machine_id);
    if (current === null) return;
    if (current.state === 'retiring') {
      await this.remove(current, provider, lockId);
      return;
    }
    await this.provision(current, provider, lockId);
  }

  private async provision(row: AllocationRow, provider: CloudflareTunnelProvider, lockId: string): Promise<Response | void> {
    try {
      const allocation = await provider.ensure({
        stableName: row.stable_tunnel_name,
        stableHostLabel: row.stable_host_label,
        operationId: row.provider_operation_id,
        localService: row.local_service,
      });
      const current = this.get(row.account_id, row.machine_id);
      if (current === null || current.allocation_generation !== row.allocation_generation) {
        await provider.remove({ tunnelId: allocation.tunnelId, dnsRecordId: allocation.dnsRecordId }).catch(() => undefined);
        return;
      }
      const nextState = current.state === 'retiring' ? 'retiring' : 'ready';
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE machine_endpoint_allocations
         SET provider_tunnel_id = ?, provider_dns_record_id = ?, state = ?, updated_at = ?,
             last_reachable_at = CASE WHEN ? = 'ready' THEN ? ELSE last_reachable_at END,
             retry_at = ?, attempts = attempts + 1, lock_id = NULL, lock_until = 0, error_code = NULL
         WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND lock_id = ?`,
        allocation.tunnelId,
        allocation.dnsRecordId,
        nextState,
        now,
        nextState,
        now,
        now,
        row.account_id,
        row.machine_id,
        row.allocation_generation,
        lockId,
      );
      if (nextState === 'retiring') await this.remove({ ...current, provider_tunnel_id: allocation.tunnelId, provider_dns_record_id: allocation.dnsRecordId }, provider, undefined);
      const refreshed = this.get(row.account_id, row.machine_id);
      return Response.json({ allocation: refreshed === null ? emptyView(row.machine_id, row.endpoint_generation) : toView(refreshed) }, { status: nextState === 'ready' ? 201 : 202 });
    } catch (error) {
      const now = Date.now();
      const retryable = !(error instanceof CloudflareTunnelError) || error.retryable;
      const current = this.get(row.account_id, row.machine_id);
      if (current?.state === 'retiring') {
        this.ctx.storage.sql.exec(
          `UPDATE machine_endpoint_allocations SET retry_at = ?, lock_id = NULL, lock_until = 0,
             attempts = attempts + 1, error_code = 'provider-failed', updated_at = ?
           WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND lock_id = ?`,
          now + ALLOCATION_RETRY_DELAY_MS,
          now,
          row.account_id,
          row.machine_id,
          row.allocation_generation,
          lockId,
        );
        return jsonError(503, 'provider-unavailable');
      }
      if (retryable) {
        this.ctx.storage.sql.exec(
          `UPDATE machine_endpoint_allocations SET retry_at = ?, lock_id = NULL, lock_until = 0,
             attempts = attempts + 1, error_code = 'provider-failed', updated_at = ?
           WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND lock_id = ?`,
          now + ALLOCATION_RETRY_DELAY_MS,
          now,
          row.account_id,
          row.machine_id,
          row.allocation_generation,
          lockId,
        );
      } else {
        try {
          await provider.removeByName({ stableName: row.stable_tunnel_name, stableHostLabel: row.stable_host_label });
          this.ctx.storage.sql.exec(
            `UPDATE machine_endpoint_allocations SET state = 'failed', retry_at = ?, lock_id = NULL,
               lock_until = 0, attempts = attempts + 1, error_code = 'provider-failed', updated_at = ?
             WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND lock_id = ?`,
            now + ALLOCATION_RETRY_DELAY_MS,
            now,
            row.account_id,
            row.machine_id,
            row.allocation_generation,
            lockId,
          );
        } catch {
          this.ctx.storage.sql.exec(
            `UPDATE machine_endpoint_allocations SET state = 'retiring', retry_at = ?, lock_id = NULL,
               lock_until = 0, attempts = attempts + 1, error_code = 'provider-failed', updated_at = ?
             WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND lock_id = ?`,
            now + ALLOCATION_RETRY_DELAY_MS,
            now,
            row.account_id,
            row.machine_id,
            row.allocation_generation,
            lockId,
          );
        }
      }
      const refreshed = this.get(row.account_id, row.machine_id);
      return jsonError(503, refreshed?.state === 'failed' ? 'provider-failed' : 'provider-unavailable');
    }
  }

  private async remove(row: AllocationRow, provider: CloudflareTunnelProvider, lockId: string | undefined): Promise<void> {
    try {
      await provider.removeByName({ stableName: row.stable_tunnel_name, stableHostLabel: row.stable_host_label });
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE machine_endpoint_allocations SET state = 'unallocated', provider_tunnel_id = NULL,
           provider_dns_record_id = NULL, hostname = '', updated_at = ?, retry_at = ?, lock_id = NULL,
           lock_until = 0, error_code = NULL
         WHERE account_id = ? AND machine_id = ? AND allocation_generation = ?
           AND state = 'retiring' AND (? IS NULL OR lock_id = ?)`,
        now,
        now,
        row.account_id,
        row.machine_id,
        row.allocation_generation,
        lockId ?? null,
        lockId ?? null,
      );
    } catch {
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE machine_endpoint_allocations SET retry_at = ?, lock_id = NULL, lock_until = 0,
           attempts = attempts + 1, error_code = 'provider-failed', updated_at = ?
         WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND state = 'retiring'
           AND (? IS NULL OR lock_id = ?)`,
        now + ALLOCATION_RETRY_DELAY_MS,
        now,
        row.account_id,
        row.machine_id,
        row.allocation_generation,
        lockId ?? null,
        lockId ?? null,
      );
    }
  }

  private get(accountId: string, machineId: string): AllocationRow | null {
    return this.ctx.storage.sql
      .exec<AllocationRow>(
        'SELECT * FROM machine_endpoint_allocations WHERE account_id = ? AND machine_id = ?',
        accountId,
        machineId,
      )
      .toArray()[0] ?? null;
  }

  private write(row: AllocationRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO machine_endpoint_allocations
       (account_id, machine_id, host_enrollment_id, endpoint_generation, allocation_generation, state,
        stable_host_label, stable_tunnel_name, hostname, local_service, provider_operation_id,
        provider_tunnel_id, provider_dns_record_id, request_id, created_at, updated_at,
        last_reachable_at, retry_at, attempts, lock_id, lock_until, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, machine_id) DO UPDATE SET
        host_enrollment_id=excluded.host_enrollment_id,
        endpoint_generation=excluded.endpoint_generation,
        allocation_generation=excluded.allocation_generation,
        state=excluded.state, stable_host_label=excluded.stable_host_label,
        stable_tunnel_name=excluded.stable_tunnel_name, hostname=excluded.hostname,
        local_service=excluded.local_service,
        provider_operation_id=excluded.provider_operation_id,
        provider_tunnel_id=excluded.provider_tunnel_id,
        provider_dns_record_id=excluded.provider_dns_record_id,
        request_id=excluded.request_id, created_at=excluded.created_at,
        updated_at=excluded.updated_at, last_reachable_at=excluded.last_reachable_at,
        retry_at=excluded.retry_at, attempts=excluded.attempts, lock_id=excluded.lock_id,
        lock_until=excluded.lock_until, error_code=excluded.error_code`,
      row.account_id,
      row.machine_id,
      row.host_enrollment_id,
      row.endpoint_generation,
      row.allocation_generation,
      row.state,
      row.stable_host_label,
      row.stable_tunnel_name,
      row.hostname,
      row.local_service,
      row.provider_operation_id,
      row.provider_tunnel_id,
      row.provider_dns_record_id,
      row.request_id,
      row.created_at,
      row.updated_at,
      row.last_reachable_at,
      row.retry_at,
      row.attempts,
      row.lock_id,
      row.lock_until,
      row.error_code,
    );
  }

  private touchRow(row: AllocationRow, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE machine_endpoint_allocations SET last_reachable_at = ?, updated_at = ?
       WHERE account_id = ? AND machine_id = ? AND allocation_generation = ? AND state = 'ready'`,
      now,
      now,
      row.account_id,
      row.machine_id,
      row.allocation_generation,
    );
  }

  private consumeRateLimit(accountId: string, now: number): boolean {
    const windowStart = Math.floor(now / (60 * 60 * 1000)) * (60 * 60 * 1000);
    this.ctx.storage.sql.exec(
      `INSERT INTO machine_endpoint_rate_limits(account_id, window_start, requests)
       VALUES (?, ?, 0) ON CONFLICT(account_id, window_start) DO NOTHING`,
      accountId,
      windowStart,
    );
    const row = this.ctx.storage.sql
      .exec<{ requests: number }>(
        'SELECT requests FROM machine_endpoint_rate_limits WHERE account_id = ? AND window_start = ?',
        accountId,
        windowStart,
      )
      .one();
    if (row.requests >= MAX_MUTATIONS_PER_ACCOUNT_PER_HOUR) return false;
    this.ctx.storage.sql.exec(
      `UPDATE machine_endpoint_rate_limits SET requests = requests + 1
       WHERE account_id = ? AND window_start = ?`,
      accountId,
      windowStart,
    );
    return true;
  }
}

interface AllocateInput extends HostGenerationInput {
  endpointGeneration: string;
  hostEnrollmentId: string;
  requestId: string;
  localOrigin: string;
}

interface AccountEnrollmentInput {
  accountId: string;
  enrollmentId: string;
}

interface HostGenerationInput {
  accountId: string;
  machineId: string;
  endpointGeneration: string;
  allocationGeneration?: number;
}

interface TokenInput extends HostGenerationInput {
  allocationGeneration: number;
}

function isAdmissionIssueInput(value: unknown): value is AdmissionIssueInput {
  if (
    !isRecord(value) ||
    typeof value['accountId'] !== 'string' ||
    !ACCOUNT_ID.test(value['accountId']) ||
    typeof value['hostEnrollmentId'] !== 'string' ||
    !HOST_ID.test(value['hostEnrollmentId']) ||
    typeof value['hostMachineId'] !== 'string' ||
    !HOST_ID.test(value['hostMachineId']) ||
    typeof value['endpointGeneration'] !== 'string' ||
    !HOST_GENERATION.test(value['endpointGeneration']) ||
    typeof value['clientPublicKey'] !== 'string' ||
    decodeCanonicalBase64(value['clientPublicKey'], 32) === null ||
    typeof value['bootstrapChallenge'] !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(value['bootstrapChallenge']) ||
    typeof value['requestId'] !== 'string' ||
    !REQUEST_ID.test(value['requestId']) ||
    !isAdmissionPrincipal(value['principal'])
  ) {
    return false;
  }
  return true;
}

function isAdmissionPrincipal(value: unknown): value is AdmissionIssueInput['principal'] {
  if (!isRecord(value)) return false;
  if (value['kind'] === 'enrollment') {
    return (
      typeof value['sourceEnrollmentId'] === 'string' &&
      HOST_ID.test(value['sourceEnrollmentId']) &&
      isStringSet(value['requestedCapabilities'], new Set<string>(MESH_MACHINE_CAPABILITIES), 16) &&
      isStringSet(value['operations'], new Set<string>(MESH_MACHINE_OPERATIONS), 64) &&
      isStringSet(value['scopes'], null, 64, /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/)
    );
  }
  if (value['kind'] === 'dashboard') {
    if (
      typeof value['grantId'] !== 'string' ||
      !HOST_ID.test(value['grantId']) ||
      typeof value['origin'] !== 'string' ||
      value['origin'].length > 512
    ) return false;
    try {
      const origin = new URL(value['origin']);
      return origin.protocol === 'https:' && origin.origin === value['origin'];
    } catch {
      return false;
    }
  }
  return false;
}

function isAdmissionConsumeInput(value: unknown): value is AdmissionConsumeInput {
  return (
    isRecord(value) &&
    typeof value['accountId'] === 'string' &&
    ACCOUNT_ID.test(value['accountId']) &&
    typeof value['hostEnrollmentId'] === 'string' &&
    HOST_ID.test(value['hostEnrollmentId']) &&
    typeof value['hostMachineId'] === 'string' &&
    HOST_ID.test(value['hostMachineId']) &&
    typeof value['endpointGeneration'] === 'string' &&
    HOST_GENERATION.test(value['endpointGeneration']) &&
    typeof value['ticket'] === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value['ticket'])
  );
}

function isStringSet(
  value: unknown,
  allowed: Set<string> | null,
  maxItems: number,
  pattern?: RegExp,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every(
      (item, index) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 128 &&
        value.indexOf(item) === index &&
        (allowed === null ? pattern?.test(item) === true : allowed.has(item)),
    )
  );
}

function sameAdmissionRequest(claimsJson: string, input: AdmissionIssueInput): boolean {
  try {
    const claims = JSON.parse(claimsJson) as MeshMachineAdmissionClaims;
    return (
      claims.accountId === input.accountId &&
      claims.hostEnrollmentId === input.hostEnrollmentId &&
      claims.hostMachineId === input.hostMachineId &&
      claims.endpointGeneration === input.endpointGeneration &&
      claims.clientPublicKey === input.clientPublicKey &&
      claims.bootstrapChallenge === input.bootstrapChallenge &&
      sameAdmissionPrincipal(claims, input.principal)
    );
  } catch {
    return false;
  }
}

function sameAdmissionPrincipal(
  claims: MeshMachineAdmissionClaims,
  principal: AdmissionIssueInput['principal'],
): boolean {
  if (claims.principal.kind !== principal.kind) return false;
  if (claims.principal.kind === 'dashboard' && principal.kind === 'dashboard') {
    return claims.principal.grantId === principal.grantId && claims.principal.origin === principal.origin;
  }
  if (claims.principal.kind === 'enrollment' && principal.kind === 'enrollment') {
    return (
      claims.principal.sourceEnrollmentId === principal.sourceEnrollmentId &&
      sameSorted(claims.principal.requestedCapabilities, principal.requestedCapabilities) &&
      sameSorted(claims.principal.operations, principal.operations) &&
      sameSorted(claims.principal.scopes, principal.scopes)
    );
  }
  return false;
}

function admissionPrincipalId(principal: AdmissionIssueInput['principal']): string {
  return principal.kind === 'enrollment' ? `device:${principal.sourceEnrollmentId}` : `dashboard:${principal.grantId}`;
}

function sameSorted(left: string[], right: string[]): boolean {
  return [...left].sort().join('\0') === [...right].sort().join('\0');
}

function admissionIssueResponse(row: AdmissionRow): Response {
  try {
    return Response.json(
      {
        v: 1,
        ticket: row.ticket,
        claims: JSON.parse(row.claims_json) as MeshMachineAdmissionClaims,
        ...(row.sealed_proof_key_json === null
          ? {}
          : { sealedProofKey: JSON.parse(row.sealed_proof_key_json) as MeshMachineSealedValue }),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return jsonError(503, 'unavailable');
  }
}

function isAllocateInput(value: unknown): value is AllocateInput {
  if (!isRecord(value)) return false;
  return (
    isHostGenerationInput(value) &&
    typeof value['hostEnrollmentId'] === 'string' &&
    HOST_ID.test(value['hostEnrollmentId']) &&
    typeof value['requestId'] === 'string' &&
    REQUEST_ID.test(value['requestId']) &&
    typeof value['localOrigin'] === 'string' &&
    isLoopbackService(value['localOrigin'])
  );
}

function isLoopbackService(value: string): boolean {
  try {
    return normalizeLoopbackService(value) === value;
  } catch {
    return false;
  }
}

function isAccountEnrollmentInput(value: unknown): value is AccountEnrollmentInput {
  return (
    isRecord(value) &&
    typeof value['accountId'] === 'string' &&
    ACCOUNT_ID.test(value['accountId']) &&
    typeof value['enrollmentId'] === 'string' &&
    HOST_ID.test(value['enrollmentId'])
  );
}

function isHostGenerationInput(value: unknown): value is HostGenerationInput {
  return (
    isRecord(value) &&
    typeof value['accountId'] === 'string' &&
    ACCOUNT_ID.test(value['accountId']) &&
    typeof value['machineId'] === 'string' &&
    HOST_ID.test(value['machineId']) &&
    typeof value['endpointGeneration'] === 'string' &&
    HOST_GENERATION.test(value['endpointGeneration']) &&
    (value['allocationGeneration'] === undefined ||
      (Number.isSafeInteger(value['allocationGeneration']) && (value['allocationGeneration'] as number) > 0))
  );
}

function isTokenInput(value: unknown): value is TokenInput {
  return isHostGenerationInput(value) && Number.isSafeInteger(value['allocationGeneration']);
}

function managedProvisioningEnabled(env: Env): boolean {
  return (
    env.ANVIL_MESH_MANAGED_ENDPOINTS === 'true' &&
    providerConfigured(env)
  );
}

function providerConfigured(env: Env): boolean {
  return (
    typeof env.CLOUDFLARE_TUNNEL_ACCOUNT_ID === 'string' &&
    typeof env.CLOUDFLARE_TUNNEL_ZONE_ID === 'string' &&
    typeof env.CLOUDFLARE_TUNNEL_API_TOKEN === 'string' &&
    typeof env.MACHINE_ENDPOINT_DOMAIN === 'string'
  );
}

function createProvider(env: Env): CloudflareTunnelProvider | null {
  if (!providerConfigured(env)) return null;
  try {
    return new CloudflareTunnelProvider({
      accountId: env.CLOUDFLARE_TUNNEL_ACCOUNT_ID!,
      zoneId: env.CLOUDFLARE_TUNNEL_ZONE_ID!,
      apiToken: env.CLOUDFLARE_TUNNEL_API_TOKEN!,
      publicDomain: env.MACHINE_ENDPOINT_DOMAIN!,
    });
  } catch {
    return null;
  }
}

function toView(row: AllocationRow): MachineEndpointAllocationView {
  const view: MachineEndpointAllocationView = {
    machineId: row.machine_id,
    endpointGeneration: row.endpoint_generation,
    allocationGeneration: row.allocation_generation,
    state: row.state,
    ...(row.created_at > 0 ? { createdAt: row.created_at } : {}),
    ...(row.last_reachable_at > 0 ? { lastReachableAt: row.last_reachable_at } : {}),
    ...(row.retry_at > Date.now() ? { retryAt: row.retry_at } : {}),
    ...(row.error_code === 'provider-failed' ? { errorCode: 'provider-failed' as const } : {}),
  };
  if (row.state === 'ready' && row.hostname) {
    view.hostname = row.hostname;
    view.url = `https://${row.hostname}`;
  }
  return view;
}

function emptyView(machineId: string, endpointGeneration: string): MachineEndpointAllocationView {
  return { machineId, endpointGeneration, allocationGeneration: 0, state: 'unallocated' };
}

async function sealToX25519PublicKey(
  clientPublicKey: string,
  plaintext: Uint8Array,
  associatedData: string,
): Promise<MeshMachineSealedValue> {
  const recipientBytes = decodeCanonicalBase64(clientPublicKey, 32);
  if (recipientBytes === null) throw new Error('invalid public key');
  const recipient = await crypto.subtle.importKey('raw', recipientBytes, { name: 'X25519' }, false, []);
  const ephemeral = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephemeralPublicBuffer = (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer;
  const ephemeralPublic = new Uint8Array(ephemeralPublicBuffer);
  // WebCrypto's runtime dictionary property is named `public`; some
  // Workers type definitions spell this as `$public` to work around the JS
  // reserved-word declaration, which is not the key accepted at runtime.
  const deriveParams = { name: 'X25519', public: recipient };
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(deriveParams, ephemeral.privateKey, 256),
  );
  const salt = new Uint8Array(ephemeralPublic.length + recipientBytes.length);
  salt.set(ephemeralPublic);
  salt.set(recipientBytes, ephemeralPublic.length);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  shared.fill(0);
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode('anvil/keyring-wrap/v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(associatedData), tagLength: 128 },
    wrappingKey,
    plaintext,
  );
  return {
    enc: 'x25519-aes-256-gcm',
    ephPub: encodeBase64(ephemeralPublic),
    nonce: encodeBase64(nonce),
    ct: encodeBase64(new Uint8Array(ciphertext)),
  };
}

function decodeCanonicalBase64(value: string, expectedBytes: number): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (binary.length !== expectedBytes || btoa(binary) !== value) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store' } });
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;
  const bytes = await request.arrayBuffer().catch(() => null);
  if (bytes === null || bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export function machineEndpointStub(env: Env): DurableObjectStub {
  return env.MACHINE_ENDPOINTS.get(env.MACHINE_ENDPOINTS.idFromName('machine-endpoints'));
}

/** Truncates account and machine ids to a non-reversible public hostname label. */
export async function stableEndpointLabel(accountId: string, machineId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${accountId}\0${machineId}`),
  );
  const prefix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
  return `host-${prefix}`;
}
