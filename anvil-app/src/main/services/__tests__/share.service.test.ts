import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents.js';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';
import type { MainSurfaceHandler } from '../../surfaces/types.js';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => db }));

const backend = vi.hoisted(() => ({
  isArtifactSharingAvailable: vi.fn(() => true),
  artifactShareScope: vi.fn(() => 'scope-1'),
  getShareAccessOptions: vi.fn(async () => ({
    available: true,
    organizationSharing: true,
    organizations: [{ id: 'org-1', name: 'Org One' }],
  })),
  publishSharedArtifact: vi.fn(),
  updateSharedArtifact: vi.fn(),
  revokeSharedArtifact: vi.fn(),
}));
vi.mock('../artifact-share.service.js', () => backend);

const surfaces = vi.hoisted(() => ({
  getSurface: vi.fn<(id: string) => AgentUISurfaceIntent | null>(() => null),
  requestUserApproval: vi.fn(async () => true),
  getMainSurfaceHandler: vi.fn<(kind: string) => MainSurfaceHandler | undefined>(),
}));
vi.mock('../../surfaces/core.js', () => ({
  getSurface: surfaces.getSurface,
  requestUserApproval: surfaces.requestUserApproval,
}));
vi.mock('../../surfaces/index.js', () => ({
  getMainSurfaceHandler: surfaces.getMainSurfaceHandler,
}));
vi.mock('../../surfaces/offscreen.js', () => ({
  renderOffscreen: vi.fn(async () => ({ height: 100, frozenHtml: '<p>Frozen</p>' })),
}));
vi.mock('../../../shared/surfaces/sketch-runtime.js', () => ({
  buildSketchDocument: (html: string) => `<!--standalone-->${html}`,
  DEFAULT_SKETCH_TOKENS: { light: {}, dark: {} },
}));

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));
vi.mock('electron', () => ({ clipboard, app: { getPath: () => '/nonexistent' } }));

import {
  copyShareLink,
  extractShareKey,
  listLiveSharesForItems,
  listShares,
  migrateLegacySharedUrls,
  previewShare,
  publishShare,
  revokeShare,
  revokeSharesForItems,
  shareAccessOptions,
  setKnownSecretsProviderForTests,
  setShareLinkStoreForTests,
  sharesAgentToolProvider,
  updateShare,
} from '../share.service.js';
import { BackendRpcError } from '../sync-backend-client.service.js';

const KEY = 'k'.repeat(43);
const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const stored = new Map<string, string>();
let shareCounter = 0;

function insertArtifact(id: string, kind: string, content: string, version = 1): void {
  db.prepare(
    `INSERT INTO chat_artifacts (id, thread_id, title, kind, storage_scope, relative_path, content,
       version, created_at, updated_at)
     VALUES (?, 'thread-1', ?, ?, 'session', ?, ?, ?, '2026-01-01', '2026-01-01')`,
  ).run(id, `Title ${id}`, kind, `${id}.${kind}`, content, version);
}

function ctx(overrides: Partial<AgentToolSessionContext> = {}): AgentToolSessionContext {
  return {
    sessionId: 'session-1',
    appThreadId: 'thread-1',
    workspaceId: 'ws-1',
    repoIds: [],
    provider: 'codex' as AgentToolSessionContext['provider'],
    mode: 'full-access' as AgentToolSessionContext['mode'],
    features: [],
    ...overrides,
  };
}

function surfaceIntent(
  id: string,
  surfaceKind: string,
  data: unknown,
  scope: Partial<AgentUISurfaceIntent['scope']> = {},
): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id,
    kind: 'surface',
    revision: 5,
    scope: { threadId: 'thread-1', workspaceId: 'ws-1', ...scope },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: { surfaceKind, title: `Surface ${id}`, streaming: false, digest: 'Digest', data },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

