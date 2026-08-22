import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';

const database = new Database(':memory:');
database.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => database }));

import {
  createChatArtifactAnnotation,
  deleteChatArtifactAnnotation,
  listChatArtifactAnnotations,
  updateChatArtifactAnnotation,
} from '../chat-artifact-annotation.service.js';

beforeEach(() => {
  database.exec('DELETE FROM chat_artifact_annotations');
  database.exec('DELETE FROM chat_artifacts');
  database.exec('DELETE FROM chat_threads');
  database
    .prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)')
    .run('thread-1', 'coder', 'Artifact review');
  database
    .prepare(
      `INSERT INTO chat_artifacts
       (id, thread_id, title, kind, relative_path, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'artifact-1',
      'thread-1',
      'Architecture',
      'markdown',
      'architecture.md',
      '# Architecture',
      '2026-08-19T10:00:00.000Z',
      '2026-08-19T10:00:00.000Z',
    );
});

describe('chat artifact annotations', () => {
  it('persists quoted notes and supports resolve, reopen, and delete', () => {
    const created = createChatArtifactAnnotation({
      artifactId: 'artifact-1',
      body: 'Explain this boundary.',
      quote: 'Provider adapter',
    });
    expect(created).toMatchObject({
      artifactId: 'artifact-1',
      body: 'Explain this boundary.',
      quote: 'Provider adapter',
      status: 'open',
    });

    const resolved = updateChatArtifactAnnotation(created.id, { status: 'resolved' });
    expect(resolved.status).toBe('resolved');
    expect(updateChatArtifactAnnotation(created.id, { status: 'open' }).status).toBe('open');
    expect(listChatArtifactAnnotations('artifact-1')).toHaveLength(1);
    expect(deleteChatArtifactAnnotation(created.id)).toBe(true);
    expect(listChatArtifactAnnotations('artifact-1')).toEqual([]);
  });

  it('rejects empty notes and removes annotations with their artifact', () => {
    expect(() => createChatArtifactAnnotation({ artifactId: 'artifact-1', body: '   ' })).toThrow(
      'Annotation text is required',
    );

    createChatArtifactAnnotation({ artifactId: 'artifact-1', body: 'Keep this linked.' });
    database.prepare('DELETE FROM chat_artifacts WHERE id = ?').run('artifact-1');
    expect(listChatArtifactAnnotations('artifact-1')).toEqual([]);
  });
});
