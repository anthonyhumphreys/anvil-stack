// Workspace Library (docs/plans/inline-artifacts-and-canvas-tools.md §10).
//
// Lists the head version of every durable thing a workspace has produced:
// chat artifacts and durable native surfaces across its threads, plus repo
// knowledge (ADRs, diagrams, compliance docs). Sketches are throwaway and are
// deliberately excluded. Everything is scoped to the workspace: threads by
// `chat_threads.workspace_id`, repo knowledge by `workspace_repos`.

import fs from 'node:fs';
import path from 'node:path';
import type { LibraryItem, LibraryItemKind, LibraryListFilter } from '../../shared/library-ipc.js';
import { getDb } from '../db/database.js';

export interface LibraryRepo {
  id: string;
  name: string;
  path: string;
}

/** Repo-knowledge sources, injectable for tests. Each returns items for one repo. */
export interface LibraryKnowledgeSources {
  adrs(repo: LibraryRepo): Promise<LibraryItem[]> | LibraryItem[];
  diagrams(repo: LibraryRepo): Promise<LibraryItem[]> | LibraryItem[];
  compliance(repo: LibraryRepo): Promise<LibraryItem[]> | LibraryItem[];
}

const KNOWLEDGE_KINDS = ['adr', 'diagram', 'compliance'] as const;
type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Surfaces that end when their turn does; never listed. */
const EXCLUDED_SURFACE_KINDS = new Set(['sketch']);
const EXCLUDED_SURFACE_LIFECYCLES = new Set(['dismissed', 'expired']);

interface ArtifactRow {
  id: string;
  thread_id: string;
  repo_id: string | null;
  title: string;
  kind: string;
  relative_path: string;
  version: number;
  updated_at: string;
  thread_title: string;
  repo_name: string | null;
  shared: number;
}

interface SurfaceRow {
  id: string;
  thread_id: string;
  revision: number;
  lifecycle: string;
  intent_json: string;
  updated_at: string;
  thread_title: string;
  active_repo_id: string | null;
}

