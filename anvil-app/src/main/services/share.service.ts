// Sharing for artifacts, kept sketches and native surfaces (spec §11).
//
// preview → (user confirms in the share dialog) → publish → update / revoke.
//
// - Every share goes through the same build (share-bundle.service) and
//   secret scan (share-secret-scan) for preview and publish, so what the
//   user confirmed is exactly what is sealed.
// - Publish refuses while any secret finding is neither redacted nor
//   explicitly acknowledged by the user.
// - The share URL carries its decryption key in the fragment, which makes
//   it a bearer credential: it is kept only in OS-backed credential
//   storage (an encrypted envelope via auth.service), never in SQLite,
//   logs, sync or model context. The `shares` table keeps the share id.
// - `update` re-seals the current version under the SAME key and share id
//   (stable link). "Share as new link" is a fresh `publish`.
//
// Heavy or Electron-bound modules (offscreen rendering, surface registry,
// clipboard, credential storage) load lazily so this module stays cheap to
// import from chat-artifact.service and from tests.

import { randomUUID } from 'node:crypto';
import type {
  ShareItemType,
  ShareOptionsInput,
  SharePreview,
  ShareRecord,
  ShareSecretFinding,
  ShareTarget,
  ShareAudience,
} from '../../shared/shares-ipc.js';
import type { WorkItemReference } from '../../shared/change-review-types.js';
import {
  SHARE_BUNDLE_MEDIA_TYPE,
  SHARE_DEFAULT_EXPIRES_DAYS,
  SHARE_MAX_EXPIRES_DAYS,
} from '../../shared/shares-ipc.js';
import type { ChatArtifactKind } from '../../shared/types.js';
import type { AgentUISurfaceIntent } from '../../shared/agent-ui-intents.js';
import type {
  AgentToolCallResult,
  AgentToolProvider,
  AgentToolSessionContext,
} from '../agent-tools/dispatch.js';
import { getDb } from '../db/database.js';
import {
  isArtifactSharingAvailable,
  publishSharedArtifact,
  revokeSharedArtifact,
  updateSharedArtifact,
  artifactShareScope,
  getShareAccessOptions,
} from './artifact-share.service.js';
import type {
  ArtifactShareSource,
  BuiltShare,
  ShareBuildOptions,
  SurfaceShareSource,
} from './share-bundle.service.js';
import { redactSecrets, scanForSecrets, unresolvedFindings } from './share-secret-scan.js';
import { BackendRpcError } from './sync-backend-client.service.js';

// ---- rows -------------------------------------------------------------------

interface ShareRow {
  id: string;
  item_type: string;
  item_id: string;
  version: number;
  share_id: string;
  media_type: string;
  interactive: number;
  title: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  audience_json?: string;
  backend_scope?: string | null;
}

interface ArtifactRow {
  id: string;
  thread_id: string;
  title: string;
  kind: string;
  content: string;
  file_path: string | null;
  version: number;
  share_id: string | null;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'markdown',
  'mermaid',
  'code',
  'html',
  'docx',
  'pptx',
  'pdf',
  'csv',
  'xlsx',
  'diagram',
  'data',
  'text',
]);

function mapRecord(row: ShareRow, currentVersion?: number): ShareRecord {
  return {
    id: row.id,
    itemType: row.item_type as ShareItemType,
    itemId: row.item_id,
    version: Number(row.version),
    shareId: row.share_id,
    title: row.title,
    mediaType: row.media_type,
    interactive: row.interactive === 1,
    audience: row.audience_json
      ? (JSON.parse(row.audience_json) as ShareAudience)
      : { kind: 'link' },
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(currentVersion !== undefined ? { currentVersion } : {}),
  };
}

function readShareRow(recordId: string): ShareRow {
  const row = getDb().prepare('SELECT * FROM shares WHERE id = ?').get(recordId) as
    ShareRow | undefined;
  if (!row) throw new Error('Share not found.');
  return row;
}

