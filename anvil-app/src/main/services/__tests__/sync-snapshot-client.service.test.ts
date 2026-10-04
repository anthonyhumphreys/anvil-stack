import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { DEFAULT_ORCHESTRATION } from '../../../shared/workflow-orchestration';
import {
  SYNC_ENTITY_WORKFLOW_TEMPLATE,
  SYNC_ENTITY_WORKSPACE_DEFINITION,
  type SyncScope,
} from '../../../shared/sync-mesh';
import {
  canonicalizeJson,
  SYNC_SNAPSHOT_SCHEMA_VERSION,
  type ScannedEntity,
  type SyncCursor,
  type SyncPullResult,
  type SyncSnapshotChunkDescriptor,
  type SyncSnapshotChunkGetResult,
  type SyncSnapshotDocument,
  type SyncSnapshotGetResult,
  type SyncSnapshotManifest,
  type SyncedChange,
} from '../../../../cloud/contract/sync';
import {
  BackendRpcError,
  type BackendConnection,
  type RpcResult,
} from '../sync-backend-client.service';

const { active } = vi.hoisted(() => ({
  active: { db: null as unknown as InstanceType<typeof Database> },
}));

vi.mock('../../db/database.js', () => ({ getDb: () => active.db }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : null),
  buildSystemPrompt: () => '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (encrypted: Buffer) => {
      const text = encrypted.toString('utf-8');
      if (!text.startsWith('enc:')) throw new Error('Invalid test safeStorage payload.');
      return text.slice('enc:'.length);
    },
  },
}));

import {
  resetSyncEngineForTests,
  runSyncCycle,
  SyncEngineError,
  type SyncEngineRpc,
} from '../sync-engine.service';
import {
  canonicalJson,
  getBinding,
  getSyncState,
  insertUnresolvedConflict,
  listConflicts,
  listOutboxRows,
  listPausedInboundChanges,
  updateSyncState,
  upsertBinding,
  upsertEnrollment,
} from '../sync-persistence.service';
import {
  installAccountKey,
  sealAccountBytes,
  sealEntityPayload,
  unsealAccountBytes,
  unsealEntityPayload,
} from '../sync-keyring.service';
import { getWorkflowTemplate, saveWorkflowTemplate } from '../workflow.service';
import { buildEntityPayload } from '../sync-entity-domain';
import { createWorkspace, updateWorkspace } from '../workspace.service';

const SCOPE: SyncScope = {
  backendId: 'snapshot-backend',
  accountId: 'snapshot-account',
  datasetEpoch: 'epoch-1',
};
const CONNECTION = { apiUrl: 'https://example.test/api/' };
const ENROLLMENT = 'snapshot-enrollment';
const KEY_VERSION = 1;
const SNAPSHOT_AAD = (keyVersion: number, cursor: string): string =>
  `anvil/sync-snapshot/v2:${SCOPE.backendId}:${SCOPE.accountId}:${SCOPE.datasetEpoch}:${keyVersion}:${cursor}`;

type StoredChunk = SyncSnapshotChunkGetResult;

interface SnapshotFixture {
  manifest: SyncSnapshotManifest;
  chunk: StoredChunk;
}

interface SnapshotRpcOptions {
  scanEntities?: ScannedEntity[];
  scanWatermark?: number;
  scanWatermarkStart?: number;
  catchupByCursor?: Map<string, SyncPullResult>;
  snapshotGets?: SyncSnapshotGetResult[];
  recoveryChunks?: Map<string, StoredChunk>;
  corruptPublicationReadback?: boolean;
  failPublicationBegin?: boolean;
}

interface SnapshotRpcHarness {
  rpc: SyncEngineRpc;
  calls: Array<{ operation: string; params: unknown }>;
  uploadedChunks: Map<string, Buffer>;
}

