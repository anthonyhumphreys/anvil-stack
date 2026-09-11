import { createHash } from 'node:crypto';
import { app } from 'electron';
import { normalizeBaseUrl, toPublicDescriptor } from './sync-backend-client.service.js';
import { getDb } from '../db/database.js';
import {
  resolveBackendPaths,
  validateDescriptor,
  type BackendDescriptor,
} from '../../../cloud/contract/discovery.js';
import { PROFILES, PROTOCOL } from '../../../cloud/contract/version.js';
import type {
  SyncBackendConnectionMode,
  SyncBackendState,
  SyncBackendStatus,
} from '../../shared/sync-backend.js';

/**
 * Backend association persistence against `sync_backends` (schema 68).
 *
 * One row per pinned backend, keyed by deployment ID. At most one row is
 * `active` at a time; activating a backend pauses the previous active row.
 * Cursors are never copied between backends (each backend owns its sync
 * scope elsewhere). Pinning stores a paused association and never enables
 * upload. No secrets are stored or returned here.
 */

export interface SyncBackendRecord {
  id: string;
  baseUrl: string;
  deploymentId: string | null;
  displayName: string | null;
  profiles: string[];
  authModes: string[];
  descriptor: BackendDescriptor;
  state: SyncBackendState;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PinBackendInput {
  baseUrl: string;
  descriptor: unknown;
}

interface BackendRow {
  id: string;
  base_url: string;
  deployment_id: string | null;
  display_name: string | null;
  profiles_json: string;
  auth_modes_json: string;
  pinned_descriptor_json: string;
  state: SyncBackendState;
  created_at: string | null;
  updated_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isLoopbackHost(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      /^127\./.test(hostname)
    );
  } catch {
    return false;
  }
}

function mapRecord(row: BackendRow): SyncBackendRecord {
  return {
    id: row.id,
    baseUrl: row.base_url,
    deploymentId: row.deployment_id,
    displayName: row.display_name,
    profiles: JSON.parse(row.profiles_json) as string[],
    authModes: JSON.parse(row.auth_modes_json) as string[],
    descriptor: JSON.parse(row.pinned_descriptor_json) as BackendDescriptor,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRowById(id: string): BackendRow | undefined {
  return getDb().prepare('SELECT * FROM sync_backends WHERE id = ?').get(id) as
    | BackendRow
    | undefined;
}

export function listBackends(): SyncBackendRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM sync_backends ORDER BY updated_at DESC, rowid DESC')
    .all() as BackendRow[];
  return rows.map(mapRecord);
}

export function getActiveBackend(): SyncBackendRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM sync_backends WHERE state = 'active' LIMIT 1")
    .get() as BackendRow | undefined;
  return row ? mapRecord(row) : null;
}

/**
 * Stores the user-reviewed descriptor as a paused association. Re-pinning an
 * existing backend refreshes its metadata but preserves its state, so review
 * never silently pauses an active connection or enables upload.
 */
export function pinBackend(input: PinBackendInput): SyncBackendRecord {
  if (typeof input.baseUrl !== 'string' || input.baseUrl.trim().length === 0) {
    throw new Error('backend URL must be a non-empty string');
  }
  const validated = validateDescriptor(input.descriptor);
  if (!validated.ok) {
    throw new Error(`invalid backend descriptor: ${validated.errors.join('; ')}`);
  }
  const descriptor = toPublicDescriptor(validated.descriptor);
  const allowLoopbackHttp = isLoopbackHost(input.baseUrl);
  const normalized = normalizeBaseUrl(input.baseUrl, { allowLoopbackHttp });
  // Re-validates that the descriptor paths stay inside the selected origin.
  resolveBackendPaths(normalized, descriptor, { allowLoopbackHttp });

  const now = nowIso();
  const existing = getRowById(descriptor.deploymentId);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE sync_backends
         SET base_url = ?, deployment_id = ?, display_name = ?,
             profiles_json = ?, auth_modes_json = ?, pinned_descriptor_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalized,
        descriptor.deploymentId,
        descriptor.displayName,
        JSON.stringify(descriptor.profiles),
        JSON.stringify(descriptor.authModes),
        JSON.stringify(descriptor),
        now,
        descriptor.deploymentId,
      );
  } else {
    getDb()
      .prepare(
        `INSERT INTO sync_backends
           (id, base_url, deployment_id, display_name, profiles_json, auth_modes_json,
            pinned_descriptor_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'paused', ?, ?)`,
      )
      .run(
        descriptor.deploymentId,
        normalized,
        descriptor.deploymentId,
        descriptor.displayName,
        JSON.stringify(descriptor.profiles),
        JSON.stringify(descriptor.authModes),
        JSON.stringify(descriptor),
        now,
        now,
      );
  }
  const row = getRowById(descriptor.deploymentId);
  if (!row) {
    throw new Error('failed to persist backend association');
  }
  return mapRecord(row);
}

