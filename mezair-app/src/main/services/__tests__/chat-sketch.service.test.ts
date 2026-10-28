import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);
inMemoryDb.pragma('foreign_keys = ON');

vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('../artifact-share.service.js', () => ({
  publishSharedArtifact: vi.fn(),
  revokeSharedArtifact: vi.fn(),
}));

import {
  getChatArtifact,
  getChatArtifactRevision,
  listChatArtifactRevisions,
  upsertChatArtifact,
} from '../chat-artifact.service.js';
import {
  createChatSketch,
  deleteChatSketch,
  getChatSketch,
  keepChatSketch,
  listChatSketches,
  updateChatSketch,
} from '../chat-sketch.service.js';

beforeEach(() => {
  for (const table of [
    'chat_sketches',
    'chat_artifact_revisions',
    'chat_artifacts',
    'chat_threads',
  ]) {
    inMemoryDb.exec(`DELETE FROM ${table}`);
  }
  inMemoryDb
    .prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)')
    .run('thread-1', 'coder', 'Thread');
});

afterAll(() => inMemoryDb.close());

describe('chat sketches', () => {
  it('creates, updates, lists and deletes thread-scoped sketches', () => {
    const sketch = createChatSketch({
      threadId: 'thread-1',
      title: '  ',
      html: '<p>a</p>',
      height: 120.4,
    });
    expect(sketch).toMatchObject({ title: 'Sketch', html: '<p>a</p>', height: 120 });
    const updated = updateChatSketch(sketch.id, { html: '<p>b</p>', title: 'Chart' });
    expect(updated).toMatchObject({ html: '<p>b</p>', title: 'Chart', height: 120 });
    expect(updateChatSketch(sketch.id, { height: null }).height).toBeUndefined();
    expect(listChatSketches('thread-1').map((item) => item.id)).toEqual([sketch.id]);
    expect(deleteChatSketch(sketch.id)).toBe(true);
    expect(getChatSketch(sketch.id)).toBeNull();
  });

  it('rejects empty and oversized HTML', () => {
    expect(() => createChatSketch({ threadId: 'thread-1', title: 'x', html: ' ' })).toThrow(
      /required/,
    );
    expect(() =>
      createChatSketch({ threadId: 'thread-1', title: 'x', html: 'x'.repeat(1_500_001) }),
    ).toThrow(/too large/);
  });

  it('keeps a sketch as a session HTML artifact and re-keeps as a new version', () => {
    const sketch = createChatSketch({
      threadId: 'thread-1',
      title: 'Latency chart',
      html: '<p>1</p>',
    });
    const first = keepChatSketch(sketch.id);
    expect(first).toMatchObject({
      kind: 'html',
      storage: 'session',
      version: 1,
      content: '<p>1</p>',
    });
    expect(first.relativePath).toMatch(/^sketches\/latency-chart-[a-f0-9]{8}\.html$/);
    expect(getChatSketch(sketch.id)?.keptArtifactId).toBe(first.id);

    updateChatSketch(sketch.id, { html: '<p>2</p>' });
    const second = keepChatSketch(sketch.id, { title: 'Renamed' });
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      title: 'Renamed',
      content: '<p>2</p>',
    });
  });

  it('cascades with the thread', () => {
    const sketch = createChatSketch({ threadId: 'thread-1', title: 'x', html: '<p>x</p>' });
    inMemoryDb.prepare('DELETE FROM chat_threads WHERE id = ?').run('thread-1');
    expect(getChatSketch(sketch.id)).toBeNull();
  });
});

describe('chat artifact revisions', () => {
  it('writes a revision on every create and update', () => {
    const base = {
      threadId: 'thread-1',
      title: 'Spec',
      kind: 'markdown' as const,
      storage: 'session' as const,
      relativePath: 'spec.md',
    };
    const v1 = upsertChatArtifact({ ...base, content: 'one' });
    upsertChatArtifact({ ...base, content: 'two', title: 'Spec v2' });
    expect(getChatArtifact(v1.id)).toMatchObject({ version: 2, content: 'two' });
    expect(
      listChatArtifactRevisions(v1.id).map(({ version, title, content }) => ({
        version,
        title,
        content,
      })),
    ).toEqual([
      { version: 2, title: 'Spec v2', content: 'two' },
      { version: 1, title: 'Spec', content: 'one' },
    ]);
    expect(getChatArtifactRevision(v1.id, 1)?.content).toBe('one');
    expect(getChatArtifactRevision(v1.id, 9)).toBeNull();
    expect(getChatArtifact('missing')).toBeNull();
  });
});