beforeEach(() => {
  for (const table of ['shares', 'chat_sketches', 'chat_artifact_revisions', 'chat_artifacts']) {
    db.exec(`DELETE FROM ${table}`);
  }
  db.exec('DELETE FROM chat_threads');
  db.exec('DELETE FROM workspaces');
  db.prepare(
    "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws-1', 'WS', 'now', 'now')",
  ).run();
  db.prepare(
    "INSERT INTO chat_threads (id, workspace_id, persona_id, title) VALUES ('thread-1', 'ws-1', 'coder', 'T')",
  ).run();
  stored.clear();
  setShareLinkStoreForTests({
    get: async (key) => stored.get(key) ?? null,
    set: async (key, url) => {
      stored.set(key, url);
      return true;
    },
    delete: async (key) => {
      stored.delete(key);
    },
  });
  setKnownSecretsProviderForTests(async () => []);
  vi.clearAllMocks();
  backend.isArtifactSharingAvailable.mockReturnValue(true);
  backend.artifactShareScope.mockReturnValue('scope-1');
  backend.getShareAccessOptions.mockResolvedValue({
    available: true,
    organizationSharing: true,
    organizations: [{ id: 'org-1', name: 'Org One' }],
  });
  backend.publishSharedArtifact.mockImplementation(async () => {
    shareCounter += 1;
    return {
      share: { shareId: `shr_${shareCounter}`, expiresAt: '2026-02-01T00:00:00.000Z' },
      shareKey: KEY,
    };
  });
  backend.updateSharedArtifact.mockResolvedValue({});
  backend.revokeSharedArtifact.mockResolvedValue(undefined);
  surfaces.getSurface.mockReturnValue(null);
  surfaces.requestUserApproval.mockResolvedValue(true);
});

afterAll(() => db.close());

describe('previewShare', () => {
  it('previews raw text kinds with secret findings and a static document', async () => {
    insertArtifact('a1', 'markdown', `# Notes\nGITHUB_TOKEN=${GITHUB}`);
    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    expect(preview).toMatchObject({
      title: 'Title a1',
      mediaType: 'text/markdown',
      interactive: false,
      version: 1,
    });
    expect(preview.secretFindings).toHaveLength(1);
    expect(preview.secretFindings[0].excerpt).not.toContain(GITHUB);
    expect(preview.previewDocument).toContain("script-src 'none'");
    expect(preview.previewDocument).toContain(GITHUB);

    const redacted = await previewShare(
      { itemType: 'artifact', itemId: 'a1' },
      { redactFindingIds: [preview.secretFindings[0].id] },
    );
    expect(redacted.previewDocument).not.toContain(GITHUB);
    expect(redacted.previewDocument).toContain('[redacted]');
  });

  it('previews HTML artifacts as interactive bundles showing the frozen snapshot', async () => {
    insertArtifact('h1', 'html', '<p>Live</p><script>tick()</script>', 2);
    const preview = await previewShare({ itemType: 'artifact', itemId: 'h1' });
    expect(preview.mediaType).toBe('application/vnd.anvil.share+json');
    expect(preview.interactive).toBe(true);
    expect(preview.previewDocument).toContain('<p>Frozen</p>');
    expect(preview.previewDocument).not.toContain('tick()');
  });

  it('requires sketches to be kept and shares the kept artifact', async () => {
    db.prepare(
      `INSERT INTO chat_sketches (id, thread_id, title, html, created_at, updated_at)
       VALUES ('sk1', 'thread-1', 'Sketch', '<p>x</p>', 'now', 'now')`,
    ).run();
    surfaces.getSurface.mockReturnValue(surfaceIntent('surf-sk', 'sketch', { sketchId: 'sk1' }));
    await expect(previewShare({ itemType: 'surface', itemId: 'surf-sk' })).rejects.toThrow(
      /Keep this sketch/,
    );
    insertArtifact('kept', 'html', '<p>kept</p>');
    db.prepare("UPDATE chat_sketches SET kept_artifact_id = 'kept' WHERE id = 'sk1'").run();
    const { record } = await publishShare({ itemType: 'surface', itemId: 'surf-sk' });
    expect(record).toMatchObject({ itemType: 'artifact', itemId: 'kept', interactive: true });
  });

  it('shares native surfaces through their share handler and rejects others', async () => {
    surfaces.getSurface.mockReturnValue(surfaceIntent('rev', 'review', { secret: 'x', keep: 1 }));
    surfaces.getMainSurfaceHandler.mockReturnValue({
      kind: 'review',
      share: {
        redact: (data) => ({ keep: (data as { keep: number }).keep }),
        snapshot: () => ({ html: '<p>Review snapshot</p>', css: '' }),
      },
    });
    const preview = await previewShare({ itemType: 'surface', itemId: 'rev' });
    expect(preview.version).toBe(5);
    expect(preview.availableOptions).toEqual({ includeComments: true, includeFullDiff: true });
    expect(preview.previewDocument).toContain('Review snapshot');

    surfaces.getMainSurfaceHandler.mockReturnValue({ kind: 'review' });
    await expect(previewShare({ itemType: 'surface', itemId: 'rev' })).rejects.toThrow(
      /not shareable/,
    );
  });
});

