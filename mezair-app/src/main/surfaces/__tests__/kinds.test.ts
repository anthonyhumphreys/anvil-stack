import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema.js';
import type { AgentToolSessionContext } from '../../agent-tools/dispatch.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);
const repoPath = mkdtempSync(join(tmpdir(), 'mezair-surface-kinds-'));

const session = vi.hoisted(() => ({
  broadcastAgentUIIntent: vi.fn(),
  deliverStructuredAgentFeedback: vi.fn(async () => true),
  getCodexSession: vi.fn((id: string) => ({ id })),
  listActiveCodexSessions: vi.fn(() => []),
}));
const offscreen = vi.hoisted(() => ({
  renderOffscreen: vi.fn(async (_html: string, options: { screenshot?: boolean }) => ({
    height: 412,
    ...(options.screenshot ? { png: 'iVBORw0KGgo=' } : {}),
  })),
}));
const shell = vi.hoisted(() => ({ openPath: vi.fn(async () => '') }));

vi.mock('../../db/database.js', () => ({ getDb: () => inMemoryDb }));
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() }, shell }));
vi.mock('../../services/codex-session.service.js', () => session);
vi.mock('../offscreen.js', () => offscreen);
vi.mock('../../services/artifact-share.service.js', () => ({
  publishSharedArtifact: vi.fn(),
  revokeSharedArtifact: vi.fn(),
}));

import { listChatArtifactRevisions } from '../../services/chat-artifact.service.js';
import { getChatSketch } from '../../services/chat-sketch.service.js';
import { getSurface } from '../core.js';
import { artifactSurfaceHandler } from '../kinds/artifact.js';
import { sketchSurfaceHandler } from '../kinds/sketch.js';

const ctx: AgentToolSessionContext = {
  sessionId: 'session-1',
  appThreadId: 'thread-1',
  workspaceId: 'ws-1',
  repoIds: ['repo-1'],
  provider: 'codex',
  mode: 'workspace-auto',
  features: [],
};

const artifactTools = artifactSurfaceHandler.toolProvider!;
const sketchTools = sketchSurfaceHandler.toolProvider!;

beforeEach(() => {
  for (const table of [
    'chat_sketches',
    'chat_artifact_revisions',
    'chat_artifacts',
    'agent_ui_intent_events',
    'agent_ui_intents',
    'chat_threads',
    'repos',
  ]) {
    inMemoryDb.exec(`DELETE FROM ${table}`);
  }
  inMemoryDb
    .prepare('INSERT INTO repos (id, name, path) VALUES (?, ?, ?)')
    .run('repo-1', 'Mezair', repoPath);
  inMemoryDb
    .prepare('INSERT INTO chat_threads (id, persona_id, title, active_repo_id) VALUES (?, ?, ?, ?)')
    .run('thread-1', 'coder', 'Thread', 'repo-1');
  rmSync(join(repoPath, '.mezair'), { recursive: true, force: true });
  vi.clearAllMocks();
});

afterAll(() => {
  inMemoryDb.close();
  rmSync(repoPath, { recursive: true, force: true });
});