let tmpDir: string;

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function templatePayload(id: string, name: string) {
  return {
    id,
    name,
    description: 'Snapshot integration fixture',
    nodes: [
      {
        id: 'step-1',
        name: 'step-1',
        prompt: `Run ${name}`,
        personaId: 'coder',
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium' as const,
        executionStrategy: 'adaptive' as const,
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    orchestration: { ...DEFAULT_ORCHESTRATION },
  };
}

function templateInput(name: string) {
  return {
    name,
    description: 'Snapshot integration fixture',
    nodes: templatePayload('unused', name).nodes,
    edges: [],
    orchestration: { ...DEFAULT_ORCHESTRATION },
  };
}

function wireTemplate(id: string, name: string): unknown {
  return sealEntityPayload(
    SCOPE,
    {
      entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
      entityId: id,
      operation: 'update',
      schemaVersion: 1,
    },
    templatePayload(id, name),
  );
}

function scanTemplate(id: string, revision: number, name: string): ScannedEntity {
  return {
    entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
    entityId: id,
    revision,
    operation: 'update',
    schemaVersion: 1,
    payload: wireTemplate(id, name),
  };
}

function pullChange(
  id: string,
  sequence: number,
  operation: 'create' | 'update' | 'delete',
  name?: string,
  revision = sequence,
): SyncedChange {
  return {
    entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
    entityId: id,
    revision,
    operation,
    schemaVersion: 1,
    sequence,
    ...(name === undefined ? {} : { payload: wireTemplate(id, name) }),
  };
}

function makeSnapshot(
  cursor: string,
  entities: SyncSnapshotDocument['entities'],
  options: { snapshotId?: string; generation?: number; keyVersion?: number } = {},
): SnapshotFixture {
  const keyVersion = options.keyVersion ?? KEY_VERSION;
  const document: SyncSnapshotDocument = {
    formatVersion: 2,
    datasetEpoch: SCOPE.datasetEpoch,
    keyVersion,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: cursor as SyncCursor,
    entities,
  };
  const compressed = gzipSync(Buffer.from(canonicalizeJson(document), 'utf8'), { level: 6 });
  const sealed = sealAccountBytes(SCOPE, SNAPSHOT_AAD(keyVersion, cursor), compressed);
  const descriptor: SyncSnapshotChunkDescriptor = {
    index: 0,
    byteLength: sealed.bytes.byteLength,
    sha256: hash(sealed.bytes),
  };
  const manifest: SyncSnapshotManifest = {
    formatVersion: 2,
    snapshotId: options.snapshotId ?? `snapshot-${cursor}`,
    generation: options.generation ?? 1,
    datasetEpoch: SCOPE.datasetEpoch,
    keyVersion,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: cursor as SyncCursor,
    entityCount: entities.filter((entity) => entity.operation !== 'delete').length,
    tombstoneCount: entities.filter((entity) => entity.operation === 'delete').length,
    manifestSha256: 'a'.repeat(64),
    chunks: [descriptor],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
  return {
    manifest,
    chunk: {
      ...descriptor,
      bytesBase64: sealed.bytes.toString('base64'),
    },
  };
}

function snapshotGet(overrides: Partial<SyncSnapshotGetResult> = {}): SyncSnapshotGetResult {
  return {
    datasetEpoch: SCOPE.datasetEpoch,
    keyVersion: KEY_VERSION,
    currentCursor: '2' as SyncCursor,
    recoveryFloor: 0,
    manifest: null,
    previousManifest: null,
    ...overrides,
  };
}

function manifestAt(cursor: string, generation: number): SyncSnapshotManifest {
  return {
    formatVersion: 2,
    snapshotId: `snapshot-generation-${generation}`,
    generation,
    datasetEpoch: SCOPE.datasetEpoch,
    keyVersion: KEY_VERSION,
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    committedCursor: cursor as SyncCursor,
    entityCount: 0,
    tombstoneCount: 0,
    manifestSha256: 'b'.repeat(64),
    chunks: [{ index: 0, byteLength: 28, sha256: 'c'.repeat(64) }],
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function createRpcHarness(options: SnapshotRpcOptions = {}): SnapshotRpcHarness {
  const calls: SnapshotRpcHarness['calls'] = [];
  const uploadedChunks = new Map<string, Buffer>();
  const snapshotGets = [...(options.snapshotGets ?? [snapshotGet()])];
  const initialSnapshot = options.snapshotGets?.[0];
  let remoteManifest = initialSnapshot?.manifest ?? null;
  let remotePreviousManifest = initialSnapshot?.previousManifest ?? null;
  let remoteCurrentCursor = initialSnapshot?.currentCursor ?? ('2' as SyncCursor);
  let pendingPublication: Record<string, unknown> | null = null;
  const harness: SnapshotRpcHarness = {
    calls,
    uploadedChunks,
    rpc: async <R = unknown>(
      _connection: Pick<BackendConnection, 'apiUrl'>,
      operation: string,
      params: unknown,
      _accessToken: string,
    ): Promise<RpcResult<R>> => {
      calls.push({ operation, params });
      const input = (params ?? {}) as Record<string, unknown>;
      let result: unknown;
      switch (operation) {
        case 'sync.push':
          result = { results: [] };
          break;
        case 'sync.snapshot.get':
          {
            const queued = snapshotGets.shift();
            if (queued !== undefined) {
              remoteManifest = queued.manifest;
              remotePreviousManifest = queued.previousManifest;
              remoteCurrentCursor = queued.currentCursor;
              result = queued;
            } else {
              result = snapshotGet({
                currentCursor: remoteCurrentCursor,
                manifest: remoteManifest,
                previousManifest: remotePreviousManifest,
              });
            }
          }
          break;
        case 'sync.scan.begin':
          result = {
            scanId: 'scan-full-1',
            watermarkStart: options.scanWatermarkStart ?? 0,
            resumeCursor: String(options.scanWatermarkStart ?? 0) as SyncCursor,
            epoch: SCOPE.datasetEpoch,
          };
          break;
        case 'sync.scan.page':
          result = {
            entities: options.scanEntities ?? [],
            nextCursor: null,
            done: true,
          };
          break;
        case 'sync.scan.finish': {
          const watermark = options.scanWatermark ?? 2;
          result = {
            scanId: 'scan-full-1',
            complete: true,
            watermarkEnd: watermark,
            epoch: SCOPE.datasetEpoch,
            nextCursor: String(watermark) as SyncCursor,
          };
          break;
        }
        case 'sync.pull': {
          const cursor = typeof input['cursor'] === 'string' ? input['cursor'] : '0';
          const scanStart = String(options.scanWatermarkStart ?? 0);
          result = options.catchupByCursor?.get(cursor) ?? {
            changes: [],
            hasMore: false,
            nextCursor:
              cursor === scanStart
                ? (String(options.scanWatermark ?? 2) as SyncCursor)
                : (cursor as SyncCursor),
            recoveryFloor: 0,
          };
          break;
        }
        case 'sync.snapshot.begin':
          if (options.failPublicationBegin) {
            throw new BackendRpcError({ code: 'stale-generation', retryable: false });
          }
          pendingPublication = input;
          result = {
            publicationId: input['publicationId'],
            uploadExpiresAt: '2026-10-05T00:00:00Z',
          };
          break;
        case 'sync.snapshot.chunk.put':
          uploadedChunks.set(
            `${String(input['publicationId'])}:${String(input['index'])}`,
            Buffer.from(String(input['bytesBase64']), 'base64'),
          );
          result = {
            publicationId: input['publicationId'],
            index: input['index'],
            sha256: '',
            byteLength: 0,
            alreadyUploaded: false,
          };
          break;
        case 'sync.snapshot.chunk.get': {
          const snapshotId = String(input['snapshotId']);
          const index = Number(input['index']);
          const stored =
            options.recoveryChunks?.get(`${snapshotId}:${index}`) ??
            (() => {
              const bytes = uploadedChunks.get(`${snapshotId}:${index}`);
              if (bytes === undefined) return undefined;
              const returned =
                options.corruptPublicationReadback === true
                  ? Buffer.concat([bytes, Buffer.from([0x7f])])
                  : bytes;
              return {
                index,
                byteLength: bytes.byteLength,
                sha256: hash(bytes),
                bytesBase64: returned.toString('base64'),
              };
            })();
          if (stored === undefined) throw new Error(`No chunk ${snapshotId}:${index}`);
          result = stored;
          break;
        }
        case 'sync.snapshot.verify':
          result = { publicationId: input['publicationId'], verified: true };
          break;
        case 'sync.snapshot.commit': {
          if (pendingPublication === null) throw new Error('No snapshot publication is pending');
          remotePreviousManifest = remoteManifest;
          remoteManifest = {
            formatVersion: 2,
            snapshotId: String(pendingPublication['publicationId']),
            generation: Number(pendingPublication['expectedGeneration']) + 1,
            datasetEpoch: String(pendingPublication['datasetEpoch']),
            keyVersion: Number(pendingPublication['keyVersion']),
            schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
            committedCursor: String(pendingPublication['committedCursor']) as SyncCursor,
            entityCount: Number(pendingPublication['entityCount']),
            tombstoneCount: Number(pendingPublication['tombstoneCount']),
            manifestSha256: String(pendingPublication['manifestSha256']),
            chunks: pendingPublication['chunks'] as SyncSnapshotChunkDescriptor[],
            createdAt: '2026-10-01T00:00:00.000Z',
          } satisfies SyncSnapshotManifest;
          remoteCurrentCursor = String(pendingPublication['committedCursor']) as SyncCursor;
          pendingPublication = null;
          result = { manifest: null, previousGeneration: null };
          break;
        }
        default:
          throw new Error(`Unexpected RPC operation ${operation}`);
      }
      return { result: result as R, serverTime: '2026-10-01T00:00:00.000Z' };
    },
  };
  return harness;
}

function cycle(
  rpc: SyncEngineRpc,
  options: { writeGate?: () => { allowed: boolean } } = {},
): Promise<void> {
  return runSyncCycle({
    accessToken: 'access-token',
    connection: CONNECTION,
    enrollmentId: ENROLLMENT,
    rpc,
    scope: SCOPE,
    ...options,
  });
}

function seedBoundTemplate(name: string): { id: string } {
  const saved = saveWorkflowTemplate(templateInput(name));
  const payload = templatePayload(saved.id, name);
  upsertBinding(SCOPE, SYNC_ENTITY_WORKFLOW_TEMPLATE, saved.id, {
    basePayloadJson: canonicalJson(payload),
    baseRevision: 1,
  });
  return saved;
}

function publishedDocument(harness: SnapshotRpcHarness): SyncSnapshotDocument {
  const begin = harness.calls.find((call) => call.operation === 'sync.snapshot.begin')?.params as
    | { publicationId: string; committedCursor: string; keyVersion: number }
    | undefined;
  expect(begin).toBeDefined();
  const sealedBytes = harness.uploadedChunks.get(`${begin!.publicationId}:0`);
  expect(sealedBytes).toBeDefined();
  const compressed = unsealAccountBytes(
    SCOPE,
    SNAPSHOT_AAD(begin!.keyVersion, begin!.committedCursor),
    begin!.keyVersion,
    sealedBytes!,
  );
  return JSON.parse(gunzipSync(compressed).toString('utf8')) as SyncSnapshotDocument;
}

function recoveryEntity(
  entityType: string,
  entityId: string,
  revision: number,
  payload: unknown,
): SyncSnapshotDocument['entities'][number] {
  return {
    entityType,
    entityId,
    revision,
    operation: 'update',
    schemaVersion: 1,
    payload: sealEntityPayload(
      SCOPE,
      {
        entityType,
        entityId,
        operation: 'update',
        schemaVersion: 1,
      },
      payload,
    ),
  };
}

function recoveryGet(
  current: SnapshotFixture | null,
  previous: SnapshotFixture | null = null,
  currentCursor = current?.manifest.committedCursor ?? ('1' as SyncCursor),
): SyncSnapshotGetResult {
  return snapshotGet({
    currentCursor,
    recoveryFloor: 0,
    manifest: current?.manifest ?? null,
    previousManifest: previous?.manifest ?? null,
  });
}

function recoveryChunks(...snapshots: Array<SnapshotFixture | null>): Map<string, StoredChunk> {
  const chunks = new Map<string, StoredChunk>();
  for (const snapshot of snapshots) {
    if (snapshot === null) continue;
    chunks.set(`${snapshot.manifest.snapshotId}:0`, snapshot.chunk);
  }
  return chunks;
}

beforeEach(() => {
  resetSyncEngineForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'sync-snapshot-client-'));
  active.db = new Database(join(tmpDir, 'sync.db'));
  active.db.exec(SCHEMA_SQL);
  active.db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run();
  installAccountKey(SCOPE, KEY_VERSION, Buffer.alloc(32, 0x41), 'recovery');
  upsertEnrollment({
    displayName: 'Snapshot test device',
    id: ENROLLMENT,
    installationId: 'snapshot-installation',
    scope: SCOPE,
    state: 'active',
  });
});

afterEach(() => {
  active.db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Sync snapshot publication from an authoritative scan', () => {
  it('publishes the full scanned state plus tombstones and catch-up, excluding sparse local bindings', async () => {
    const staleBound = seedBoundTemplate('Stale local copy');
    const scannedTombstone = seedBoundTemplate('Will be deleted by scan');
    const caughtUpTombstone = seedBoundTemplate('Will be deleted by catch-up');
    const sparseLocal = saveWorkflowTemplate(templateInput('Unbound local only'));

    const catchupChanges = [
      pullChange('remote-present', 1, 'update', 'After catch-up', 2),
      pullChange(caughtUpTombstone.id, 2, 'delete'),
    ];
    const harness = createRpcHarness({
      scanEntities: [
        scanTemplate('remote-present', 1, 'Before catch-up'),
        {
          entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
          entityId: scannedTombstone.id,
          revision: 2,
          operation: 'delete',
          schemaVersion: 1,
        },
        scanTemplate(caughtUpTombstone.id, 1, 'Before catch-up delete'),
      ],
      scanWatermark: 2,
      catchupByCursor: new Map([
        [
          '0',
          {
            changes: catchupChanges,
            hasMore: false,
            nextCursor: '2' as SyncCursor,
            recoveryFloor: 0,
          },
        ],
      ]),
      snapshotGets: [snapshotGet(), snapshotGet({ currentCursor: '2' as SyncCursor })],
    });

    updateSyncState(SCOPE, { resetRequired: true });
    await cycle(harness.rpc);

    expect(getWorkflowTemplate('remote-present')?.name).toBe('After catch-up');
    expect(getWorkflowTemplate(scannedTombstone.id)).toBeNull();
    expect(getWorkflowTemplate(caughtUpTombstone.id)).toBeNull();
    expect(getWorkflowTemplate(staleBound.id)).toBeNull();
    expect(getBinding(SCOPE, SYNC_ENTITY_WORKFLOW_TEMPLATE, staleBound.id)).toBeNull();
    expect(getWorkflowTemplate(sparseLocal.id)?.name).toBe('Unbound local only');

    const beginCall = harness.calls.find((call) => call.operation === 'sync.snapshot.begin');
    expect(beginCall?.params).toMatchObject({
      committedCursor: '2',
      entityCount: 1,
      tombstoneCount: 2,
      scanId: 'scan-full-1',
    });
    const document = publishedDocument(harness);
    expect(document.committedCursor).toBe('2');
    expect(document.entities).toHaveLength(3);
    expect(
      document.entities.map((entity) => `${entity.entityId}:${entity.operation}`).sort(),
    ).toEqual(
      [
        'remote-present:update',
        `${scannedTombstone.id}:delete`,
        `${caughtUpTombstone.id}:delete`,
      ].sort(),
    );
    expect(document.entities.some((entity) => entity.entityId === staleBound.id)).toBe(false);
    expect(document.entities.some((entity) => entity.entityId === sparseLocal.id)).toBe(false);
    const remotePresent = document.entities.find((entity) => entity.entityId === 'remote-present');
    expect(
      unsealEntityPayload(
        SCOPE,
        {
          entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
          entityId: 'remote-present',
        },
        remotePresent?.payload,
      ),
    ).toMatchObject({ name: 'After catch-up' });

    const publicationOrder = harness.calls
      .filter((call) => call.operation.startsWith('sync.snapshot.'))
      .map((call) => call.operation);
    expect(publicationOrder).toEqual([
      'sync.snapshot.get',
      'sync.snapshot.get',
      'sync.snapshot.begin',
      'sync.snapshot.chunk.put',
      'sync.snapshot.chunk.get',
      'sync.snapshot.verify',
      'sync.snapshot.commit',
    ]);
    const begin = beginCall?.params as {
      publicationId: string;
      manifestSha256: string;
      chunks: SyncSnapshotChunkDescriptor[];
    };
    const uploaded = harness.uploadedChunks.get(`${begin.publicationId}:0`)!;
    expect(begin.chunks).toEqual([
      { index: 0, byteLength: uploaded.byteLength, sha256: hash(uploaded) },
    ]);
    expect(harness.calls.find((call) => call.operation === 'sync.snapshot.verify')?.params).toEqual(
      {
        publicationId: begin.publicationId,
        manifestSha256: begin.manifestSha256,
      },
    );
    expect(getSyncState(SCOPE)?.resetRequired).toBe(false);
  });

  it('does not verify, commit, or activate when chunk readback fails its digest', async () => {
    const existing = seedBoundTemplate('Keep until snapshot verifies');
    const harness = createRpcHarness({
      scanEntities: [],
      scanWatermark: 1,
      snapshotGets: [snapshotGet(), snapshotGet({ currentCursor: '1' as SyncCursor })],
      corruptPublicationReadback: true,
    });
    updateSyncState(SCOPE, { resetRequired: true });

    await expect(cycle(harness.rpc)).rejects.toMatchObject({
      code: 'snapshot-verification-failed',
    });

    expect(getWorkflowTemplate(existing.id)?.name).toBe('Keep until snapshot verifies');
    expect(getBinding(SCOPE, SYNC_ENTITY_WORKFLOW_TEMPLATE, existing.id)?.baseRevision).toBe(1);
    expect(harness.calls.some((call) => call.operation === 'sync.snapshot.verify')).toBe(false);
    expect(harness.calls.some((call) => call.operation === 'sync.snapshot.commit')).toBe(false);
    expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
  });

  it.each([
    ['epoch', snapshotGet({ datasetEpoch: 'epoch-2' }), false],
    ['key version', snapshotGet({ keyVersion: KEY_VERSION + 1 }), false],
    ['generation', snapshotGet({ manifest: manifestAt('1', 4) }), true],
  ])(
    'keeps visible state intact when publication has a %s mismatch',
    async (_kind, publishInfo, failBegin) => {
      const existing = seedBoundTemplate('Preserve on failed publication');
      const harness = createRpcHarness({
        scanEntities: [],
        scanWatermark: 2,
        snapshotGets: [snapshotGet(), publishInfo],
        ...(failBegin ? { failPublicationBegin: true } : {}),
      });
      updateSyncState(SCOPE, { resetRequired: true });

      await expect(cycle(harness.rpc)).rejects.toBeInstanceOf(SyncEngineError);

      expect(getWorkflowTemplate(existing.id)?.name).toBe('Preserve on failed publication');
      expect(getBinding(SCOPE, SYNC_ENTITY_WORKFLOW_TEMPLATE, existing.id)?.baseRevision).toBe(1);
      expect(harness.calls.some((call) => call.operation === 'sync.snapshot.commit')).toBe(false);
      expect(getSyncState(SCOPE)?.resetRequired).toBe(true);
    },
  );
});

describe('Sync snapshot recovery', () => {
  it('restores the current manifest and replays its retained journal tail before normal pulls', async () => {
    const snapshot = makeSnapshot('1', [
      recoveryEntity(
        SYNC_ENTITY_WORKFLOW_TEMPLATE,
        'snapshot-current',
        1,
        templatePayload('snapshot-current', 'From current manifest'),
      ),
    ]);
    const tail = pullChange('snapshot-current', 2, 'update', 'After retained journal tail');
    const harness = createRpcHarness({
      snapshotGets: [recoveryGet(snapshot, null, '2' as SyncCursor)],
      recoveryChunks: recoveryChunks(snapshot),
      catchupByCursor: new Map([
        [
          '1',
          {
            changes: [tail],
            hasMore: false,
            nextCursor: '2' as SyncCursor,
            recoveryFloor: 1,
          },
        ],
      ]),
    });
    updateSyncState(SCOPE, { resetRequired: true });

    await cycle(harness.rpc);

    expect(getWorkflowTemplate('snapshot-current')?.name).toBe('After retained journal tail');
    expect(getBinding(SCOPE, SYNC_ENTITY_WORKFLOW_TEMPLATE, 'snapshot-current')?.baseRevision).toBe(
      2,
    );
    expect(getSyncState(SCOPE)).toMatchObject({ cursor: '2', resetRequired: false });
    expect(harness.calls.some((call) => call.operation === 'sync.scan.begin')).toBe(false);
    expect(harness.calls.filter((call) => call.operation === 'sync.pull')).toHaveLength(2);
  });

  it('falls back to the previous verified manifest when the current generation chunk is corrupt', async () => {
    const current = makeSnapshot(
      '2',
      [
        recoveryEntity(
          SYNC_ENTITY_WORKFLOW_TEMPLATE,
          'fallback-template',
          2,
          templatePayload('fallback-template', 'Corrupt current'),
        ),
      ],
      { snapshotId: 'snapshot-current', generation: 2 },
    );
    const previous = makeSnapshot(
      '1',
      [
        recoveryEntity(
          SYNC_ENTITY_WORKFLOW_TEMPLATE,
          'fallback-template',
          1,
          templatePayload('fallback-template', 'Previous generation'),
        ),
      ],
      { snapshotId: 'snapshot-previous', generation: 1 },
    );
    const corruptCurrentChunk = {
      ...current.chunk,
      bytesBase64: Buffer.from('corrupt-current-chunk').toString('base64'),
    };
    const tail = pullChange('fallback-template', 2, 'update', 'Caught up from previous');
    const harness = createRpcHarness({
      snapshotGets: [recoveryGet({ ...current, chunk: corruptCurrentChunk }, previous, '2')],
      recoveryChunks: recoveryChunks({ ...current, chunk: corruptCurrentChunk }, previous),
      catchupByCursor: new Map([
        [
          '1',
          {
            changes: [tail],
            hasMore: false,
            nextCursor: '2' as SyncCursor,
            recoveryFloor: 1,
          },
        ],
      ]),
    });
    updateSyncState(SCOPE, { resetRequired: true });

    await cycle(harness.rpc);

    expect(getWorkflowTemplate('fallback-template')?.name).toBe('Caught up from previous');
    expect(getSyncState(SCOPE)).toMatchObject({ cursor: '2', resetRequired: false });
    expect(
      harness.calls
        .filter((call) => call.operation === 'sync.snapshot.chunk.get')
        .map((call) => (call.params as { snapshotId: string }).snapshotId),
    ).toEqual(['snapshot-current', 'snapshot-previous']);
    expect(harness.calls.some((call) => call.operation === 'sync.scan.begin')).toBe(false);
  });

  it('preserves dirty local edits and defers opted-out workspace changes during recovery', async () => {
    const dirty = seedBoundTemplate('Original clean base');
    saveWorkflowTemplate(templateInput('Pending local edit'), dirty.id);
    const conflictLocal = seedBoundTemplate('Existing conflict local');
    insertUnresolvedConflict(SCOPE, {
      entityType: SYNC_ENTITY_WORKFLOW_TEMPLATE,
      entityId: conflictLocal.id,
      kind: 'edit-edit',
      basePayloadJson: canonicalJson(templatePayload(conflictLocal.id, 'Existing conflict base')),
      baseRevision: 1,
      localPayloadJson: canonicalJson(templatePayload(conflictLocal.id, 'Existing conflict local')),
      remotePayloadJson: canonicalJson(templatePayload(conflictLocal.id, 'Existing remote side')),
      remoteRevision: 2,
    });
    const optedOut = createWorkspace({ name: 'Local workspace copy', syncSelected: true });
    const workspacePayload = buildEntityPayload(SYNC_ENTITY_WORKSPACE_DEFINITION, optedOut.id);
    expect(workspacePayload).not.toBeNull();
    updateWorkspace(optedOut.id, { syncSelected: false });

    const snapshot = makeSnapshot('1', [
      recoveryEntity(
        SYNC_ENTITY_WORKFLOW_TEMPLATE,
        dirty.id,
        2,
        templatePayload(dirty.id, 'Remote version'),
      ),
      recoveryEntity(
        SYNC_ENTITY_WORKFLOW_TEMPLATE,
        conflictLocal.id,
        3,
        templatePayload(conflictLocal.id, 'New remote conflict version'),
      ),
      recoveryEntity(SYNC_ENTITY_WORKSPACE_DEFINITION, optedOut.id, 4, {
        ...(workspacePayload as Record<string, unknown>),
        name: 'Remote opted-out copy',
      }),
    ]);
    const harness = createRpcHarness({
      snapshotGets: [recoveryGet(snapshot)],
      recoveryChunks: recoveryChunks(snapshot),
    });
    updateSyncState(SCOPE, { resetRequired: true });

    await cycle(harness.rpc, { writeGate: () => ({ allowed: false }) });

    expect(getWorkflowTemplate(dirty.id)?.name).toBe('Pending local edit');
    expect(
      listOutboxRows(SCOPE).some((row) => row.entityId === dirty.id && row.state === 'pending'),
    ).toBe(true);
    expect(listConflicts(SCOPE).some((conflict) => conflict.entityId === dirty.id)).toBe(true);
    expect(listConflicts(SCOPE).some((conflict) => conflict.entityId === conflictLocal.id)).toBe(
      true,
    );
    expect(getWorkflowTemplate(conflictLocal.id)?.name).toBe('Existing conflict local');
    expect(
      active.db.prepare('SELECT name, sync_selected FROM workspaces WHERE id = ?').get(optedOut.id),
    ).toEqual({ name: 'Local workspace copy', sync_selected: 0 });
    expect(listPausedInboundChanges(SCOPE)).toHaveLength(1);
    expect(harness.calls.some((call) => call.operation === 'sync.push')).toBe(false);
    expect(harness.calls.some((call) => call.operation === 'sync.scan.begin')).toBe(false);
  });
});

describe('opportunistic snapshot cadence', () => {
  it('publishes the first image, suppresses hourly probes, then republishes at 10,000 changes', async () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const active = manifestAt('1', 1);
      const currentInfo = (cursor: string) =>
        snapshotGet({ currentCursor: cursor as SyncCursor, manifest: active });
      const options: SnapshotRpcOptions = {
        snapshotGets: [
          snapshotGet({ currentCursor: '2' as SyncCursor }),
          snapshotGet({ currentCursor: '2' as SyncCursor }),
          currentInfo('10001'),
          currentInfo('10001'),
        ],
        scanWatermark: 2,
        scanWatermarkStart: 0,
        catchupByCursor: new Map([
          [
            '0',
            {
              changes: [],
              hasMore: false,
              nextCursor: '2' as SyncCursor,
              recoveryFloor: 0,
            },
          ],
          [
            '10000',
            {
              changes: [],
              hasMore: false,
              nextCursor: '10001' as SyncCursor,
              recoveryFloor: 1,
            },
          ],
        ]),
      };
      const harness = createRpcHarness(options);

      await cycle(harness.rpc);
      expect(harness.calls.filter((call) => call.operation === 'sync.snapshot.begin')).toHaveLength(
        1,
      );
      expect(harness.calls.filter((call) => call.operation === 'sync.scan.begin')).toHaveLength(1);

      nowSpy.mockImplementation(() => now + 30 * 60 * 1000);
      await cycle(harness.rpc);
      expect(harness.calls.filter((call) => call.operation === 'sync.snapshot.get')).toHaveLength(
        2,
      );
      expect(harness.calls.filter((call) => call.operation === 'sync.scan.begin')).toHaveLength(1);

      // At exactly 10,000 changes beyond the current image, the next hourly
      // probe schedules a complete scan and a new verified publication.
      options.scanWatermarkStart = 10_000;
      options.scanWatermark = 10_001;
      nowSpy.mockImplementation(() => now + 61 * 60 * 1000);
      await cycle(harness.rpc);

      expect(harness.calls.filter((call) => call.operation === 'sync.snapshot.get')).toHaveLength(
        4,
      );
      expect(harness.calls.filter((call) => call.operation === 'sync.scan.begin')).toHaveLength(2);
      expect(harness.calls.filter((call) => call.operation === 'sync.snapshot.begin')).toHaveLength(
        2,
      );
      expect(
        harness.calls
          .filter((call) => call.operation === 'sync.snapshot.begin')
          .map((call) => (call.params as { committedCursor: string }).committedCursor),
      ).toEqual(['2', '10001']);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