export async function listLibraryItems(
  workspaceId: string,
  filter: LibraryListFilter = {},
  sources: LibraryKnowledgeSources = defaultKnowledgeSources,
): Promise<LibraryItem[]> {
  const db = getDb();
  const repos = listWorkspaceRepos(workspaceId);
  const repoNames = new Map(repos.map((repo) => [repo.id, repo.name]));
  const wants = (kind: LibraryItemKind) => !filter.kind || filter.kind === kind;
  const items: LibraryItem[] = [];
  const nowIso = new Date().toISOString();

  const artifactIds = new Set<string>();
  if (wants('artifact') || wants('surface')) {
    const rows = db
      .prepare(
        `SELECT a.id, a.thread_id, a.repo_id, a.title, a.kind, a.relative_path, a.version,
                a.updated_at, t.title AS thread_title, r.name AS repo_name,
                EXISTS (
                  SELECT 1 FROM shares s
                  WHERE s.item_type = 'artifact' AND s.item_id = a.id
                    AND s.revoked_at IS NULL
                    AND (s.expires_at IS NULL OR s.expires_at > ?)
                ) AS shared
         FROM chat_artifacts a
         JOIN chat_threads t ON t.id = a.thread_id
         LEFT JOIN repos r ON r.id = a.repo_id
         WHERE t.workspace_id = ?`,
      )
      .all(nowIso, workspaceId) as ArtifactRow[];
    for (const row of rows) {
      artifactIds.add(row.id);
      if (!wants('artifact')) continue;
      items.push({
        id: row.id,
        kind: 'artifact',
        subtype: row.kind,
        title: row.title,
        repoId: row.repo_id ?? undefined,
        repoName: row.repo_name ?? (row.repo_id ? repoNames.get(row.repo_id) : undefined),
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        path: row.relative_path,
        version: row.version,
        shared: row.shared === 1,
        updatedAt: row.updated_at,
      });
    }
  }

  if (wants('surface')) {
    const sharedSurfaceIds = new Set(
      (
        db
          .prepare(
            `SELECT item_id FROM shares
             WHERE item_type = 'surface' AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .all(nowIso) as Array<{ item_id: string }>
      ).map((row) => row.item_id),
    );
    const rows = db
      .prepare(
        `SELECT i.id, i.thread_id, i.revision, i.lifecycle, i.intent_json, i.updated_at,
                t.title AS thread_title, t.active_repo_id
         FROM agent_ui_intents i
         JOIN chat_threads t ON t.id = i.thread_id
         WHERE i.kind = 'surface' AND t.workspace_id = ?`,
      )
      .all(workspaceId) as SurfaceRow[];
    for (const row of rows) {
      const item = toSurfaceItem(row, artifactIds, sharedSurfaceIds);
      if (!item) continue;
      item.repoName = item.repoId ? repoNames.get(item.repoId) : undefined;
      items.push(item);
    }
  }

  const knowledgeKinds = KNOWLEDGE_KINDS.filter((kind) => wants(kind));
  if (knowledgeKinds.length > 0) {
    const targetRepos = filter.repoId ? repos.filter((repo) => repo.id === filter.repoId) : repos;
    const batches = await Promise.all(
      targetRepos.flatMap((repo) =>
        knowledgeKinds.map((kind) => loadKnowledge(sources, kind, repo)),
      ),
    );
    items.push(...batches.flat());
  }

  return applyLibraryFilter(items, filter).sort(compareNewestFirst);
}

/** Pure post-filter shared by the service and its tests. */
export function applyLibraryFilter(items: LibraryItem[], filter: LibraryListFilter): LibraryItem[] {
  const query = filter.query?.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.kind && item.kind !== filter.kind) return false;
    if (filter.repoId && item.repoId !== filter.repoId) return false;
    if (filter.sharedOnly && !item.shared) return false;
    if (!query) return true;
    return [item.title, item.subtype, item.threadTitle, item.repoName, item.path]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(query));
  });
}

function compareNewestFirst(a: LibraryItem, b: LibraryItem): number {
  return timestamp(b.updatedAt) - timestamp(a.updatedAt) || a.title.localeCompare(b.title);
}

function timestamp(value: string): number {
  // SQLite datetime('now') values have no zone; treat them as UTC.
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toSurfaceItem(
  row: SurfaceRow,
  artifactIds: ReadonlySet<string>,
  sharedSurfaceIds: ReadonlySet<string>,
): LibraryItem | null {
  if (EXCLUDED_SURFACE_LIFECYCLES.has(row.lifecycle)) return null;
  let intent: unknown;
  try {
    intent = JSON.parse(row.intent_json);
  } catch {
    return null;
  }
  const payload = isRecord(intent) && isRecord(intent.payload) ? intent.payload : null;
  if (!payload) return null;
  const surfaceKind = typeof payload.surfaceKind === 'string' ? payload.surfaceKind : null;
  if (!surfaceKind || EXCLUDED_SURFACE_KINDS.has(surfaceKind)) return null;
  if (typeof payload.supersededBy === 'string' && payload.supersededBy) return null;

  const data = isRecord(payload.data) ? payload.data : {};
  // An artifact surface that points at a chat artifact is already listed as that artifact.
  if (
    surfaceKind === 'artifact' &&
    typeof data.artifactId === 'string' &&
    artifactIds.has(data.artifactId)
  ) {
    return null;
  }

  const repoId = typeof data.repoId === 'string' ? data.repoId : (row.active_repo_id ?? undefined);
  return {
    id: row.id,
    kind: 'surface',
    subtype: surfaceKind,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : surfaceKind,
    repoId,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    version: row.revision,
    shared: sharedSurfaceIds.has(row.id),
    updatedAt: row.updated_at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listWorkspaceRepos(workspaceId: string): LibraryRepo[] {
  return getDb()
    .prepare(
      `SELECT r.id, r.name, r.path
       FROM repos r
       JOIN workspace_repos wr ON wr.repo_id = r.id
       WHERE wr.workspace_id = ?
       ORDER BY r.name COLLATE NOCASE`,
    )
    .all(workspaceId) as LibraryRepo[];
}

async function loadKnowledge(
  sources: LibraryKnowledgeSources,
  kind: KnowledgeKind,
  repo: LibraryRepo,
): Promise<LibraryItem[]> {
  try {
    const items =
      kind === 'adr'
        ? await sources.adrs(repo)
        : kind === 'diagram'
          ? await sources.diagrams(repo)
          : await sources.compliance(repo);
    // Repo scope comes from the workspace, never from the source.
    return items.map((item) => ({ ...item, repoId: repo.id, repoName: repo.name }));
  } catch (error) {
    // One unreadable checkout must not hide the rest of the Library.
    console.warn(`[Library] Failed to list ${kind} items for ${repo.name}:`, error);
    return [];
  }
}

function fileUpdatedAt(filePath: string, fallback = new Date(0)): string {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return fallback.toISOString();
  }
}

/** Filesystem-backed sources; heavy services are imported lazily. */
export const defaultKnowledgeSources: LibraryKnowledgeSources = {
  async adrs(repo) {
    if (!fs.existsSync(repo.path)) return [];
    const { scanRepoForAdrs } = await import('./adr-discovery.service.js');
    return scanRepoForAdrs(repo.path).map((adr) => ({
      id: `adr:${repo.id}:${adr.relativePath}`,
      kind: 'adr' as const,
      subtype: adr.status,
      title: adr.title,
      path: adr.relativePath,
      updatedAt: fileUpdatedAt(path.join(repo.path, adr.relativePath)),
    }));
  },
  async diagrams(repo) {
    if (!fs.existsSync(repo.path)) return [];
    const { listDiagramFiles } = await import('./diagram-file.service.js');
    return listDiagramFiles(repo.path).map((diagram) => ({
      id: `diagram:${repo.id}:${diagram.filename}`,
      kind: 'diagram' as const,
      subtype: 'drawio',
      title: diagram.title,
      path: diagram.filename,
      updatedAt: new Date(diagram.mtime).toISOString(),
    }));
  },
  async compliance(repo) {
    if (!fs.existsSync(repo.path)) return [];
    const { listComplianceDocs } = await import('./compliance.service.js');
    const docs = await listComplianceDocs(repo.id);
    return docs.map((doc) => ({
      id: `compliance:${repo.id}:${doc.docType}`,
      kind: 'compliance' as const,
      subtype: doc.docType,
      title: doc.title,
      path: doc.filename,
      updatedAt: doc.generatedAt,
    }));
  },
};