describe('artifact tools', () => {
  it('exposes artifact and generic surface tools', () => {
    const names = artifactTools.tools(ctx).map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'artifact_create',
        'artifact_update',
        'artifact_read',
        'artifact_list',
        'surface_read',
        'surface_comments',
        'surface_complete',
        'mezair_skill_get',
      ]),
    );
  });

  it('creates a repository artifact, publishes its surface and returns only a digest', async () => {
    const result = await artifactTools.call(ctx, 'artifact_create', {
      title: 'DB migration runbook',
      kind: 'markdown',
      content: '# Runbook\nsecret body',
    });
    const text = (result?.content[0] as { text: string }).text;
    expect(text).toContain('Artifact "DB migration runbook" v1 (markdown)');
    expect(text).not.toContain('secret body');
    const { artifactId, surfaceId, version } = result!.structuredContent as {
      artifactId: string;
      surfaceId: string;
      version: number;
    };
    expect(version).toBe(1);
    expect(existsSync(join(repoPath, '.mezair/artifacts/db-migration-runbook.md'))).toBe(true);
    expect(getSurface(surfaceId)?.payload).toMatchObject({
      surfaceKind: 'artifact',
      key: `artifact:${artifactId}`,
      data: { artifactId, version: 1, operation: 'created', storage: 'repository' },
    });
    expect(listChatArtifactRevisions(artifactId).map((revision) => revision.version)).toEqual([1]);
  });

  it('updates with a version check, keeps history and supersedes the older surface', async () => {
    const created = await artifactTools.call(ctx, 'artifact_create', {
      title: 'Notes',
      kind: 'markdown',
      storage: 'session',
      content: 'v1 body',
    });
    const { artifactId, surfaceId } = created!.structuredContent as {
      artifactId: string;
      surfaceId: string;
    };
    const updated = await artifactTools.call(ctx, 'artifact_update', {
      artifactId,
      baseVersion: 1,
      content: 'v2 body',
    });
    expect(updated?.structuredContent).toMatchObject({ version: 2 });
    expect(getSurface(surfaceId)?.payload.supersededBy).toBe(updated?.structuredContent?.surfaceId);
    await expect(
      artifactTools.call(ctx, 'artifact_update', { artifactId, baseVersion: 1, content: 'stale' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    const revisions = listChatArtifactRevisions(artifactId);
    expect(revisions.map((revision) => [revision.version, revision.content])).toEqual([
      [2, 'v2 body'],
      [1, 'v1 body'],
    ]);
    const readOld = await artifactTools.call(ctx, 'artifact_read', { artifactId, version: 1 });
    expect((readOld?.content[0] as { text: string }).text).toContain('v1 body');
    const readHead = await artifactTools.call(ctx, 'artifact_read', { artifactId });
    expect((readHead?.content[0] as { text: string }).text).toContain('v2 body');
    const listed = await artifactTools.call(ctx, 'artifact_list', {});
    expect((listed?.content[0] as { text: string }).text).toContain(`${artifactId}: "Notes" v2`);
  });

  it('rejects ambiguous input, inline binaries and other threads', async () => {
    await expect(
      artifactTools.call(ctx, 'artifact_create', { title: 'x', kind: 'markdown' }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    await expect(
      artifactTools.call(ctx, 'artifact_create', { title: 'x', kind: 'docx', content: 'abc' }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    const created = await artifactTools.call(ctx, 'artifact_create', {
      title: 'Mine',
      kind: 'text',
      content: 'hello',
    });
    inMemoryDb
      .prepare('INSERT INTO chat_threads (id, persona_id, title) VALUES (?, ?, ?)')
      .run('thread-2', 'coder', 'x');
    await expect(
      artifactTools.call({ ...ctx, appThreadId: 'thread-2' }, 'artifact_read', {
        artifactId: created?.structuredContent?.artifactId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps read-only sessions out of the repository', async () => {
    const result = await artifactTools.call({ ...ctx, mode: 'read-only' }, 'artifact_create', {
      title: 'Scratch',
      kind: 'markdown',
      content: 'draft',
    });
    expect(getSurface(result?.structuredContent?.surfaceId as string)?.payload.data).toMatchObject({
      storage: 'session',
    });
    expect(existsSync(join(repoPath, '.mezair'))).toBe(false);
  });

  it('saves a session artifact to the repository via the surface action', async () => {
    const created = await artifactTools.call(ctx, 'artifact_create', {
      title: 'Plan',
      kind: 'markdown',
      storage: 'session',
      content: '# Plan',
    });
    const surfaceId = created?.structuredContent?.surfaceId as string;
    const result = await artifactSurfaceHandler.executeAction!(
      { intent: getSurface(surfaceId)! },
      { surfaceId, action: 'save_to_repo' },
    );
    expect(result).toMatchObject({ ok: true });
    expect(existsSync(join(repoPath, '.mezair/artifacts/plan.md'))).toBe(true);
    expect(getSurface(surfaceId)?.payload.data).toMatchObject({
      storage: 'repository',
      version: 2,
    });
  });
});

describe('sketch tools', () => {
  it('shows a sketch without echoing its HTML and measures its height', async () => {
    const result = await sketchTools.call(ctx, 'sketch_show', {
      title: 'Compare libs',
      html: '<div class="secret-markup">chart</div>',
    });
    expect(JSON.stringify(result)).not.toContain('secret-markup');
    const { surfaceId, sketchId, measuredHeight } = result!.structuredContent as {
      surfaceId: string;
      sketchId: string;
      measuredHeight: number;
    };
    expect(measuredHeight).toBe(412);
    expect(getSurface(surfaceId)?.payload.data).toEqual({
      sketchId,
      title: 'Compare libs',
      height: 412,
    });
    expect(getChatSketch(sketchId)?.html).toContain('secret-markup');
  });

  it('updates in place, keeps as an artifact and snapshots', async () => {
    const shown = await sketchTools.call(ctx, 'sketch_show', { title: 'Flow', html: '<p>v1</p>' });
    const { surfaceId, sketchId } = shown!.structuredContent as {
      surfaceId: string;
      sketchId: string;
    };

    const updated = await sketchTools.call(ctx, 'sketch_update', { surfaceId, html: '<p>v2</p>' });
    expect(updated?.structuredContent).toMatchObject({ revision: 2 });
    expect(getChatSketch(sketchId)?.html).toBe('<p>v2</p>');

    const kept = await sketchTools.call(ctx, 'sketch_keep', { surfaceId });
    const artifactId = kept?.structuredContent?.artifactId as string;
    expect(kept?.structuredContent).toMatchObject({ version: 1 });
    expect(getChatSketch(sketchId)?.keptArtifactId).toBe(artifactId);
    expect(getSurface(surfaceId)?.payload.data).toMatchObject({ keptArtifactId: artifactId });
    expect(listChatArtifactRevisions(artifactId)[0].content).toBe('<p>v2</p>');

    const snapshot = await sketchTools.call(ctx, 'sketch_snapshot', { surfaceId });
    expect(snapshot?.content[0]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    expect(offscreen.renderOffscreen).toHaveBeenLastCalledWith(expect.any(String), {
      width: 728,
      screenshot: true,
    });
  });

  it('caps sketch HTML size and rejects non-sketch surfaces', async () => {
    await expect(
      sketchTools.call(ctx, 'sketch_show', { title: 'Huge', html: 'x'.repeat(1_600_000) }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
    const artifact = await artifactTools.call(ctx, 'artifact_create', {
      title: 'Doc',
      kind: 'text',
      content: 'x',
    });
    await expect(
      sketchTools.call(ctx, 'sketch_update', {
        surfaceId: artifact?.structuredContent?.surfaceId,
        html: '<p>x</p>',
      }),
    ).rejects.toMatchObject({ code: 'invalid-params' });
  });

  it('still shows the sketch when offscreen rendering fails', async () => {
    offscreen.renderOffscreen.mockRejectedValueOnce(new Error('no window'));
    const result = await sketchTools.call(ctx, 'sketch_show', {
      title: 'x',
      html: '<p>x</p>',
      height: 200,
    });
    expect(result?.structuredContent).toMatchObject({ measuredHeight: null });
    expect(getSurface(result?.structuredContent?.surfaceId as string)?.payload.data).toMatchObject({
      height: 200,
    });
  });
});