function readArtifactRow(id: string): ArtifactRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, thread_id, title, kind, content, file_path, version, share_id
       FROM chat_artifacts WHERE id = ?`,
    )
    .get(id) as ArtifactRow | undefined;
}

// ---- share link custody -------------------------------------------------------

/**
 * Where full share URLs (bearer credentials) live. The default store keeps
 * credential-storage envelopes (OS keychain or the encrypted vault, via
 * auth.service) in a 0600 file under userData — never plaintext, never
 * SQLite. Key format: `share-url:<shareRecordId>`.
 */
export interface ShareLinkStore {
  get(key: string): Promise<string | null>;
  /** Returns false when secure storage is unavailable (nothing stored). */
  set(key: string, url: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

function linkKey(recordId: string): string {
  return `share-url:${recordId}`;
}

function createDefaultLinkStore(): ShareLinkStore {
  const filePath = async (): Promise<string> => {
    const [{ app }, { join }] = await Promise.all([import('electron'), import('node:path')]);
    return join(app.getPath('userData'), 'share-links.json');
  };
  const readAll = async (): Promise<Record<string, string>> => {
    const { existsSync, readFileSync } = await import('node:fs');
    const path = await filePath();
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  const writeAll = async (entries: Record<string, string>): Promise<void> => {
    const { renameSync, writeFileSync } = await import('node:fs');
    const path = await filePath();
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    async get(key) {
      const envelope = (await readAll())[key];
      if (typeof envelope !== 'string') return null;
      const { decryptSecretStrict } = await import('./auth.service.js');
      return decryptSecretStrict(Buffer.from(envelope, 'base64')) ?? null;
    },
    async set(key, url) {
      const { encryptSecret, isSecretStorageAvailable } = await import('./auth.service.js');
      if (!isSecretStorageAvailable()) return false;
      const entries = await readAll();
      entries[key] = encryptSecret(url).toString('base64');
      await writeAll(entries);
      return true;
    },
    async delete(key) {
      const entries = await readAll();
      if (!(key in entries)) return;
      delete entries[key];
      await writeAll(entries);
    },
  };
}

let linkStore: ShareLinkStore | null = null;

function links(): ShareLinkStore {
  linkStore ??= createDefaultLinkStore();
  return linkStore;
}

// ---- known secrets -------------------------------------------------------------

type KnownSecretsProvider = () => Promise<string[]>;

function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 6) return;
  if (typeof value === 'string') {
    if (value.length >= 8) into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, into, depth + 1);
  }
}

/**
 * Secrets Anvil already holds: every credential column protected by the
 * credential storage stack (settings integration keys, work-item
 * connection tokens, cloud connection secrets), decrypted only to compare.
 */
async function defaultKnownSecrets(): Promise<string[]> {
  try {
    const [{ SETTINGS_SECRET_COLUMNS }, { decryptSecretStrict }] = await Promise.all([
      import('./credential-storage.service.js'),
      import('./auth.service.js'),
    ]);
    const db = getDb();
    const values: string[] = [];
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as
      Record<string, Buffer | null> | undefined;
    for (const column of Object.values(SETTINGS_SECRET_COLUMNS)) {
      const plain = decryptSecretStrict(settings?.[column] ?? null);
      if (!plain) continue;
      if (column === 'work_item_connections') {
        try {
          collectStrings(JSON.parse(plain), values);
        } catch {
          /* not JSON */
        }
      } else {
        values.push(plain);
      }
    }
    for (const [table, column] of [
      ['cloud_execution_connection', 'token'],
      ['cloud_provider_connections', 'secret_blob'],
    ] as const) {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const rows = db
        .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as { value: Buffer }[];
      for (const row of rows) {
        const plain = decryptSecretStrict(row.value);
        if (!plain) continue;
        try {
          collectStrings(JSON.parse(plain), values);
        } catch {
          values.push(plain);
        }
      }
    }
    // Work-item connection tokens are short-ish ids too; keep only values
    // long enough to be credentials rather than names.
    return [...new Set(values.filter((value) => value.trim().length >= 12))];
  } catch {
    return [];
  }
}

let knownSecretsProvider: KnownSecretsProvider = defaultKnownSecrets;

// ---- targets -------------------------------------------------------------------

type ResolvedTarget =
  | { itemType: 'thread' | 'remote-thread'; itemId: string }
  | {
      itemType: 'artifact';
      itemId: string;
      threadId: string;
      source: ArtifactShareSource;
    }
  | {
      itemType: 'surface';
      itemId: string;
      intent: AgentUISurfaceIntent;
      source: SurfaceShareSource;
    };

const KEEP_FIRST_MESSAGE =
  'Keep this sketch before sharing it. Sharing publishes the kept HTML artifact, never the throwaway sketch.';

function keptArtifactForSketch(sketchId: string): string | null | undefined {
  const row = getDb()
    .prepare('SELECT kept_artifact_id FROM chat_sketches WHERE id = ?')
    .get(sketchId) as { kept_artifact_id: string | null } | undefined;
  if (!row) return undefined;
  return row.kept_artifact_id;
}

async function loadSurface(surfaceId: string): Promise<AgentUISurfaceIntent | null> {
  try {
    const { getSurface } = await import('../surfaces/core.js');
    return getSurface(surfaceId);
  } catch {
    return null;
  }
}

function resolveArtifact(artifactId: string): ResolvedTarget {
  const row = readArtifactRow(artifactId);
  if (!row) throw new Error('Artifact not found.');
  const kind = (ARTIFACT_KINDS.has(row.kind) ? row.kind : 'text') as ChatArtifactKind;
  return {
    itemType: 'artifact',
    itemId: row.id,
    threadId: row.thread_id,
    source: {
      id: row.id,
      title: row.title,
      kind,
      content: row.content,
      filePath: row.file_path,
      version: Number(row.version ?? 1),
    },
  };
}

function dataRecord(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

async function resolveShareTarget(target: ShareTarget): Promise<ResolvedTarget> {
  if (!target || typeof target.itemId !== 'string' || target.itemId.length === 0) {
    throw new Error('Choose something to share.');
  }
  if (target.itemType === 'thread' || target.itemType === 'remote-thread')
    return { ...target, itemType: target.itemType };
  if (target.itemType === 'artifact') return resolveArtifact(target.itemId);
  if (target.itemType !== 'surface') throw new Error('Unsupported share target.');

  const intent = await loadSurface(target.itemId);
  if (!intent) {
    // A sketch id passed directly (the sketch row is the durable record).
    const kept = keptArtifactForSketch(target.itemId);
    if (kept === undefined) throw new Error('Surface not found.');
    if (!kept) throw new Error(KEEP_FIRST_MESSAGE);
    return resolveArtifact(kept);
  }
  const { surfaceKind, title, digest, data } = intent.payload;
  if (surfaceKind === 'sketch') {
    const sketchId = dataRecord(data)['sketchId'];
    const kept = typeof sketchId === 'string' ? keptArtifactForSketch(sketchId) : undefined;
    if (!kept) throw new Error(KEEP_FIRST_MESSAGE);
    return resolveArtifact(kept);
  }
  if (surfaceKind === 'artifact') {
    const artifactId = dataRecord(data)['artifactId'];
    if (typeof artifactId !== 'string') throw new Error('Artifact not found.');
    return resolveArtifact(artifactId);
  }
  if (surfaceKind === 'mcp-app') {
    throw new Error('Third-party app surfaces are not shareable.');
  }
  return {
    itemType: 'surface',
    itemId: intent.id,
    intent,
    source: {
      id: intent.id,
      title,
      surfaceKind,
      revision: intent.revision,
      digest,
      data,
    },
  };
}

// ---- build + scan --------------------------------------------------------------

interface PreparedShare {
  resolved: ResolvedTarget;
  built: BuiltShare;
  findings: ShareSecretFinding[];
  bytes: Uint8Array;
  finalText: string | null;
  contextItems?: SharePreview['contextItems'];
  suggestedTicket?: SharePreview['suggestedTicket'];
}

const preparedShares = new Map<
  string,
  { prepared: PreparedShare; key: string; scope: string | null; expires: number }
>();
const PREVIEW_TTL = 15 * 60 * 1000;

function previewKey(
  target: ShareTarget,
  options: ShareOptionsInput,
  findings: ShareSecretFinding[],
): string {
  const findingIds = new Set(findings.map((finding) => finding.id));
  return JSON.stringify([
    target.itemType,
    target.itemId,
    options.audience ?? { kind: 'link' },
    options.includeComments === true,
    options.includeFullDiff === true,
    clampExpiry(options.expiresInDays),
    [...(options.contextItemIds ?? [])].sort(),
    [...(options.redactFindingIds ?? [])].filter((id) => findingIds.has(id)).sort(),
    options.diagramSvg ?? null,
  ]);
}

function rememberPreview(
  target: ShareTarget,
  options: ShareOptionsInput,
  prepared: PreparedShare,
): string {
  for (const [id, value] of preparedShares)
    if (value.expires < Date.now()) preparedShares.delete(id);
  while (preparedShares.size >= 4) preparedShares.delete(preparedShares.keys().next().value!);
  const id = randomUUID();
  preparedShares.set(id, {
    prepared,
    key: previewKey(target, options, prepared.findings),
    scope: artifactShareScope(),
    expires: Date.now() + PREVIEW_TTL,
  });
  return id;
}

async function preparedForPublication(
  target: ShareTarget,
  options: ShareOptionsInput,
): Promise<PreparedShare> {
  if (!options.preparedId) {
    if (target.itemType === 'thread' || target.itemType === 'remote-thread')
      throw new Error('Preview this thread before publishing.');
    return prepareShare(target, options);
  }
  const saved = preparedShares.get(options.preparedId);
  if (
    !saved ||
    saved.expires < Date.now() ||
    saved.scope !== artifactShareScope() ||
    saved.key !== previewKey(target, options, saved.prepared.findings)
  ) {
    throw new Error(
      'This preview expired or its options/account changed. Preview again before publishing.',
    );
  }
  preparedShares.delete(options.preparedId);
  return saved.prepared;
}

function assertShareScope(row: ShareRow): void {
  if (row.backend_scope && row.backend_scope !== artifactShareScope())
    throw new Error('Connect the account and backend that published this link.');
}

function buildOptions(options: ShareOptionsInput): ShareBuildOptions {
  return {
    includeComments: options.includeComments === true,
    includeFullDiff: options.includeFullDiff === true,
    ...(typeof options.diagramSvg === 'string' ? { diagramSvg: options.diagramSvg } : {}),
  };
}

async function prepareShare(
  target: ShareTarget,
  options: ShareOptionsInput = {},
): Promise<PreparedShare> {
  const resolved = await resolveShareTarget(target);
  const bundles = await import('./share-bundle.service.js');
  let built: BuiltShare;
  let contextItems: SharePreview['contextItems'];
  let suggestedTicket: SharePreview['suggestedTicket'];
  if (resolved.itemType === 'artifact') {
    built = await bundles.buildArtifactShare(resolved.source, buildOptions(options));
  } else if (resolved.itemType === 'surface') {
    const { getMainSurfaceHandler } = await import('../surfaces/index.js');
    built = bundles.buildSurfaceShare(
      resolved.source,
      getMainSurfaceHandler(resolved.source.surfaceKind),
      buildOptions(options),
    );
  } else {
    const { buildThreadShare } = await import('./thread-share.service.js');
    const thread = await buildThreadShare(target, options);
    built = thread;
    contextItems = thread.contextItems;
    suggestedTicket = thread.suggestedTicket;
  }

  let findings: ShareSecretFinding[] = [];
  let finalText = built.text;
  if (built.text !== null) {
    const knownSecrets = await knownSecretsProvider();
    findings = scanForSecrets(built.text, { knownSecrets });
    const ids = new Set(findings.map((finding) => finding.id));
    const redactIds = (options.redactFindingIds ?? []).filter((id) => ids.has(id));
    if (redactIds.length > 0) {
      finalText = redactSecrets(built.text, redactIds, { knownSecrets });
      if (built.mediaType === SHARE_BUNDLE_MEDIA_TYPE) {
        try {
          JSON.parse(finalText);
        } catch {
          throw new Error(
            'Redaction could not be applied cleanly. Edit the content and try again.',
          );
        }
      }
    }
  }
  const bytes =
    finalText !== null ? new TextEncoder().encode(finalText) : (built.binary ?? new Uint8Array());
  if (built.mediaType === SHARE_BUNDLE_MEDIA_TYPE && finalText) {
    const bundle = JSON.parse(finalText) as { title: string };
    built = { ...built, title: bundle.title };
  }
  return { resolved, built, findings, bytes, finalText, contextItems, suggestedTicket };
}

function assertFindingsResolved(prepared: PreparedShare, options: ShareOptionsInput): void {
  const open = unresolvedFindings(
    prepared.findings,
    options.redactFindingIds,
    options.acknowledgeFindingIds,
  );
  if (open.length > 0) {
    throw new Error(
      `Sharing is blocked: ${open.length} possible secret${open.length === 1 ? '' : 's'} must be redacted or confirmed as safe first.`,
    );
  }
}

function clampExpiry(days: number | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) return SHARE_DEFAULT_EXPIRES_DAYS;
  return Math.min(SHARE_MAX_EXPIRES_DAYS, Math.max(1, Math.round(days)));
}

function backendTitle(title: string): string {
  const trimmed = title.trim() || 'Shared item';
  // Backend bound: 256 UTF-8 bytes.
  let clipped = trimmed.slice(0, 120);
  while (Buffer.byteLength(clipped) > 250) clipped = clipped.slice(0, -1);
  return clipped;
}

/** Hosted share URLs are served by the website at this base. */
function shareBaseUrl(): string {
  const configured = process.env.ANVIL_SHARE_BASE_URL;
  return typeof configured === 'string' && configured.length > 0
    ? configured.replace(/\/+$/, '')
    : 'https://anvilstack.dev';
}

function buildShareUrl(shareId: string, shareKey: string): string {
  return `${shareBaseUrl()}/artifacts/${encodeURIComponent(shareId)}#k=${shareKey}`;
}

