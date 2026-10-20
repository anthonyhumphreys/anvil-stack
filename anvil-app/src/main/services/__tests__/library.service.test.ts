import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '../../../shared/library-ipc.js';
import { SCHEMA_SQL } from '../../db/schema.js';

const database = new Database(':memory:');
database.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({ getDb: () => database }));

import {
  applyLibraryFilter,
  listLibraryItems,
  type LibraryKnowledgeSources,
  type LibraryRepo,
} from '../library.service.js';
import { parseLibraryFilter } from '../../ipc/library.ipc.js';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

const T = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

function insertWorkspace(id: string) {
  database
    .prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, id, T(0), T(0));
}

function insertRepo(id: string, workspaceId: string) {
  database
    .prepare('INSERT INTO repos (id, name, path) VALUES (?, ?, ?)')
    .run(id, `${id}-name`, `/tmp/library-test/${id}`);
  database
    .prepare('INSERT INTO workspace_repos (workspace_id, repo_id, added_at) VALUES (?, ?, ?)')
    .run(workspaceId, id, T(0));
}

function insertThread(id: string, workspaceId: string, title: string, activeRepoId?: string) {
  database
    .prepare(
      `INSERT INTO chat_threads
       (id, workspace_id, persona_id, title, repo_ids_json, active_repo_id, created_at, updated_at)
       VALUES (?, ?, 'coder', ?, '[]', ?, ?, ?)`,
    )
    .run(id, workspaceId, title, activeRepoId ?? null, T(0), T(0));
}