describe('publishShare', () => {
  it('does not invalidate a fresh preview when a previously found secret disappears', async () => {
    insertArtifact('a1', 'markdown', `token ${GITHUB}`);
    const target = { itemType: 'artifact' as const, itemId: 'a1' };
    const original = await previewShare(target);
    db.prepare("UPDATE chat_artifacts SET content = '# Clean snapshot' WHERE id = 'a1'").run();
    const refreshed = await previewShare(target, {
      redactFindingIds: original.secretFindings.map((finding) => finding.id),
    });
    expect(refreshed.secretFindings).toEqual([]);
    await publishShare(target, { preparedId: refreshed.preparedId, redactFindingIds: [] });
    const upload = backend.publishSharedArtifact.mock.calls[0][0];
    expect(new TextDecoder().decode(upload.bytes)).toBe('# Clean snapshot');
  });

  it('uses the reviewed redacted bundle title in public metadata and later updates', async () => {
    insertArtifact('a1', 'html', '<p>Safe content</p>');
    db.prepare('UPDATE chat_artifacts SET title = ? WHERE id = ?').run(`Title ${GITHUB}`, 'a1');
    const target = { itemType: 'artifact' as const, itemId: 'a1' };
    const first = await previewShare(target);
    const options = { redactFindingIds: first.secretFindings.map((finding) => finding.id) };
    const reviewed = await previewShare(target, options);
    const { record } = await publishShare(target, { ...options, preparedId: reviewed.preparedId });
    const upload = backend.publishSharedArtifact.mock.calls[0][0];
    expect(reviewed.title).toBe('Title [redacted]');
    expect(record.title).toBe(reviewed.title);
    expect(upload.title).toBe(reviewed.title);
    expect(new TextDecoder().decode(upload.bytes)).not.toContain(GITHUB);
    const next = await previewShare(target, options);
    await updateShare(record.id, { ...options, preparedId: next.preparedId });
    expect(backend.updateSharedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        title: reviewed.title,
      }),
    );
  });

  it('publishes the exact bytes reviewed in the preview after the source changes', async () => {
    insertArtifact('a1', 'markdown', '# reviewed bytes', 1);
    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    db.prepare(
      "UPDATE chat_artifacts SET content = '# changed later', version = 2 WHERE id = 'a1'",
    ).run();

    const { record } = await publishShare(
      { itemType: 'artifact', itemId: 'a1' },
      { preparedId: preview.preparedId },
    );

    const call = backend.publishSharedArtifact.mock.calls[0][0] as {
      bytes: Uint8Array;
      expectedScope: string;
    };
    expect(new TextDecoder().decode(call.bytes)).toBe('# reviewed bytes');
    expect(call.expectedScope).toBe('scope-1');
    expect(record).toMatchObject({ version: 1, currentVersion: 2 });
  });

  it('rejects changed redaction and publish options after preview', async () => {
    insertArtifact('a1', 'markdown', `token ${GITHUB}`);
    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    await expect(
      publishShare(
        { itemType: 'artifact', itemId: 'a1' },
        {
          preparedId: preview.preparedId,
          redactFindingIds: [preview.secretFindings[0].id],
        },
      ),
    ).rejects.toThrow(/preview expired or its options\/account changed/);
    expect(backend.publishSharedArtifact).not.toHaveBeenCalled();

    const expiringPreview = await previewShare(
      { itemType: 'artifact', itemId: 'a1' },
      { expiresInDays: 7 },
    );
    await expect(
      publishShare(
        { itemType: 'artifact', itemId: 'a1' },
        { preparedId: expiringPreview.preparedId, expiresInDays: 8 },
      ),
    ).rejects.toThrow(/preview expired or its options\/account changed/);
  });

  it('rejects a preview prepared under another backend account scope', async () => {
    insertArtifact('a1', 'markdown', '# reviewed');
    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    backend.artifactShareScope.mockReturnValue('scope-2');
    await expect(
      publishShare({ itemType: 'artifact', itemId: 'a1' }, { preparedId: preview.preparedId }),
    ).rejects.toThrow(/preview expired or its options\/account changed/);
    expect(backend.publishSharedArtifact).not.toHaveBeenCalled();
  });

  it('exposes organization access options and keeps organization access immutable on updates', async () => {
    insertArtifact('a1', 'markdown', '# organization content');
    await expect(shareAccessOptions()).resolves.toEqual({
      available: true,
      organizationSharing: true,
      organizations: [{ id: 'org-1', name: 'Org One' }],
    });
    const audience = { kind: 'organization' as const, organizationId: 'org-1' };
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' }, { audience });
    expect(record.audience).toEqual(audience);
    await expect(
      updateShare(record.id, { audience: { kind: 'organization', organizationId: 'org-2' } }),
    ).rejects.toThrow(/Changing access creates a new link/);
    await expect(updateShare(record.id, { audience: { kind: 'link' } })).rejects.toThrow(
      /Changing access creates a new link/,
    );
    expect(backend.updateSharedArtifact).not.toHaveBeenCalled();
  });

  it('refuses unresolved findings, then publishes redacted bytes and keeps the URL out of SQLite', async () => {
    insertArtifact('a1', 'markdown', `token ${GITHUB}`);
    await expect(publishShare({ itemType: 'artifact', itemId: 'a1' })).rejects.toThrow(
      /1 possible secret/,
    );
    expect(backend.publishSharedArtifact).not.toHaveBeenCalled();

    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    const { record, url } = await publishShare(
      { itemType: 'artifact', itemId: 'a1' },
      { redactFindingIds: [preview.secretFindings[0].id], expiresInDays: 7 },
    );
    const call = backend.publishSharedArtifact.mock.calls[0][0] as {
      bytes: Uint8Array;
      mediaType: string;
      expiresInDays: number;
      audience: { kind: string };
      expectedScope: string;
    };
    const uploaded = new TextDecoder().decode(call.bytes);
    expect(uploaded).toBe('token [redacted]');
    expect(call).toMatchObject({
      mediaType: 'text/markdown',
      expiresInDays: 7,
      audience: { kind: 'link' },
      expectedScope: 'scope-1',
    });
    expect(url).toBe(`https://anvilstack.dev/artifacts/${record.shareId}#k=${KEY}`);
    expect(stored.get(`share-url:${record.id}`)).toBe(url);
    expect(record).toMatchObject({ version: 1, currentVersion: 1, interactive: false });

    const artifactRow = db
      .prepare('SELECT share_id, shared_url, visibility FROM chat_artifacts WHERE id = ?')
      .get('a1') as { share_id: string; shared_url: string | null; visibility: string };
    expect(artifactRow).toEqual({
      share_id: record.shareId,
      shared_url: null,
      visibility: 'shareable',
    });
    const dump = JSON.stringify(db.prepare('SELECT * FROM shares').all());
    expect(dump).not.toContain(KEY);
  });

  it('publishes when the user acknowledges findings as safe', async () => {
    insertArtifact('a1', 'text', `example ${GITHUB}`);
    const preview = await previewShare({ itemType: 'artifact', itemId: 'a1' });
    await publishShare(
      { itemType: 'artifact', itemId: 'a1' },
      { acknowledgeFindingIds: preview.secretFindings.map((finding) => finding.id) },
    );
    const call = backend.publishSharedArtifact.mock.calls[0][0] as { bytes: Uint8Array };
    expect(new TextDecoder().decode(call.bytes)).toContain(GITHUB);
  });

  it('requires a sync session', async () => {
    insertArtifact('a1', 'markdown', '# ok');
    backend.isArtifactSharingAvailable.mockReturnValue(false);
    await expect(publishShare({ itemType: 'artifact', itemId: 'a1' })).rejects.toThrow(
      /sync session/,
    );
  });
});