/** The fragment key (`#k=…`) of a stored share URL. */
export function extractShareKey(url: string): string | null {
  const hash = url.indexOf('#');
  if (hash < 0) return null;
  const key = new URLSearchParams(url.slice(hash + 1)).get('k');
  return key && /^[A-Za-z0-9_-]{43}$/.test(key) ? key : null;
}

function requireSession(): void {
  if (!isArtifactSharingAvailable()) {
    throw new Error('Sharing needs an active Anvil sync session and a configured share viewer.');
  }
}

function itemCurrentVersion(itemType: ShareItemType, itemId: string): number | undefined {
  if (itemType === 'artifact') {
    const row = getDb().prepare('SELECT version FROM chat_artifacts WHERE id = ?').get(itemId) as
      { version: number } | undefined;
    return row ? Number(row.version) : undefined;
  }
  return undefined;
}

/** Keeps the legacy chat_artifacts share columns pointing at the newest live share (URL never stored). */
function syncArtifactShareColumns(artifactId: string): void {
  const db = getDb();
  const latest = db
    .prepare(
      `SELECT share_id, updated_at FROM shares
       WHERE item_type = 'artifact' AND item_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(artifactId) as { share_id: string; updated_at: string } | undefined;
  if (latest) {
    db.prepare(
      `UPDATE chat_artifacts
       SET share_id = ?, shared_url = NULL, shared_at = ?, visibility = 'shareable'
       WHERE id = ?`,
    ).run(latest.share_id, latest.updated_at, artifactId);
  } else {
    db.prepare(
      `UPDATE chat_artifacts
       SET share_id = NULL, shared_url = NULL, shared_at = NULL, visibility = 'local'
       WHERE id = ?`,
    ).run(artifactId);
  }
}

// ---- public API ------------------------------------------------------------------

export function isSharingAvailable(): boolean {
  return isArtifactSharingAvailable();
}

export const shareAccessOptions = getShareAccessOptions;

function ticketMetadata(row: ShareRow) {
  assertShareScope(row);
  if (row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now()))
    throw new Error('Publish a current link before attaching it to a ticket.');
  const audience = mapRecord(row).audience;
  return {
    title: row.title,
    sharedAt: row.updated_at,
    audienceLabel:
      audience?.kind === 'organization'
        ? 'Members of the selected organisation with this link'
        : 'Anyone with the link',
  };
}

export async function previewShareTicketAttachment(recordId: string, ticket: WorkItemReference) {
  const { previewShareTicket } = await import('./share-ticket.service.js');
  return previewShareTicket(ticket, ticketMetadata(readShareRow(recordId)));
}

export async function attachShareTicket(recordId: string, ticket: WorkItemReference) {
  const row = readShareRow(recordId);
  const metadata = ticketMetadata(row);
  const url = await links().get(linkKey(recordId));
  if (!url)
    throw new Error(
      'This link is not stored on this device. Publish a new link before attaching it.',
    );
  assertShareScope(row);
  const { attachShareToTicket } = await import('./share-ticket.service.js');
  return attachShareToTicket(ticket, { ...metadata, shareRecordId: recordId, url }, async () => {
    if ((await links().get(linkKey(recordId))) !== url)
      throw new Error('The shared link changed. Preview the ticket comment again.');
    const current = readShareRow(recordId);
    ticketMetadata(current);
    if (current.updated_at !== row.updated_at || current.share_id !== row.share_id)
      throw new Error('The shared snapshot changed. Preview the ticket comment again.');
  });
}

export async function previewShare(
  target: ShareTarget,
  options: ShareOptionsInput = {},
): Promise<SharePreview> {
  const scope = artifactShareScope();
  const prepared = await prepareShare(target, options);
  const { buildPreviewDocument } = await import('./share-bundle.service.js');
  if (scope !== artifactShareScope()) throw new Error('The sync account changed. Preview again.');
  const { built } = prepared;
  return {
    preparedId: rememberPreview(target, options, prepared),
    ...(prepared.contextItems ? { contextItems: prepared.contextItems } : {}),
    ...(prepared.suggestedTicket ? { suggestedTicket: prepared.suggestedTicket } : {}),
    title: built.title,
    mediaType: built.mediaType,
    interactive: built.interactive,
    previewDocument: buildPreviewDocument({
      title: built.title,
      mediaType: built.mediaType,
      text: prepared.finalText,
      byteLength: prepared.bytes.byteLength,
    }),
    byteLength: prepared.bytes.byteLength,
    secretFindings: prepared.findings,
    version: built.version,
    includes: built.includes,
    availableOptions: built.availableOptions,
    ...(built.text === null ? { unscanned: true } : {}),
  };
}

/**
 * Publishes a new share (a new link). Returns the full URL for the caller
 * to hand to the user; it is never persisted outside credential storage.
 */
export async function publishShare(
  target: ShareTarget,
  options: ShareOptionsInput = {},
): Promise<{ record: ShareRecord; url: string }> {
  requireSession();
  const scope = artifactShareScope();
  const prepared = await preparedForPublication(target, options);
  assertFindingsResolved(prepared, options);
  const { built, resolved } = prepared;
  const { share, shareKey } = await publishSharedArtifact({
    title: backendTitle(built.title),
    bytes: prepared.bytes,
    mediaType: built.mediaType,
    expiresInDays: clampExpiry(options.expiresInDays),
    audience: options.audience ?? { kind: 'link' },
    expectedScope: scope,
  });
  const url = buildShareUrl(share.shareId, shareKey);
  if (scope !== artifactShareScope())
    throw new Error('The sync account changed during publication.');
  const now = new Date().toISOString();
  const row: ShareRow = {
    id: randomUUID(),
    item_type: resolved.itemType,
    item_id: resolved.itemId,
    version: built.version,
    share_id: share.shareId,
    media_type: built.mediaType,
    interactive: built.interactive ? 1 : 0,
    title: built.title,
    expires_at: share.expiresAt,
    created_at: now,
    updated_at: now,
    revoked_at: null,
    audience_json: JSON.stringify(options.audience ?? { kind: 'link' }),
    backend_scope: scope,
  };
  getDb()
    .prepare(
      `INSERT INTO shares (
         id, item_type, item_id, version, share_id, media_type, interactive, title,
         expires_at, created_at, updated_at, revoked_at, audience_json, backend_scope
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      row.id,
      row.item_type,
      row.item_id,
      row.version,
      row.share_id,
      row.media_type,
      row.interactive,
      row.title,
      row.expires_at,
      row.created_at,
      row.updated_at,
      row.audience_json,
      row.backend_scope,
    );
  try {
    await links().set(linkKey(row.id), url);
  } catch {
    // Secure storage refused: the link still works and the caller gets it
    // now; it just can't be copied or updated from this device later.
  }
  if (resolved.itemType === 'artifact') syncArtifactShareColumns(resolved.itemId);
  if (scope !== artifactShareScope())
    throw new Error('The sync account changed during publication. Reconnect it to copy the link.');
  return {
    record: mapRecord(row, itemCurrentVersion(row.item_type as ShareItemType, row.item_id)),
    url,
  };
}

/** Re-publishes the item's current version under the same link and key. */
export async function updateShare(
  shareRecordId: string,
  options: ShareOptionsInput = {},
): Promise<ShareRecord> {
  requireSession();
  const row = readShareRow(shareRecordId);
  assertShareScope(row);
  const scope = artifactShareScope();
  if (
    options.audience &&
    JSON.stringify(options.audience) !== JSON.stringify(mapRecord(row).audience)
  ) {
    throw new Error('Changing access creates a new link. Choose Share as new link.');
  }
  if (row.revoked_at) throw new Error('This link was revoked. Share as a new link instead.');
  const url = await links().get(linkKey(row.id));
  const shareKey = url ? extractShareKey(url) : null;
  if (!shareKey) {
    throw new Error(
      "This link isn't stored on this device, so it can't be updated. Share as a new link instead.",
    );
  }
  const prepared = await preparedForPublication(
    { itemType: row.item_type as ShareItemType, itemId: row.item_id },
    options,
  );
  assertFindingsResolved(prepared, options);
  if (prepared.built.mediaType !== row.media_type) {
    throw new Error(
      'This item now shares as a different format, so the existing link cannot carry it. Share as a new link instead.',
    );
  }
  await updateSharedArtifact({
    shareId: row.share_id,
    title: backendTitle(prepared.built.title),
    shareKey,
    bytes: prepared.bytes,
    mediaType: row.media_type,
    audience: mapRecord(row).audience,
    expectedScope: scope,
  });
  const now = new Date().toISOString();
  getDb()
    .prepare(
      'UPDATE shares SET version = ?, title = ?, interactive = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      prepared.built.version,
      prepared.built.title,
      prepared.built.interactive ? 1 : 0,
      now,
      row.id,
    );
  if (row.item_type === 'artifact') syncArtifactShareColumns(row.item_id);
  const fresh = readShareRow(row.id);
  return mapRecord(fresh, itemCurrentVersion(fresh.item_type as ShareItemType, fresh.item_id));
}

async function revokeRemote(shareId: string, scope = artifactShareScope()): Promise<void> {
  try {
    await revokeSharedArtifact(shareId, { expectedScope: scope });
  } catch (error) {
    // Already gone server-side (expired, swept, account deleted): the goal
    // state holds. Anything else may mean the link is still live.
    if (!(error instanceof BackendRpcError) || error.code !== 'not-found') throw error;
  }
}

function markRevoked(row: ShareRow): void {
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE shares SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, now, row.id);
}