function insertArtifact(input: {
  id: string;
  threadId: string;
  title: string;
  kind?: string;
  repoId?: string;
  version?: number;
  updatedAt: string;
}) {
  database
    .prepare(
      `INSERT INTO chat_artifacts
       (id, thread_id, repo_id, title, kind, relative_path, content, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    )
    .run(
      input.id,
      input.threadId,
      input.repoId ?? null,
      input.title,
      input.kind ?? 'markdown',
      `${input.id}.md`,
      input.version ?? 1,
      input.updatedAt,
      input.updatedAt,
    );
}

function insertSurface(input: {
  id: string;
  threadId: string;
  surfaceKind: string;
  title: string;
  updatedAt: string;
  lifecycle?: string;
  supersededBy?: string;
  data?: Record<string, unknown>;
  revision?: number;
}) {
  const intent = {
    protocolVersion: 1,
    id: input.id,
    kind: 'surface',
    revision: input.revision ?? 1,
    scope: { threadId: input.threadId },
    lifecycle: input.lifecycle ?? 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: input.surfaceKind,
      title: input.title,
      streaming: false,
      digest: input.title,
      data: input.data ?? {},
      ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
    },
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  };
  database
    .prepare(
      `INSERT INTO agent_ui_intents
       (id, thread_id, kind, protocol_version, revision, lifecycle, intent_json, created_at, updated_at)
       VALUES (?, ?, 'surface', 1, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.threadId,
      input.revision ?? 1,
      input.lifecycle ?? 'presented',
      JSON.stringify(intent),
      input.updatedAt,
      input.updatedAt,
    );
}

function insertShare(input: {
  itemType: 'artifact' | 'surface';
  itemId: string;
  revokedAt?: string;
  expiresAt?: string;
}) {
  const id = `share-${Math.random().toString(36).slice(2)}`;
  database
    .prepare(
      `INSERT INTO shares
       (id, item_type, item_id, version, share_id, media_type, title, expires_at, created_at, updated_at, revoked_at)
       VALUES (?, ?, ?, 1, ?, 'text/markdown', 'Shared', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.itemType,
      input.itemId,
      `remote-${id}`,
      input.expiresAt ?? null,
      T(0),
      T(0),
      input.revokedAt ?? null,
    );
}

const knowledgeCalls: Array<{ kind: string; repo: string }> = [];

const fakeSources: LibraryKnowledgeSources = {
  adrs: (repo: LibraryRepo) => {
    knowledgeCalls.push({ kind: 'adr', repo: repo.id });
    return repo.id === 'repo-a'
      ? [
          {
            id: `adr:${repo.id}:docs/adr/0001.md`,
            kind: 'adr',
            subtype: 'Accepted',
            title: 'Use SQLite',
            path: 'docs/adr/0001.md',
            // A source cannot re-scope its items to another repo.
            repoId: 'some-other-repo',
            updatedAt: T(5),
          },
        ]
      : [];
  },
  diagrams: (repo: LibraryRepo) => {
    knowledgeCalls.push({ kind: 'diagram', repo: repo.id });
    if (repo.id === 'repo-b') throw new Error('unreadable checkout');
    return [
      {
        id: `diagram:${repo.id}:auth.drawio`,
        kind: 'diagram',
        subtype: 'drawio',
        title: 'auth',
        path: 'auth.drawio',
        updatedAt: T(3),
      },
    ];
  },
  compliance: async (repo: LibraryRepo) => {
    knowledgeCalls.push({ kind: 'compliance', repo: repo.id });
    return repo.id === 'repo-a'
      ? [
          {
            id: `compliance:${repo.id}:dpia`,
            kind: 'compliance',
            subtype: 'dpia',
            title: 'Data Protection Impact Assessment',
            path: 'DPIA.md',
            updatedAt: T(1),
          },
        ]
      : [];
  },
};

beforeEach(() => {
  knowledgeCalls.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const table of [
    'shares',
    'agent_ui_intents',
    'chat_artifacts',
    'chat_threads',
    'workspace_repos',
    'repos',
    'workspaces',
  ]) {
    database.exec(`DELETE FROM ${table}`);
  }

  insertWorkspace('ws-1');
  insertWorkspace('ws-2');
  insertRepo('repo-a', 'ws-1');
  insertRepo('repo-b', 'ws-1');
  insertRepo('repo-z', 'ws-2');
  insertThread('thread-1', 'ws-1', 'Auth hardening', 'repo-a');
  insertThread('thread-2', 'ws-1', 'Release prep');
  insertThread('thread-other', 'ws-2', 'Other workspace');

  insertArtifact({
    id: 'art-1',
    threadId: 'thread-1',
    title: 'Threat model',
    repoId: 'repo-a',
    version: 3,
    updatedAt: T(10),
  });
  insertArtifact({ id: 'art-2', threadId: 'thread-2', title: 'Release notes', updatedAt: T(2) });
  insertArtifact({ id: 'art-other', threadId: 'thread-other', title: 'Hidden', updatedAt: T(30) });

  insertSurface({
    id: 'surf-review',
    threadId: 'thread-1',
    surfaceKind: 'review',
    title: 'Review: auth branch',
    revision: 2,
    updatedAt: T(8),
  });
  insertSurface({
    id: 'surf-findings',
    threadId: 'thread-2',
    surfaceKind: 'findings',
    title: 'Security findings',
    data: { repoId: 'repo-b' },
    updatedAt: T(6),
  });
  insertSurface({
    id: 'surf-sketch',
    threadId: 'thread-1',
    surfaceKind: 'sketch',
    title: 'Quick sketch',
    updatedAt: T(20),
  });
  insertSurface({
    id: 'surf-old',
    threadId: 'thread-1',
    surfaceKind: 'review',
    title: 'Old review',
    supersededBy: 'surf-review',
    updatedAt: T(4),
  });
  insertSurface({
    id: 'surf-dismissed',
    threadId: 'thread-1',
    surfaceKind: 'pipeline',
    title: 'Dismissed pipeline',
    lifecycle: 'dismissed',
    updatedAt: T(9),
  });
  insertSurface({
    id: 'surf-artifact-dup',
    threadId: 'thread-1',
    surfaceKind: 'artifact',
    title: 'Threat model',
    data: { artifactId: 'art-1' },
    updatedAt: T(11),
  });
  insertSurface({
    id: 'surf-other',
    threadId: 'thread-other',
    surfaceKind: 'review',
    title: 'Other workspace review',
    updatedAt: T(40),
  });

  insertShare({ itemType: 'artifact', itemId: 'art-1' });
  insertShare({ itemType: 'artifact', itemId: 'art-2', revokedAt: T(5) });
  insertShare({ itemType: 'surface', itemId: 'surf-findings', expiresAt: '2000-01-01T00:00:00Z' });
  insertShare({ itemType: 'surface', itemId: 'surf-review', expiresAt: '2999-01-01T00:00:00Z' });
});

const ids = (items: LibraryItem[]) => items.map((item) => item.id);

describe('listLibraryItems', () => {
  it('lists workspace artifacts, durable surfaces and repo knowledge, newest first', async () => {
    const items = await listLibraryItems('ws-1', {}, fakeSources);
    expect(ids(items)).toEqual([
      'art-1',
      'surf-review',
      'surf-findings',
      'adr:repo-a:docs/adr/0001.md',
      'diagram:repo-a:auth.drawio',
      'art-2',
      'compliance:repo-a:dpia',
    ]);
  });

  it('excludes sketches, superseded and dismissed surfaces, and duplicate artifact surfaces', async () => {
    const surfaces = await listLibraryItems('ws-1', { kind: 'surface' }, fakeSources);
    expect(ids(surfaces)).toEqual(['surf-review', 'surf-findings']);
  });

  it('never leaks another workspace’s threads or repos', async () => {
    const items = await listLibraryItems('ws-2', {}, fakeSources);
    expect(ids(items)).toEqual(['surf-other', 'art-other', 'diagram:repo-z:auth.drawio']);
    expect(knowledgeCalls.every((call) => call.repo === 'repo-z')).toBe(true);
  });

  it('describes artifacts with head version, thread, repo and live share state', async () => {
    const [threatModel, releaseNotes] = await listLibraryItems(
      'ws-1',
      { kind: 'artifact' },
      fakeSources,
    );
    expect(threatModel).toMatchObject({
      id: 'art-1',
      kind: 'artifact',
      subtype: 'markdown',
      title: 'Threat model',
      repoId: 'repo-a',
      repoName: 'repo-a-name',
      threadId: 'thread-1',
      threadTitle: 'Auth hardening',
      version: 3,
      shared: true,
    });
    // Revoked share ⇒ not shared.
    expect(releaseNotes).toMatchObject({ id: 'art-2', shared: false });
  });

  it('describes surfaces with kind, revision, repo and share state (expired ⇒ not shared)', async () => {
    const surfaces = await listLibraryItems('ws-1', { kind: 'surface' }, fakeSources);
    expect(surfaces[0]).toMatchObject({
      id: 'surf-review',
      subtype: 'review',
      version: 2,
      repoId: 'repo-a', // from the thread's active repo
      threadTitle: 'Auth hardening',
      shared: true,
    });
    expect(surfaces[1]).toMatchObject({
      id: 'surf-findings',
      subtype: 'findings',
      repoId: 'repo-b', // from the payload
      repoName: 'repo-b-name',
      shared: false,
    });
  });

  it('filters by kind without touching unrelated sources', async () => {
    const adrs = await listLibraryItems('ws-1', { kind: 'adr' }, fakeSources);
    expect(ids(adrs)).toEqual(['adr:repo-a:docs/adr/0001.md']);
    expect(adrs[0]).toMatchObject({ repoId: 'repo-a', repoName: 'repo-a-name' });
    expect(new Set(knowledgeCalls.map((call) => call.kind))).toEqual(new Set(['adr']));
  });

  it('filters by repo and only scans that repo', async () => {
    const items = await listLibraryItems('ws-1', { repoId: 'repo-a' }, fakeSources);
    expect(ids(items)).toEqual([
      'art-1',
      'surf-review',
      'adr:repo-a:docs/adr/0001.md',
      'diagram:repo-a:auth.drawio',
      'compliance:repo-a:dpia',
    ]);
    expect(knowledgeCalls.every((call) => call.repo === 'repo-a')).toBe(true);
  });

  it('matches the text query against title, kind, thread and path', async () => {
    // "Release notes" by title, and the findings surface via its thread "Release prep".
    expect(ids(await listLibraryItems('ws-1', { query: 'release' }, fakeSources))).toEqual([
      'surf-findings',
      'art-2',
    ]);
    expect(ids(await listLibraryItems('ws-1', { query: 'threat' }, fakeSources))).toEqual([
      'art-1',
    ]);
    expect(ids(await listLibraryItems('ws-1', { query: 'FINDINGS' }, fakeSources))).toEqual([
      'surf-findings',
    ]);
    expect(ids(await listLibraryItems('ws-1', { query: 'dpia' }, fakeSources))).toEqual([
      'compliance:repo-a:dpia',
    ]);
  });

  it('lists only live shares with sharedOnly', async () => {
    expect(ids(await listLibraryItems('ws-1', { sharedOnly: true }, fakeSources))).toEqual([
      'art-1',
      'surf-review',
    ]);
  });

  it('survives a failing knowledge source', async () => {
    const diagrams = await listLibraryItems('ws-1', { kind: 'diagram' }, fakeSources);
    expect(ids(diagrams)).toEqual(['diagram:repo-a:auth.drawio']);
  });
});

describe('applyLibraryFilter', () => {
  it('returns everything for an empty filter', () => {
    const items: LibraryItem[] = [
      { id: 'a', kind: 'doc', title: 'A', updatedAt: T(1) },
      { id: 'b', kind: 'adr', title: 'B', updatedAt: T(2) },
    ];
    expect(applyLibraryFilter(items, {})).toHaveLength(2);
    expect(ids(applyLibraryFilter(items, { kind: 'adr' }))).toEqual(['b']);
  });
});

describe('parseLibraryFilter', () => {
  it('accepts valid filters and trims the query', () => {
    expect(parseLibraryFilter(undefined)).toEqual({});
    expect(
      parseLibraryFilter({ kind: 'surface', repoId: 'r1', query: '  auth ', sharedOnly: true }),
    ).toEqual({ kind: 'surface', repoId: 'r1', query: 'auth', sharedOnly: true });
    expect(parseLibraryFilter({ query: '   ', repoId: '' })).toEqual({});
  });

  it('rejects malformed filters', () => {
    expect(() => parseLibraryFilter('adr')).toThrow();
    expect(() => parseLibraryFilter({ kind: 'sketch' })).toThrow(/Unknown library kind/);
    expect(() => parseLibraryFilter({ repoId: 4 })).toThrow();
    expect(() => parseLibraryFilter({ sharedOnly: 'yes' })).toThrow();
  });
});
