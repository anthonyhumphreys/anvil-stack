import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { ThreadPickupPackage } from '../../../../cloud/contract/thread-pickup.js';

const mocks = vi.hoisted(() => ({ userData: '' }));
const root = mkdtempSync(join(tmpdir(), 'anvil-thread-pickup-'));
mocks.userData = join(root, 'user-data');
vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  BrowserWindow: {},
  dialog: {},
}));
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
db.pragma('foreign_keys = ON');
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../remote-chat.service.js', () => ({
  listRemoteChats: () => [],
  getRemoteChat: () => null,
}));
vi.mock('../../surfaces/index.js', () => ({ getMainSurfaceHandler: () => undefined }));
vi.mock('../../surfaces/offscreen.js', () => ({ renderOffscreen: vi.fn() }));
vi.mock('../persona.service.js', () => ({
  getPersonaById: (id: string) => (id === 'coder' ? { id } : undefined),
}));

import {
  cancelThreadPickup,
  confirmThreadPickup,
  prepareThreadPickup,
  resetThreadPickupForTests,
  THREAD_PICKUP_INDEX_PATH,
} from '../thread-pickup.service.js';
import { createChatThread, loadChatHistory, saveChatEntry } from '../chat-persistence.service.js';
import { buildThreadShare } from '../thread-share.service.js';
import { scanForSecrets, redactSecrets } from '../share-secret-scan.js';
import { listChatArtifacts, upsertChatArtifact } from '../chat-artifact.service.js';
import {
  captureThreadContinuation,
  prependThreadContinuation,
} from '../chat-continuation.service.js';