describe('updateShare / revokeShare / listShares', () => {
  it('allows revocation when the connected backend no longer has a configured viewer', async () => {
    insertArtifact('a1', 'markdown', '# Shared snapshot');
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    backend.isArtifactSharingAvailable.mockReturnValue(false);
    const revoked = await revokeShare(record.id);
    expect(revoked.revokedAt).toBeDefined();
    expect(backend.revokeSharedArtifact).toHaveBeenCalledWith(record.shareId, {
      expectedScope: 'scope-1',
    });
  });

  it('re-seals the current version under the same share id and key', async () => {
    insertArtifact('a1', 'markdown', '# v1');
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    db.prepare("UPDATE chat_artifacts SET content = '# v4', version = 4 WHERE id = 'a1'").run();

    const listed = await listShares({ itemType: 'artifact', itemId: 'a1' });
    expect(listed[0]).toMatchObject({ version: 1, currentVersion: 4 });

    const updated = await updateShare(record.id);
    expect(backend.updateSharedArtifact).toHaveBeenCalledWith({
      shareId: record.shareId,
      title: 'Title a1',
      shareKey: KEY,
      bytes: new TextEncoder().encode('# v4'),
      mediaType: 'text/markdown',
      audience: { kind: 'link' },
      expectedScope: 'scope-1',
    });
    expect(updated).toMatchObject({ id: record.id, shareId: record.shareId, version: 4 });
    expect(backend.publishSharedArtifact).toHaveBeenCalledTimes(1);
  });

  it('refuses updates it cannot carry on the same link', async () => {
    insertArtifact('a1', 'markdown', '# v1');
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    db.prepare("UPDATE chat_artifacts SET kind = 'html' WHERE id = 'a1'").run();
    await expect(updateShare(record.id)).rejects.toThrow(/different format/);
    stored.clear();
    await expect(updateShare(record.id)).rejects.toThrow(/isn't stored on this device/);
    expect(backend.updateSharedArtifact).not.toHaveBeenCalled();
  });

  it('revokes remotely, clears local custody and tolerates already-gone shares', async () => {
    insertArtifact('a1', 'markdown', '# v1');
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    backend.revokeSharedArtifact.mockRejectedValueOnce(
      new BackendRpcError({ code: 'not-found', retryable: false }),
    );
    const revoked = await revokeShare(record.id);
    expect(backend.revokeSharedArtifact).toHaveBeenCalledWith(record.shareId, {
      expectedScope: 'scope-1',
    });
    expect(revoked.revokedAt).toBeDefined();
    expect(stored.size).toBe(0);
    expect(await listShares()).toEqual([]);
    const artifactRow = db
      .prepare('SELECT share_id, visibility FROM chat_artifacts WHERE id = ?')
      .get('a1') as { share_id: string | null; visibility: string };
    expect(artifactRow).toEqual({ share_id: null, visibility: 'local' });
  });

  it('keeps the share live when the backend revoke fails', async () => {
    insertArtifact('a1', 'markdown', '# v1');
    const { record } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    backend.revokeSharedArtifact.mockRejectedValueOnce(
      new BackendRpcError({ code: 'unavailable', retryable: true }),
    );
    await expect(revokeShare(record.id)).rejects.toBeInstanceOf(BackendRpcError);
    expect(listLiveSharesForItems('artifact', ['a1'])).toHaveLength(1);
    expect(stored.size).toBe(1);
  });

  it('revokes every live share of deleted items', async () => {
    insertArtifact('a1', 'markdown', '# 1');
    insertArtifact('a2', 'markdown', '# 2');
    await publishShare({ itemType: 'artifact', itemId: 'a1' });
    await publishShare({ itemType: 'artifact', itemId: 'a1' });
    await publishShare({ itemType: 'artifact', itemId: 'a2' });
    const result = await revokeSharesForItems('artifact', ['a1']);
    expect(result.revoked).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect((await listShares()).map((record) => record.itemId)).toEqual(['a2']);
  });

  it('filters by workspace and copies links to the clipboard', async () => {
    insertArtifact('a1', 'markdown', '# 1');
    const { record, url } = await publishShare({ itemType: 'artifact', itemId: 'a1' });
    expect(await listShares({ workspaceId: 'ws-1' })).toHaveLength(1);
    expect(await listShares({ workspaceId: 'other' })).toHaveLength(0);
    expect(await copyShareLink(record.id)).toBe(true);
    expect(clipboard.writeText).toHaveBeenCalledWith(url);
  });
});

describe('legacy shared_url custody', () => {
  it('moves URLs out of SQLite into credential storage', async () => {
    insertArtifact('a1', 'markdown', '# 1');
    const url = `https://anvilstack.dev/artifacts/shr_old#k=${KEY}`;
    db.prepare(
      "UPDATE chat_artifacts SET share_id = 'shr_old', shared_url = ? WHERE id = 'a1'",
    ).run(url);
    db.prepare(
      `INSERT INTO shares (id, item_type, item_id, version, share_id, media_type, interactive, title,
         created_at, updated_at)
       VALUES ('rec-old', 'artifact', 'a1', 1, 'shr_old', 'application/octet-stream', 0, 'Old', 'now', 'now')`,
    ).run();
    expect(await migrateLegacySharedUrls()).toBe(1);
    expect(stored.get('share-url:rec-old')).toBe(url);
    const row = db.prepare("SELECT shared_url FROM chat_artifacts WHERE id = 'a1'").get() as {
      shared_url: string | null;
    };
    expect(row.shared_url).toBeNull();
    const share = db.prepare("SELECT media_type FROM shares WHERE id = 'rec-old'").get() as {
      media_type: string;
    };
    expect(share.media_type).toBe('text/markdown');
  });

  it('extracts fragment keys', () => {
    expect(extractShareKey(`https://x/artifacts/s#k=${KEY}`)).toBe(KEY);
    expect(extractShareKey('https://x/artifacts/s')).toBeNull();
  });
});

describe('share_item agent tool', () => {
  it('is an approval-gated mutation', () => {
    const [tool] = sharesAgentToolProvider.tools(ctx());
    expect(tool).toMatchObject({ name: 'share_item', mutation: true });
  });

  it('publishes after approval and never returns the URL or key', async () => {
    insertArtifact('a1', 'markdown', `GITHUB_TOKEN=${GITHUB}`);
    const result = await sharesAgentToolProvider.call(ctx(), 'share_item', {
      itemType: 'artifact',
      itemId: 'a1',
      expiresInDays: 3,
    });
    const approval = surfaces.requestUserApproval.mock.calls[0] as unknown as [
      unknown,
      { title: string; detail: string },
    ];
    expect(approval[1].detail).toContain('1 possible secret found');
    expect(approval[1].detail).toContain('Interactive: no');
    expect(result?.structuredContent).toEqual({
      shared: true,
      shareId: 'shr_' + shareCounter,
      expiresAt: '2026-02-01T00:00:00.000Z',
    });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain('#k=');
    expect(serialised).not.toContain('https://');
    // Redacted before upload; the link went to the clipboard only.
    const call = backend.publishSharedArtifact.mock.calls[0][0] as { bytes: Uint8Array };
    expect(new TextDecoder().decode(call.bytes)).not.toContain(GITHUB);
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(`#k=${KEY}`));
  });

  it('publishes nothing when the user declines', async () => {
    insertArtifact('a1', 'markdown', '# ok');
    surfaces.requestUserApproval.mockResolvedValueOnce(false);
    const result = await sharesAgentToolProvider.call(ctx(), 'share_item', {
      itemType: 'artifact',
      itemId: 'a1',
    });
    expect(result?.structuredContent).toEqual({ shared: false });
    expect(backend.publishSharedArtifact).not.toHaveBeenCalled();
  });

  it('rejects items outside the session workspace', async () => {
    insertArtifact('a1', 'markdown', '# ok');
    await expect(
      sharesAgentToolProvider.call(
        ctx({ appThreadId: 'other', workspaceId: 'ws-2' }),
        'share_item',
        {
          itemType: 'artifact',
          itemId: 'a1',
        },
      ),
    ).rejects.toThrow(/outside this session/);
    expect(surfaces.requestUserApproval).not.toHaveBeenCalled();
  });

  it('ignores tools it does not own', async () => {
    expect(await sharesAgentToolProvider.call(ctx(), 'other_tool', {})).toBeUndefined();
  });
});