/** Activates one backend, pausing any previously active row. */
export function activateBackend(id: string): SyncBackendRecord {
  const run = getDb().transaction((): SyncBackendRecord => {
    const db = getDb();
    const existing = getRowById(id);
    if (!existing) {
      throw new Error(`unknown backend ${id}`);
    }
    db.prepare(
      "UPDATE sync_backends SET state = 'paused', updated_at = ? WHERE state = 'active'",
    ).run(nowIso());
    db.prepare("UPDATE sync_backends SET state = 'active', updated_at = ? WHERE id = ?").run(
      nowIso(),
      id,
    );
    const row = getRowById(id);
    if (!row) {
      throw new Error(`failed to activate backend ${id}`);
    }
    return mapRecord(row);
  });
  return run();
}

/** Pauses the active backend, if any. Never deletes history or outbox state. */
export function disconnectBackend(): void {
  getDb()
    .prepare("UPDATE sync_backends SET state = 'paused', updated_at = ? WHERE state = 'active'")
    .run(nowIso());
}

function recordToStatus(
  record: SyncBackendRecord,
  connectionMode: SyncBackendConnectionMode,
): SyncBackendStatus {
  return {
    connectionMode,
    backendId: record.id,
    baseUrl: record.baseUrl,
    deploymentId: record.deploymentId,
    displayName: record.displayName,
    profiles: record.profiles,
    authModes: record.authModes,
    state: record.state,
  };
}

/**
 * Public connection status: endpoint metadata only, no tokens. Reports the
 * active association when connected; otherwise the most recently touched
 * association as a remembered endpoint while the mode stays local.
 */
export function getBackendStatus(): SyncBackendStatus {
  const active = getActiveBackend();
  if (active) {
    return recordToStatus(active, 'compatible');
  }
  const backends = listBackends();
  if (backends.length > 0 && backends[0]) {
    return recordToStatus(backends[0], 'local');
  }
  return {
    connectionMode: 'local',
    backendId: null,
    baseUrl: null,
    deploymentId: null,
    displayName: null,
    profiles: [],
    authModes: [],
    state: null,
  };
}

export function describeBackendState(state: SyncBackendState): string {
  switch (state) {
    case 'active':
      return 'Connected';
    case 'paused':
      return 'Paused';
    case 'disconnected':
      return 'Disconnected';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Stand-in bundle digest until the frozen contract bundle digest exists:
 * sha256 over PROTOCOL joined with PROFILES (`|`-separated). Documented as
 * such in the generated prompt so it is never mistaken for bundle provenance.
 */
function computeContractDigestStandIn(): { digest: string; preimage: string } {
  const preimage = [PROTOCOL, ...PROFILES].join('|');
  return { digest: createHash('sha256').update(preimage).digest('hex'), preimage };
}

/**
 * Fills the integration prompt (mirroring
 * docs/plans/sync-mesh/anvil-backend-builder-prompt.md) with this build's
 * app version, wire protocol, and the stand-in digest. Returned text is
 * safe to display and copy; it carries no secrets.
 */
export function getIntegrationPrompt(): string {
  const appVersion: string = app.getVersion();
  const { digest, preimage } = computeContractDigestStandIn();
  return [
    'Implement a backend that this existing, unmodified Anvil desktop build can connect to.',
    '',
    'Inputs:',
    '',
    `- Anvil app version/build: ${appVersion}`,
    `- Wire protocol: ${PROTOCOL}`,
    `- Required profiles: ${PROFILES.join(', ')}`,
    `- Contract digest (stand-in until the frozen bundle digest exists; sha256 of "${preimage}"): ${digest}`,
    '- Backend repository: <repository or new project directory>',
    "- Chosen hosting provider and database: <operator's choice>",
    '- Required profile: <sync/1 or sync/1 plus mesh/1>',
    '- Public base URL or intended domain: <HTTPS endpoint>',
    '- Supported authentication mode: <oidc-pkce or enrollment-code>',
    "- Scale, retention, and budget constraints: <operator's values>",
    '',
    'The app already implements the network contract. All provider-specific integration belongs',
    'on the backend or in a server-side gateway. Do not fork, patch, rebuild, or install',
    'executable provider plugins into Anvil. Do not require an Anvil-hosted account or service',
    'for a self-owned deployment.',
    '',
    'Implement against the frozen bundle: discovery at `<base>/.well-known/anvil-backend`,',
    `versioned RPC envelopes with protocol "${PROTOCOL}", and the live socket using`,
    'subprotocol `anvil.mesh.v1` with the device bearer in the Authorization header (never in',
    'the URL). Keep credentials out of discovery and connection files. Support `oidc-pkce`',
    'and/or `enrollment-code` enrollment exactly as frozen; do not invent a new token format.',
    'Verify with the official conformance suite and the unmodified Anvil distributable before',
    'claiming compatibility.',
  ].join('\n');
}