export async function revokeShare(shareRecordId: string): Promise<ShareRecord> {
  const row = readShareRow(shareRecordId);
  assertShareScope(row);
  if (!row.revoked_at) {
    // Revocation must remain possible if a custom viewer is removed or unavailable.
    if (artifactShareScope() === null)
      throw new Error('Connect to Anvil sync to revoke this link.');
    await revokeRemote(row.share_id);
    markRevoked(row);
    await links()
      .delete(linkKey(row.id))
      .catch(() => undefined);
    if (row.item_type === 'artifact') syncArtifactShareColumns(row.item_id);
  }
  return mapRecord(readShareRow(row.id));
}

/** Live (unrevoked) shares of the given items — for "N shared links will be revoked" confirmations. */
export function listLiveSharesForItems(
  itemType: ShareItemType,
  itemIds: readonly string[],
): ShareRecord[] {
  if (itemIds.length === 0) return [];
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT * FROM shares
       WHERE item_type = ? AND item_id IN (${placeholders}) AND revoked_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(itemType, ...itemIds) as ShareRow[];
  return rows.map((row) => mapRecord(row));
}

/**
 * Deletion hook: revokes every live share of the given items. Best-effort
 * per share; failures are returned (not thrown) so the deletion can report
 * which links may still be live.
 */
