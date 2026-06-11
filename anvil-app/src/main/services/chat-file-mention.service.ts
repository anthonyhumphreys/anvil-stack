import path from 'node:path';
import type {
  ChatFileMentionSearchInput,
  ChatFileMentionSearchResult,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { type FileEntry, walkRepo } from '../utils/file-walker.js';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 50;
const MAX_QUERY_LENGTH = 160;
const CACHE_TTL_MS = 60_000;

interface RepoMentionRow {
  id: string;
  name: string;
  path: string;
}

interface CachedRepoFiles {
  repoPath: string;
  expiresAt: number;
  files: FileEntry[];
}

interface RankedMention {
  result: ChatFileMentionSearchResult;
  score: number;
}

const repoFileCache = new Map<string, CachedRepoFiles>();

export async function searchChatFileMentions(
  input: ChatFileMentionSearchInput,
): Promise<ChatFileMentionSearchResult[]> {
  const repoIds = normaliseRepoIds(input?.repoIds);
  if (repoIds.length === 0) return [];

  const query = normaliseQuery(input?.query);
  const limit = normaliseLimit(input?.limit);
  const repos = getMentionRepos(repoIds);
  if (repos.length === 0) return [];

  const rankedLists = await Promise.all(
    repos.map(async (repo, repoIndex) => rankRepoFiles(repo, query, repoIndex)),
  );

  return rankedLists
    .flat()
    .filter((mention) => mention.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.result.relativePath.localeCompare(right.result.relativePath);
    })
    .slice(0, limit)
    .map((mention) => mention.result);
}

export function clearChatFileMentionCache(): void {
  repoFileCache.clear();
}

async function rankRepoFiles(
  repo: RepoMentionRow,
  query: string,
  repoIndex: number,
): Promise<RankedMention[]> {
  try {
    const files = await getRepoFiles(repo);
    return files.map((file) => {
      const score = scoreFile(file, query, repoIndex);
      return {
        score,
        result: {
          repoId: repo.id,
          repoName: repo.name,
          relativePath: file.relativePath,
          name: path.basename(file.relativePath),
          path: path.join(repo.path, file.relativePath),
          size: file.sizeBytes,
        },
      };
    });
  } catch {
    return [];
  }
}

async function getRepoFiles(repo: RepoMentionRow): Promise<FileEntry[]> {
  const now = Date.now();
  const cached = repoFileCache.get(repo.id);
  if (cached && cached.repoPath === repo.path && cached.expiresAt > now) {
    return cached.files;
  }

  const files = await walkRepo(repo.path);
  repoFileCache.set(repo.id, {
    repoPath: repo.path,
    expiresAt: now + CACHE_TTL_MS,
    files,
  });
  return files;
}

function getMentionRepos(repoIds: string[]): RepoMentionRow[] {
  const db = getDb();
  const stmt = db.prepare('SELECT id, name, path FROM repos WHERE id = ?');

  return repoIds
    .map((repoId) => stmt.get(repoId) as RepoMentionRow | undefined)
    .filter((repo): repo is RepoMentionRow => Boolean(repo?.path));
}

function scoreFile(file: FileEntry, query: string, repoIndex: number): number {
  const relativePath = file.relativePath.toLowerCase();
  const basename = path.basename(relativePath);
  const compactRelativePath = compactPath(relativePath);
  const compactBasename = compactPath(basename);
  const compactQuery = compactPath(query);
  const depthPenalty = Math.max(file.relativePath.split('/').length - 1, 0) * 2;
  const sizePenalty = Math.min(file.sizeBytes / 100_000, 30);
  const repoPenalty = repoIndex * 4;

  if (!query) {
    return 80 + keyFileBonus(basename) - depthPenalty - sizePenalty - repoPenalty;
  }

  let score = 0;
  if (basename === query) score += 1_000;
  if (relativePath === query) score += 950;
  if (basename.startsWith(query)) score += 850;
  if (relativePath.startsWith(query)) score += 760;
  if (compactBasename.startsWith(compactQuery)) score += 700;
  if (basename.includes(query)) score += 520;
  if (relativePath.includes(query)) score += 360;
  if (compactRelativePath.includes(compactQuery)) score += 260;

  const terms = query.split(/[\/_.\-\s]+/).filter(Boolean);
  if (terms.length > 1 && terms.every((term) => relativePath.includes(term))) {
    score += 240;
  }

  if (score === 0) return 0;
  return score + keyFileBonus(basename) - depthPenalty - sizePenalty - repoPenalty;
}

function keyFileBonus(basename: string): number {
  if (basename === 'readme.md') return 80;
  if (basename === 'package.json') return 70;
  if (basename === 'tsconfig.json') return 55;
  if (basename === 'vite.config.ts' || basename === 'vite.config.js') return 50;
  if (basename.endsWith('.config.ts') || basename.endsWith('.config.js')) return 40;
  if (/^(index|main|app|server)\.[a-z0-9]+$/i.test(basename)) return 35;
  return 0;
}

function normaliseRepoIds(repoIds: string[] | undefined): string[] {
  if (!Array.isArray(repoIds)) return [];

  const seen = new Set<string>();
  return repoIds
    .map((repoId) => repoId.trim())
    .filter((repoId) => {
      if (!repoId || seen.has(repoId)) return false;
      seen.add(repoId);
      return true;
    });
}

function normaliseQuery(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
}

function normaliseLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit!), 1), MAX_LIMIT);
}

function compactPath(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}