function pkg(overrides: Partial<ThreadPickupPackage> = {}): ThreadPickupPackage {
  return {
    format: 'anvil-thread/v1',
    title: 'Reviewed source',
    sharedAt: '2026-10-25T10:00:00.000Z',
    source: {
      shareId: 'shr_source',
      version: 3,
      viewerUrl: 'https://viewer.example/artifacts/shr_source',
    },
    continuation: {
      format: 'anvil-thread-continuation/v1',
      entries: [
        {
          role: 'user',
          text: 'Choose the compact design.',
          at: '2026-10-24T10:00:00.000Z',
          source: 'Conversation',
        },
        {
          role: 'assistant',
          text: 'Compact chosen. Earlier author approval is historical only.',
          at: '2026-10-24T10:01:00.000Z',
          source: 'Mesh',
          note: 'Completed remote turn',
        },
      ],
      context: {
        repoNames: ['Original repository'],
        ticket: { provider: 'jira', id: 'SOURCE-7', title: 'Original ticket' },
        plan: 'Quoted source plan',
        goal: 'Quoted source goal',
      },
      items: [
        { kind: 'artifact', title: 'Design rationale', text: 'Keep this supporting rationale.' },
      ],
    },
    ...overrides,
  };
}
let serial = 0;
function file(value: unknown = pkg()): string {
  const path = join(root, `package-${serial++}.anvil-thread`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function destination(preparedId: string) {
  return { preparedId, workspaceId: 'recipient', repoIds: ['local-repo'], personaId: 'coder' };
}
function appFiles(): string[] {
  return existsSync(mocks.userData)
    ? readdirSync(mocks.userData, { recursive: true })
        .map(String)
        .filter((p) => statSync(join(mocks.userData, p)).isFile())
    : [];
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetThreadPickupForTests();
  rmSync(mocks.userData, { recursive: true, force: true });
  db.exec(
    'DROP TRIGGER IF EXISTS fail_import; DELETE FROM chat_artifact_revisions; DELETE FROM chat_artifacts; DELETE FROM chat_messages; DELETE FROM chat_sessions; DELETE FROM chat_threads; DELETE FROM workspace_repos; DELETE FROM repos; DELETE FROM workspaces;',
  );
  db.prepare(
    "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('recipient','Recipient',datetime('now'),datetime('now'))",
  ).run();
  db.prepare(
    "INSERT INTO workspaces(id,name,created_at,updated_at) VALUES('other','Other',datetime('now'),datetime('now'))",
  ).run();
  db.prepare('INSERT INTO repos(id,name,path) VALUES(?,?,?)').run('local-repo', 'Local', root);
  db.prepare(
    "INSERT INTO workspace_repos(workspace_id,repo_id,added_at) VALUES('recipient','local-repo',datetime('now'))",
  ).run();
});
afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('reviewed thread pickup', () => {
  it('imports a real selected/redacted author snapshot through the website exporter into actual first-turn context', async () => {
    const source = createChatThread({
      workspaceId: 'recipient',
      personaId: 'coder',
      title: 'Author source',
      repoIds: ['local-repo'],
    });
    const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const timestamp = '2026-10-24T10:00:00.000Z';
    saveChatEntry(source.id, null, null, {
      id: 'sender-user-id',
      role: 'user',
      content: `Choose compact layout. Credential ${secret}`,
      timestamp,
    });
    saveChatEntry(source.id, null, null, {
      id: 'sender-assistant-id',
      role: 'assistant',
      content: 'Compact layout selected.',
      timestamp,
    });
    saveChatEntry(source.id, null, null, {
      id: 'sender-system-id',
      role: 'system',
      content: 'DO-NOT-IMPORT-SYSTEM-PROMPT',
      timestamp,
    });
    db.prepare(
      'UPDATE chat_threads SET provider_thread_id = ?, provider_thread_provider = ?, work_item_provider = ?, work_item_id = ?, active_plan_json = ?, active_goal_json = ? WHERE id = ?',
    ).run(
      'DO-NOT-IMPORT-PROVIDER-HANDLE',
      'codex',
      'jira',
      'SOURCE-42',
      JSON.stringify({
        steps: [{ step: 'Source plan only', status: 'in_progress' }],
        updatedAt: timestamp,
      }),
      JSON.stringify({ objective: 'Source goal only', status: 'active' }),
      source.id,
    );
    const selected = upsertChatArtifact({
      threadId: source.id,
      title: 'Selected rationale',
      kind: 'markdown',
      storage: 'session',
      relativePath: 'selected.md',
      content: `Chosen rationale ${secret}`,
    });
    upsertChatArtifact({
      threadId: source.id,
      title: 'Not selected',
      kind: 'markdown',
      storage: 'session',
      relativePath: 'unselected.md',
      content: 'DO-NOT-IMPORT-UNSELECTED-CONTEXT',
    });
    const built = await buildThreadShare(
      { itemType: 'thread', itemId: source.id },
      { contextItemIds: [`artifact:${selected.id}`] },
    );
    const findings = scanForSecrets(built.text!);
    expect(findings.length).toBeGreaterThan(0);
    const redacted = redactSecrets(
      built.text!,
      findings.map((f) => f.id),
    );
    // Dynamic nonliteral paths keep website source outside Desktop's emit project;
    // Vitest still exercises the actual website parser/exporter implementations.
    const parserUrl = new URL('../../../../../anvil-website/lib/share-bundle.ts', import.meta.url)
      .href;
    const exporterUrl = new URL(
      '../../../../../anvil-website/lib/thread-pickup.ts',
      import.meta.url,
    ).href;
    const websiteParser: { parseShareBundle(text: string): unknown } = await import(parserUrl);
    const exporter: {
      buildThreadPickupPackage(
        bundle: unknown,
        shareId: string,
        origin?: string,
      ): ThreadPickupPackage;
    } = await import(exporterUrl);
    const bundle = websiteParser.parseShareBundle(redacted);
    expect(bundle).not.toBeNull();
    const exported = exporter.buildThreadPickupPackage(
      bundle,
      'shr_integration',
      'https://viewer.example/path?query=ignored#k=NEVER-TRANSFER-KEY',
    );
    expect(JSON.stringify(exported)).not.toContain(secret);
    expect(JSON.stringify(exported)).not.toContain('NEVER-TRANSFER-KEY');
    const preview = await prepareThreadPickup(file(exported));
    const thread = await confirmThreadPickup(destination(preview.preparedId));
    expect(thread.id).not.toBe(source.id);
    expect(thread.providerThreadId).toBeUndefined();
    expect(thread.workItemId).toBeUndefined();
    expect(thread.activePlan).toBeUndefined();
    expect(thread.activeGoal).toBeUndefined();
    expect(thread.attentionState).toBe('idle');
    const prompt = prependThreadContinuation(
      captureThreadContinuation(thread.id).context,
      'Continue with my local repository',
    );
    expect(prompt).toContain('Choose compact layout');
    expect(prompt).toContain('[redacted]');
    expect(prompt).toContain('Selected rationale');
    expect(prompt).toContain('SOURCE-42');
    expect(prompt).toContain('Source plan only');
    expect(prompt).toContain('Source goal only');
    expect(prompt).not.toContain(secret);
    expect(prompt).not.toContain('DO-NOT-IMPORT');
    expect(prompt).not.toContain('NEVER-TRANSFER-KEY');
    expect(loadChatHistory(thread.id).every((m) => !m.id.startsWith('sender-'))).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE thread_id = ?').get(thread.id),
    ).toEqual({ n: 0 });
  });

  it('freezes source bytes at preview and imports a fresh private thread without provider execution or sender authority', async () => {
    const source = file();
    const preview = await prepareThreadPickup(source);
    expect(preview.messageCount).toBe(2);
    expect(preview.repoNames).toEqual(['Original repository']);
    expect(preview.ticket?.id).toBe('SOURCE-7');
    expect(preview.previewDocument).toContain('Keep this supporting rationale.');
    writeFileSync(source, JSON.stringify(pkg({ title: 'Changed after review' })));
    preview.source.shareId = 'mutated-return-value';
    preview.repoNames[0] = 'changed UI list';
    const thread = await confirmThreadPickup(destination(preview.preparedId));
    expect(thread.title).toBe('Reviewed source — continuation');
    expect(thread.workspaceId).toBe('recipient');
    expect(thread.repoIds).toEqual(['local-repo']);
    expect(thread.providerThreadId).toBeUndefined();
    expect(thread.workItemId).toBeUndefined();
    expect(thread.activePlan).toBeUndefined();
    expect(thread.activeGoal).toBeUndefined();
    expect(thread.attentionState).toBe('idle');
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM shares').get()).toEqual({ n: 0 });
    const history = loadChatHistory(thread.id);
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(history[0].content).toContain('[Imported user');
    expect(history[2].content).toContain('No agent has run yet');
    expect(new Set(history.map((m) => m.id)).size).toBe(3);
    const artifacts = listChatArtifacts(thread.id);
    expect(
      artifacts.every(
        (a) =>
          a.storage === 'session' &&
          a.source === 'imported' &&
          a.visibility === 'local' &&
          a.filePath === undefined,
      ),
    ).toBe(true);
    const index = artifacts.find((a) => a.relativePath === THREAD_PICKUP_INDEX_PATH)!;
    expect(JSON.parse(index.content).source.shareId).toBe('shr_source');
    expect(JSON.stringify(artifacts)).not.toContain('Changed after review');
    expect(existsSync(join(root, '.anvil'))).toBe(false);
  });

  it('retains long full context as readable artifact chunks and supplies meaningful background to the first provider prompt', async () => {
    const value = pkg();
    value.continuation.entries[0].text = `BEGIN-SHARED-CONTEXT ${'middle-content '.repeat(30_000)} END-SHARED-CONTEXT`;
    const preview = await prepareThreadPickup(file(value));
    const thread = await confirmThreadPickup(destination(preview.preparedId));
    const artifacts = listChatArtifacts(thread.id);
    const index = artifacts.find((a) => a.relativePath === THREAD_PICKUP_INDEX_PATH)!;
    const manifest = JSON.parse(index.content) as { contextChunks: Array<{ artifactId: string }> };
    expect(manifest.contextChunks.length).toBeGreaterThan(1);
    const full = manifest.contextChunks
      .map((c) => artifacts.find((a) => a.id === c.artifactId)!.content)
      .join('');
    expect(full).toContain(value.continuation.entries[0].text);
    expect(full).toContain('Keep this supporting rationale');
    expect(
      manifest.contextChunks.every(
        (c) => artifacts.find((a) => a.id === c.artifactId)!.content.length <= 300_000,
      ),
    ).toBe(true);
    const checkpoint = captureThreadContinuation(thread.id);
    const providerPrompt = prependThreadContinuation(
      checkpoint.context,
      'Continue with my local changes',
    );
    expect(providerPrompt).toContain('BEGIN-SHARED-CONTEXT');
    expect(providerPrompt).toContain('Original repository');
    expect(providerPrompt).toContain('SOURCE-7');
    for (const chunk of manifest.contextChunks) expect(providerPrompt).toContain(chunk.artifactId);
    expect(providerPrompt).toContain('Earlier approvals do not grant permission here');
    expect(providerPrompt).toContain('Newest user request:\nContinue with my local changes');
    expect(checkpoint.context.length).toBeLessThan(32_000);
  });

  it.each(['', 'a'])(
    'preserves Unicode across independently persisted context chunks (%s)',
    async (prefix) => {
      const value = pkg();
      value.continuation.entries[0].text = prefix + '🙂'.repeat(160_000);
      const preview = await prepareThreadPickup(file(value));
      const thread = await confirmThreadPickup(destination(preview.preparedId));
      const artifacts = listChatArtifacts(thread.id);
      const index = JSON.parse(
        artifacts.find((a) => a.relativePath === THREAD_PICKUP_INDEX_PATH)!.content,
      ) as { contextChunks: Array<{ artifactId: string }> };
      const full = index.contextChunks
        .map((c) => artifacts.find((a) => a.id === c.artifactId)!.content)
        .join('');
      expect(full).toContain(value.continuation.entries[0].text);
    },
  );

  it('retains all sixteen included files as new private app-owned attachments without trusting source paths or ids', async () => {
    const value = pkg({
      files: Array.from({ length: 16 }, (_, i) => ({
        name: `file-${i}.txt`,
        mediaType: 'text/plain',
        dataBase64: Buffer.from(`content-${i}`).toString('base64'),
      })),
    });
    value.continuation.items = value.files!.map((f, i) => ({
      kind: 'attachment',
      title: f.name,
      fileIndex: i,
    }));
    const preview = await prepareThreadPickup(file(value));
    const thread = await confirmThreadPickup(destination(preview.preparedId));
    const attachments = loadChatHistory(thread.id).at(-1)!.attachments!;
    expect(attachments).toHaveLength(16);
    expect(appFiles()).toHaveLength(16);
    for (const [i, attachment] of attachments.entries()) {
      expect(attachment.path.startsWith(`${mocks.userData}/chat-attachments/`)).toBe(true);
      expect(readFileSync(attachment.path, 'utf8')).toBe(`content-${i}`);
      expect(statSync(attachment.path).mode & 0o777).toBe(0o600);
      expect(attachment.id).toMatch(/^[a-f0-9-]{36}$/);
    }
  });

  it('returns the same thread for concurrent identical confirmations and rejects changed destinations after consumption', async () => {
    const preview = await prepareThreadPickup(file());
    const request = destination(preview.preparedId);
    const [first, second] = await Promise.all([
      confirmThreadPickup(request),
      confirmThreadPickup(request),
    ]);
    expect(first.id).toBe(second.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 1 });
    await expect(confirmThreadPickup({ ...request, repoIds: [] })).rejects.toThrow(
      'already been used',
    );
  });

  it.each([
    { workspaceId: 'missing' },
    { personaId: 'sender-agent' },
    { workspaceId: 'other' },
    { repoIds: ['local-repo', 'local-repo'] },
    { repoIds: ['sender-repo-id'] },
  ])(
    'rejects invalid local destination %j before consuming the reviewed package',
    async (changes) => {
      const preview = await prepareThreadPickup(file());
      await expect(
        confirmThreadPickup({ ...destination(preview.preparedId), ...changes }),
      ).rejects.toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 0 });
      expect(appFiles()).toHaveLength(0);
      expect((await confirmThreadPickup(destination(preview.preparedId))).workspaceId).toBe(
        'recipient',
      );
    },
  );

  it('allows an explicitly selected workspace-only continuation', async () => {
    const preview = await prepareThreadPickup(file());
    const thread = await confirmThreadPickup({ ...destination(preview.preparedId), repoIds: [] });
    expect(thread.repoIds).toEqual([]);
    expect(thread.activeRepoId).toBeUndefined();
  });

  it('rolls back thread/artifacts and deletes only new owned files on failure', async () => {
    const source = file(
      pkg({
        files: [
          {
            name: 'included.txt',
            mediaType: 'text/plain',
            dataBase64: Buffer.from('included').toString('base64'),
          },
        ],
      }),
    );
    const preview = await prepareThreadPickup(source);
    db.exec(
      "CREATE TEMP TRIGGER fail_import BEFORE INSERT ON chat_artifacts BEGIN SELECT RAISE(ABORT, 'forced import failure'); END",
    );
    await expect(confirmThreadPickup(destination(preview.preparedId))).rejects.toThrow(
      'forced import failure',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_artifacts').get()).toEqual({ n: 0 });
    expect(appFiles()).toHaveLength(0);
    expect(existsSync(source)).toBe(true);
    await expect(confirmThreadPickup(destination(preview.preparedId))).rejects.toThrow(
      'already been used',
    );
  });

  it('expires and cancels previews without leaving imported state', async () => {
    const cancelled = await prepareThreadPickup(file());
    cancelThreadPickup(cancelled.preparedId);
    await expect(confirmThreadPickup(destination(cancelled.preparedId))).rejects.toThrow(
      'expired or was cancelled',
    );
    const preview = await prepareThreadPickup(file());
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(preview.expiresAt));
    await expect(confirmThreadPickup(destination(preview.preparedId))).rejects.toThrow(
      'expired or was cancelled',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 0 });
  });

  it('bounds preview custody to four packages', async () => {
    const previews = [];
    for (let i = 0; i < 5; i++) previews.push(await prepareThreadPickup(file()));
    await expect(confirmThreadPickup(destination(previews[0].preparedId))).rejects.toThrow(
      'expired or was cancelled',
    );
    expect((await confirmThreadPickup(destination(previews[4].preparedId))).title).toContain(
      'Reviewed source',
    );
  });

  it('renders package markup as inert text and ignores executable snapshot content', async () => {
    const value = pkg({
      snapshot: {
        html: '<script>steal()</script><iframe src="https://foreign.example"></iframe>',
        css: '@import "https://foreign.example"',
      },
    });
    value.continuation.entries[0].text = '<script>visible quotation</script>';
    const preview = await prepareThreadPickup(file(value));
    expect(preview.previewDocument).toContain('&lt;script&gt;visible quotation&lt;/script&gt;');
    expect(preview.previewDocument).not.toContain('steal()');
    expect(preview.previewDocument).not.toContain('https://foreign.example');
    expect(preview.previewDocument).toContain("default-src 'none'");
  });

  it('rejects oversized files, symlinks, malformed JSON and key-bearing provenance', async () => {
    const oversized = join(root, 'oversize.anvil-thread');
    writeFileSync(oversized, Buffer.alloc(12 * 1024 * 1024 + 1));
    await expect(prepareThreadPickup(oversized)).rejects.toThrow('no larger than 12 MB');
    const linked = join(root, `linked-${serial++}.anvil-thread`);
    symlinkSync(file(), linked);
    await expect(prepareThreadPickup(linked)).rejects.toThrow('regular file');
    const malformed = file();
    writeFileSync(malformed, '{bad-json');
    await expect(prepareThreadPickup(malformed)).rejects.toThrow();
    const withKey = pkg();
    withKey.source.viewerUrl += '#k=never-persist-this';
    await expect(prepareThreadPickup(file(withKey))).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_threads').get()).toEqual({ n: 0 });
  });
});