export async function revokeSharesForItems(
  itemType: ShareItemType,
  itemIds: readonly string[],
): Promise<{ revoked: string[]; failed: { id: string; error: string }[] }> {
  const revoked: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const record of listLiveSharesForItems(itemType, itemIds)) {
    try {
      await revokeShare(record.id);
      revoked.push(record.id);
    } catch (error) {
      failed.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { revoked, failed };
}

export async function listShares(
  filter: { itemType?: ShareItemType; itemId?: string; workspaceId?: string } = {},
): Promise<ShareRecord[]> {
  const scope = artifactShareScope();
  const clauses = ['revoked_at IS NULL'];
  const params: string[] = [];
  if (filter.itemType) {
    clauses.push('item_type = ?');
    params.push(filter.itemType);
  }
  if (typeof filter.itemId === 'string' && filter.itemId.length > 0) {
    clauses.push('item_id = ?');
    params.push(filter.itemId);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM shares WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
    .all(...params) as ShareRow[];

  const records: ShareRecord[] = [];
  for (const row of rows) {
    if (row.backend_scope && row.backend_scope !== artifactShareScope()) continue;
    let currentVersion: number | undefined;
    let workspaceId: string | null | undefined;
    if (row.item_type === 'artifact') {
      const info = getDb()
        .prepare(
          `SELECT a.version AS version, t.workspace_id AS workspace_id
           FROM chat_artifacts a LEFT JOIN chat_threads t ON t.id = a.thread_id
           WHERE a.id = ?`,
        )
        .get(row.item_id) as { version: number; workspace_id: string | null } | undefined;
      currentVersion = info ? Number(info.version) : undefined;
      workspaceId = info?.workspace_id;
    } else if (row.item_type === 'surface') {
      const intent = await loadSurface(row.item_id);
      currentVersion = intent?.revision;
      workspaceId = intent?.scope.workspaceId;
    } else {
      try {
        const { threadShareInfo } = await import('./thread-share.service.js');
        workspaceId = (
          await threadShareInfo({ itemType: row.item_type as ShareItemType, itemId: row.item_id })
        ).workspaceId;
      } catch {
        // Keep orphaned links manageable in the global list if source deletion
        // succeeded but background revocation failed.
      }
    }
    if (filter.workspaceId && workspaceId !== filter.workspaceId) continue;
    records.push(mapRecord(row, currentVersion));
  }
  if (scope !== artifactShareScope())
    throw new Error('The sync account changed. Reload share links.');
  return records;
}

export async function copyShareLink(shareRecordId: string): Promise<boolean> {
  const row = readShareRow(shareRecordId);
  assertShareScope(row);
  if (row.revoked_at) throw new Error('This link was revoked.');
  const url = await links().get(linkKey(row.id));
  if (!url) {
    throw new Error("This link isn't stored on this device. Share as a new link to get one.");
  }
  const { clipboard } = await import('electron');
  assertShareScope(row);
  clipboard.writeText(url);
  return true;
}

// ---- legacy chat artifact entry points ---------------------------------------------

/**
 * `chat:share-artifact`: keeps one stable link per artifact (updates the
 * newest live share when its link is stored here, else publishes a new
 * one). No preview UI exists on this path, so any secret finding blocks.
 * Returns the URL for the caller to hand to the user; it is not persisted.
 */
export async function shareArtifactFromLegacyCaller(artifactId: string): Promise<string> {
  const live = listLiveSharesForItems('artifact', [artifactId]);
  for (const record of live) {
    const url = await links()
      .get(linkKey(record.id))
      .catch(() => null);
    if (url && extractShareKey(url)) {
      await updateShare(record.id);
      return url;
    }
  }
  const { url } = await publishShare({ itemType: 'artifact', itemId: artifactId });
  return url;
}

/**
 * `chat:unshare-artifact`: revokes every live link of the artifact,
 * including a pre-`shares` link recorded only on the artifact row.
 * Propagates any revoke failure other than not-found before touching
 * local state, so a still-live link stays visible for retry.
 */
export async function unshareArtifactFromLegacyCaller(artifactId: string): Promise<void> {
  const artifact = readArtifactRow(artifactId);
  if (!artifact) throw new Error('Artifact not found');
  const live = getDb()
    .prepare(
      "SELECT * FROM shares WHERE item_type = 'artifact' AND item_id = ? AND revoked_at IS NULL",
    )
    .all(artifactId) as ShareRow[];
  const shareIds = new Set(live.map((row) => row.share_id));
  for (const row of live) assertShareScope(row);
  if (artifact.share_id) shareIds.add(artifact.share_id);
  for (const shareId of shareIds) await revokeRemote(shareId);
  for (const row of live) {
    markRevoked(row);
    await links()
      .delete(linkKey(row.id))
      .catch(() => undefined);
  }
  syncArtifactShareColumns(artifactId);
}

/**
 * One-time custody move for links shared before the `shares` table:
 * `chat_artifacts.shared_url` held the full URL (with key) in SQLite.
 * Move each into credential storage under its `shares` row (created by
 * migration 110), give the row its real media type so Update link works,
 * and clear the SQLite copy. Rows whose URL can't be stored securely are
 * left untouched for a later attempt.
 */
export async function migrateLegacySharedUrls(): Promise<number> {
  const db = getDb();
  const legacy = db
    .prepare(
      `SELECT id, kind, file_path, share_id, shared_url FROM chat_artifacts
       WHERE shared_url IS NOT NULL AND share_id IS NOT NULL`,
    )
    .all() as {
    id: string;
    kind: string;
    file_path: string | null;
    share_id: string;
    shared_url: string;
  }[];
  if (legacy.length === 0) return 0;
  const { rawArtifactMediaType } = await import('./share-bundle.service.js');
  let moved = 0;
  for (const artifact of legacy) {
    const row = db
      .prepare("SELECT * FROM shares WHERE item_type = 'artifact' AND share_id = ?")
      .get(artifact.share_id) as ShareRow | undefined;
    if (!row || !extractShareKey(artifact.shared_url)) continue;
    let stored: boolean;
    try {
      stored = await links().set(linkKey(row.id), artifact.shared_url);
    } catch {
      stored = false;
    }
    if (!stored) continue;
    const kind = (ARTIFACT_KINDS.has(artifact.kind) ? artifact.kind : 'text') as ChatArtifactKind;
    if (row.media_type === 'application/octet-stream') {
      db.prepare('UPDATE shares SET media_type = ? WHERE id = ?').run(
        rawArtifactMediaType(kind, artifact.file_path),
        row.id,
      );
    }
    db.prepare('UPDATE chat_artifacts SET shared_url = NULL WHERE id = ?').run(artifact.id);
    moved += 1;
  }
  return moved;
}

// ---- agent tool --------------------------------------------------------------------

function threadWorkspace(threadId: string): string | null | undefined {
  const row = getDb()
    .prepare('SELECT workspace_id FROM chat_threads WHERE id = ?')
    .get(threadId) as { workspace_id: string | null } | undefined;
  return row?.workspace_id;
}

async function assertInScope(
  ctx: AgentToolSessionContext,
  resolved: ResolvedTarget,
): Promise<void> {
  const { AgentToolError } = await import('../agent-tools/dispatch.js');
  if (resolved.itemType === 'artifact') {
    if (ctx.appThreadId && resolved.threadId === ctx.appThreadId) return;
    const workspace = threadWorkspace(resolved.threadId);
    if (ctx.workspaceId && workspace === ctx.workspaceId) return;
  } else if (resolved.itemType === 'surface') {
    const scope = resolved.intent.scope;
    if (ctx.appThreadId && scope.threadId === ctx.appThreadId) return;
    if (ctx.workspaceId && scope.workspaceId === ctx.workspaceId) return;
  }
  throw new AgentToolError('That item is outside this session’s workspace.', 'forbidden');
}

function describeKind(built: BuiltShare): string {
  const [family, kind] = built.kind.split(':');
  const label = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Item';
  return family === 'surface' ? `${label} surface` : `${label} artifact`;
}

const SHARE_ITEM_TOOL = 'share_item';

/**
 * `share_item`: an approval-gated mutation. The user sees the same summary
 * the share dialog would give (title, contents, secret findings,
 * interactivity) and must approve. The URL and key never enter the
 * result, logs or model context; the link goes to the user's clipboard.
 */
export const sharesAgentToolProvider: AgentToolProvider = {
  id: 'shares',
  tools: () => [
    {
      name: SHARE_ITEM_TOOL,
      title: 'Share an artifact or surface',
      description:
        'Publish a read-only share link for an artifact (or a native surface) after the user approves. ' +
        'Sketches must be kept first (sketch_keep). Possible secrets are redacted before upload. ' +
        'Returns {shared, shareId, expiresAt}; the link itself goes only to the user and is never returned to you.',
      inputSchema: {
        type: 'object',
        properties: {
          itemType: { type: 'string', enum: ['artifact', 'surface'] },
          itemId: { type: 'string', minLength: 1 },
          expiresInDays: { type: 'integer', minimum: 1, maximum: SHARE_MAX_EXPIRES_DAYS },
        },
        required: ['itemType', 'itemId'],
        additionalProperties: false,
      },
      mutation: true,
    },
  ],
  async call(ctx, name, args): Promise<AgentToolCallResult | undefined> {
    if (name !== SHARE_ITEM_TOOL) return undefined;
    const { AgentToolError, textResult } = await import('../agent-tools/dispatch.js');
    const itemType = args['itemType'];
    const itemId = args['itemId'];
    const expiresInDays = args['expiresInDays'];
    if (
      (itemType !== 'artifact' && itemType !== 'surface') ||
      typeof itemId !== 'string' ||
      !itemId
    ) {
      throw new AgentToolError(
        'itemType must be "artifact" or "surface" and itemId is required.',
        'invalid-params',
      );
    }
    if (
      expiresInDays !== undefined &&
      (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays))
    ) {
      throw new AgentToolError('expiresInDays must be a whole number of days.', 'invalid-params');
    }
    if (!isArtifactSharingAvailable()) {
      throw new AgentToolError(
        'Sharing needs an active Anvil sync session; ask the user to sign in to Anvil sync.',
        'unavailable',
      );
    }
    const target: ShareTarget = { itemType, itemId };
    let prepared: PreparedShare;
    try {
      prepared = await prepareShare(target, {});
    } catch (error) {
      throw new AgentToolError(
        error instanceof Error ? error.message : String(error),
        'invalid-params',
      );
    }
    await assertInScope(ctx, prepared.resolved);
    const { built, findings } = prepared;
    const days = clampExpiry(expiresInDays as number | undefined);
    const detail = [
      `Title: ${built.title}`,
      `What: ${describeKind(built)}, version ${built.version}`,
      `Includes: ${built.includes.join('; ')}`,
      built.interactive
        ? 'Interactive: yes. Recipients see a static snapshot first and can choose to run the page’s scripts in a sandbox.'
        : 'Interactive: no (static content only).',
      built.text === null
        ? 'Secret scan: not possible for this binary file. Check it yourself before approving.'
        : findings.length === 0
          ? 'Secret scan: nothing found.'
          : `Secret scan: ${findings.length} possible secret${findings.length === 1 ? '' : 's'} found; they will be replaced with [redacted] before upload.`,
      `Expires in ${days} day${days === 1 ? '' : 's'}.`,
    ].join('\n');
    const { requestUserApproval } = await import('../surfaces/core.js');
    const approved = await requestUserApproval(ctx, {
      title: `Share “${built.title}”?`,
      detail,
      consequences:
        'Publishes an encrypted copy outside this workspace. Anyone with the link can view it until you revoke it or it expires.',
    });
    if (!approved) {
      return textResult('The user declined to share this item. Nothing was published.', {
        shared: false,
      });
    }
    const { record, url } = await publishShare(target, {
      expiresInDays: days,
      redactFindingIds: findings.map((finding) => finding.id),
    });
    let copied: boolean;
    try {
      const { clipboard } = await import('electron');
      clipboard.writeText(url);
      copied = true;
    } catch {
      copied = false;
    }
    return textResult(
      `Shared “${record.title}” (version ${record.version}). ${
        copied
          ? 'The link was copied to the user’s clipboard.'
          : 'The user can copy the link from the share controls.'
      } The link is not available to you; do not ask for it.`,
      {
        shared: true,
        shareId: record.shareId,
        ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      },
    );
  },
};

// ---- tests ------------------------------------------------------------------------

export function setShareLinkStoreForTests(store: ShareLinkStore | null): void {
  linkStore = store;
}

export function setKnownSecretsProviderForTests(provider: KnownSecretsProvider | null): void {
  knownSecretsProvider = provider ?? defaultKnownSecrets;
}

/** Used by other outbound publication paths to compare candidates against credentials Anvil already holds. */
export async function getKnownSecretsForPublication(): Promise<string[]> {
  return knownSecretsProvider();
}
