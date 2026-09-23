import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);
const repoPath = mkdtempSync(join(tmpdir(), 'anvil-artifacts-'));

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

const revokeSharedArtifact = vi.hoisted(() => vi.fn());
vi.mock('../artifact-share.service.js', () => ({
  publishSharedArtifact: vi.fn(),
  revokeSharedArtifact,
}));

import {
  discardChatArtifact,
  listChatArtifacts,
  unshareChatArtifact,
  upsertChatArtifact,
} from '../chat-artifact.service.js';
import { BackendRpcError } from '../sync-backend-client.service.js';

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM chat_artifact_revisions');
  inMemoryDb.exec('DELETE FROM chat_artifacts');
  inMemoryDb.exec('DELETE FROM chat_threads');
  inMemoryDb.exec('DELETE FROM repos');
  inMemoryDb
    .prepare('INSERT INTO repos (id, name, path) VALUES (?, ?, ?)')
    .run('repo-1', 'Anvil', repoPath);
  inMemoryDb
    .prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)')
    .run('thread-1', 'coder', 'Outcome');
  rmSync(join(repoPath, '.anvil'), { recursive: true, force: true });
});

afterAll(() => {
  inMemoryDb.close();
  rmSync(repoPath, { recursive: true, force: true });
});

describe('chat artifact storage', () => {
  it('keeps session artifacts out of the repository and allows them to be discarded', () => {
    const artifact = upsertChatArtifact({
      threadId: 'thread-1',
      repoId: 'repo-1',
      title: 'Scratchpad',
      kind: 'markdown',
      storage: 'session',
      relativePath: 'scratch/notes.md',
      content: '# Temporary notes',
    });

    expect(artifact.storage).toBe('session');
    expect(artifact.filePath).toBeUndefined();
    expect(existsSync(join(repoPath, '.anvil'))).toBe(false);
    expect(discardChatArtifact(artifact.id)).toBe(true);
    expect(listChatArtifacts('thread-1')).toEqual([]);
  });

  it('persists repository artifacts and protects them from the discard action', () => {
    const artifact = upsertChatArtifact({
      threadId: 'thread-1',
      repoId: 'repo-1',
      title: 'Delivery plan',
      kind: 'markdown',
      relativePath: 'plans/delivery.md',
      content: '# Delivery plan',
    });

    expect(artifact.storage).toBe('repository');
    expect(artifact.filePath).toBe(join(repoPath, '.anvil/artifacts/plans/delivery.md'));
    expect(discardChatArtifact(artifact.id)).toBe(false);
    expect(listChatArtifacts('thread-1')).toHaveLength(1);
  });
});

describe('unshareChatArtifact', () => {
  function sharedArtifact(): string {
    const artifact = upsertChatArtifact({
      threadId: 'thread-1',
      repoId: 'repo-1',
      title: 'Shared notes',
      kind: 'markdown',
      storage: 'session',
      relativePath: 'scratch/shared.md',
      content: '# Shared',
    });
    inMemoryDb
      .prepare(
        `UPDATE chat_artifacts
         SET share_id = 'share-1', shared_url = 'https://anvilstack.dev/artifacts/share-1',
             shared_at = '2026-01-01T00:00:00.000Z', visibility = 'shareable'
         WHERE id = ?`,
      )
      .run(artifact.id);
    return artifact.id;
  }

  it('clears local share fields when the backend share is already gone', async () => {
    const id = sharedArtifact();
    revokeSharedArtifact.mockRejectedValueOnce(
      new BackendRpcError({ code: 'not-found', retryable: false }),
    );
    const result = await unshareChatArtifact(id);
    expect(result.shareId).toBeUndefined();
    expect(result.sharedUrl).toBeUndefined();
    const row = inMemoryDb
      .prepare(
        'SELECT share_id, shared_url, shared_at, visibility FROM chat_artifacts WHERE id = ?',
      )
      .get(id) as { share_id: string | null; visibility: string };
    expect(row.share_id).toBeNull();
    expect(row.visibility).toBe('local');
  });

  it('keeps share fields and propagates other revoke failures', async () => {
    const id = sharedArtifact();
    revokeSharedArtifact.mockRejectedValueOnce(
      new BackendRpcError({ code: 'unavailable', retryable: true }),
    );
    await expect(unshareChatArtifact(id)).rejects.toBeInstanceOf(BackendRpcError);
    const row = inMemoryDb.prepare('SELECT share_id FROM chat_artifacts WHERE id = ?').get(id) as {
      share_id: string | null;
    };
    expect(row.share_id).toBe('share-1');
  });
});
