// Resolves the diff for a review scope (turn, working tree, PR, commit range)
// using the existing git / code-review services. Results are cached briefly so
// review_context → review_publish → review_patch validate against the same diff.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getDb } from '../../../db/database.js';
import { AgentToolError, type AgentToolSessionContext } from '../../../agent-tools/dispatch.js';
import { getCommitRangeDiff, resolveGitRef } from '../../../services/code-review-git.service.js';
import { getPullRequestDiff } from '../../../services/pull-request-visualisation.service.js';
import type { CodeReviewPullRequest } from '../../../../shared/types.js';
import {
  normalizeReviewPath,
  parseUnifiedDiff,
  type ParsedDiffFile,
} from '../../../../shared/surfaces/kinds/review/diff.js';
import { reviewSurfaceKey } from '../../../../shared/surfaces/kinds/review/model.js';
import type {
  ReviewScope,
  ReviewScopeType,
} from '../../../../shared/surfaces/kinds/review/types.js';

const execFileAsync = promisify(execFile);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const CACHE_TTL_MS = 15 * 60 * 1000;
const SAFE_REF = /^[A-Za-z0-9_./@^~{}+-]+$/;

export interface ReviewRepoRecord {
  id: string;
  name: string;
  path: string;
  remoteUrl?: string;
}

export interface ReviewScopeRequest {
  type: ReviewScopeType;
  repoId: string;
  pullRequestId?: string;
  baseRef?: string;
  headRef?: string;
  /** `base..head` shorthand for commit ranges (as stored on a published scope). */
  ref?: string;
  title?: string;
}

export interface LoadedReviewDiff {
  scope: ReviewScope;
  key: string;
  repo: ReviewRepoRecord;
  files: ParsedDiffFile[];
  /** Raw unified diff per file path, for context output. */
  rawByPath: Map<string, string>;
  pullRequest?: CodeReviewPullRequest;
  notes: string[];
  loadedAt: number;
}

const cache = new Map<string, LoadedReviewDiff>();

export function clearReviewDiffCache(): void {
  cache.clear();
}

export function getReviewRepo(repoId: string): ReviewRepoRecord {
  const row = getDb()
    .prepare('SELECT id, name, path, remote_url FROM repos WHERE id = ?')
    .get(repoId) as
    { id: string; name: string; path: string; remote_url: string | null } | undefined;
  if (!row) throw new AgentToolError(`Repository not found: ${repoId}`, 'not-found');
  return { id: row.id, name: row.name, path: row.path, remoteUrl: row.remote_url ?? undefined };
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 48 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

/** HEAD vs the working tree, including untracked (non-ignored) files, without touching the user's index. */
export async function loadWorkingTreeDiff(repoPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'anvil-review-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    let head = EMPTY_TREE;
    try {
      head = (await git(repoPath, ['rev-parse', '--verify', 'HEAD'])).trim() || EMPTY_TREE;
    } catch {
      // Unborn branch: diff against the empty tree.
    }
    if (head !== EMPTY_TREE) await git(repoPath, ['read-tree', head], env);
    await git(repoPath, ['add', '-A', '--', '.', ':(exclude).anvil', ':(exclude)**/.anvil'], env);
    return await git(
      repoPath,
      ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', head],
      env,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Files the agent edited in the most recent turn of this thread that edited files. */
export function listLatestTurnEditedFiles(threadId: string, repoPath: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT role, event_json FROM chat_messages
       WHERE thread_id = ?
       ORDER BY timestamp DESC, rowid DESC
       LIMIT 4000`,
    )
    .all(threadId) as Array<{ role: string; event_json: string | null }>;
  const paths = new Set<string>();
  for (const row of rows) {
    if (row.role === 'user') {
      if (paths.size > 0) break;
      continue;
    }
    if (!row.event_json) continue;
    try {
      const event = JSON.parse(row.event_json) as { type?: string; filePath?: unknown };
      if (event.type === 'file_edit' && typeof event.filePath === 'string' && event.filePath) {
        paths.add(normalizeReviewPath(event.filePath, repoPath));
      }
    } catch {
      // Ignore malformed rows.
    }
  }
  return [...paths];
}

function assertSafeRef(ref: string, label: string): string {
  const value = ref.trim();
  if (!value || value.startsWith('-') || !SAFE_REF.test(value) || value.includes('..')) {
    throw new AgentToolError(`${label} is not a valid git ref: ${ref}`, 'invalid-params');
  }
  return value;
}

function splitRawByPath(raw: string, files: ParsedDiffFile[]): Map<string, string> {
  const map = new Map<string, string>();
  const parts = raw.split(/^(?=diff --git )/m).filter((part) => part.trim());
  parts.forEach((part, index) => {
    const parsed = parseUnifiedDiff(part)[0];
    const path = parsed?.path ?? files[index]?.path;
    if (path) map.set(path, part.endsWith('\n') ? part : `${part}\n`);
  });
  return map;
}

function scopeRequestKey(request: ReviewScopeRequest, threadId?: string): string {
  return [
    request.repoId,
    request.type,
    request.pullRequestId ?? '',
    request.baseRef ?? '',
    request.headRef ?? '',
    request.ref ?? '',
    request.type === 'turn' ? (threadId ?? '') : '',
  ].join('|');
}

function normalizeRequest(request: ReviewScopeRequest): ReviewScopeRequest {
  if (request.type !== 'commit-range') return request;
  if (!request.baseRef && request.ref?.includes('..')) {
    const [baseRef, headRef] = request.ref.split(/\.{2,3}/);
    return { ...request, baseRef, headRef: headRef || 'HEAD', ref: undefined };
  }
  return { ...request, headRef: request.headRef || 'HEAD', ref: undefined };
}

export async function loadReviewDiff(
  ctx: AgentToolSessionContext,
  rawRequest: ReviewScopeRequest,
  options: { fresh?: boolean } = {},
): Promise<LoadedReviewDiff> {
  const request = normalizeRequest(rawRequest);
  const cacheKey = scopeRequestKey(request, ctx.appThreadId);
  const cached = cache.get(cacheKey);
  if (!options.fresh && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const repo = getReviewRepo(request.repoId);
  const notes: string[] = [];
  let raw = '';
  let pullRequest: CodeReviewPullRequest | undefined;
  const scope: ReviewScope = { type: request.type, repoId: repo.id };
  if (request.title) scope.title = request.title;

  switch (request.type) {
    case 'working-tree': {
      raw = await loadWorkingTreeDiff(repo.path);
      break;
    }
    case 'turn': {
      const all = await loadWorkingTreeDiff(repo.path);
      const edited = ctx.appThreadId ? listLatestTurnEditedFiles(ctx.appThreadId, repo.path) : [];
      if (edited.length === 0) {
        raw = all;
        notes.push(
          'No file edits were recorded for a recent turn in this thread, so this covers the whole working tree.',
        );
      } else {
        const wanted = new Set(edited);
        const parts = all.split(/^(?=diff --git )/m).filter((part) => {
          const parsed = parseUnifiedDiff(part)[0];
          return (
            parsed &&
            (wanted.has(parsed.path) || (parsed.previousPath && wanted.has(parsed.previousPath)))
          );
        });
        raw = parts.join('');
        const present = new Set(parseUnifiedDiff(raw).map((file) => file.path));
        const missing = edited.filter((path) => !present.has(path));
        if (missing.length > 0) {
          notes.push(
            `${missing.length} file(s) edited in the turn no longer differ from HEAD (committed or reverted): ${missing.slice(0, 8).join(', ')}`,
          );
        }
      }
      break;
    }
    case 'pull-request': {
      const pullRequestId = request.pullRequestId?.trim().replace(/^#/, '');
      if (!pullRequestId || !/^\d+$/.test(pullRequestId)) {
        throw new AgentToolError(
          'pull-request scope needs a numeric pullRequestId.',
          'invalid-params',
        );
      }
      try {
        const diff = await getPullRequestDiff({
          repoPath: repo.path,
          remoteUrl: repo.remoteUrl,
          pullRequestId,
        });
        pullRequest = diff.pullRequest;
        raw = diff.files
          .map((file) => (file.diff.endsWith('\n') ? file.diff : `${file.diff}\n`))
          .join('');
      } catch (error) {
        throw new AgentToolError(
          `Could not load pull request #${pullRequestId}: ${error instanceof Error ? error.message : String(error)}`,
          'unavailable',
        );
      }
      scope.pullRequestId = pullRequestId;
      scope.ref = pullRequest.sourceBranch;
      scope.title = request.title ?? pullRequest.title;
      break;
    }
    case 'commit-range': {
      const base = request.baseRef;
      const head = request.headRef;
      if (!base) {
        throw new AgentToolError(
          'commit-range scope needs baseRef (and optionally headRef).',
          'invalid-params',
        );
      }
      const baseRef = assertSafeRef(base, 'baseRef');
      const headRef = assertSafeRef(head || 'HEAD', 'headRef');
      const [resolvedBase, resolvedHead] = await Promise.all([
        resolveGitRef(repo.path, baseRef),
        resolveGitRef(repo.path, headRef),
      ]);
      if (!resolvedBase || !resolvedHead) {
        throw new AgentToolError(
          `Unknown ref: ${!resolvedBase ? baseRef : headRef}. Use a branch, tag or commit sha.`,
          'invalid-params',
        );
      }
      const files = await getCommitRangeDiff(repo.path, resolvedBase, resolvedHead);
      raw = files.map((file) => (file.diff.endsWith('\n') ? file.diff : `${file.diff}\n`)).join('');
      scope.ref = `${baseRef}..${headRef}`;
      break;
    }
  }

  const files = parseUnifiedDiff(raw).filter((file) => file.path);
  const loaded: LoadedReviewDiff = {
    scope,
    key: reviewSurfaceKey(scope),
    repo,
    files,
    rawByPath: splitRawByPath(raw, files),
    pullRequest,
    notes,
    loadedAt: Date.now(),
  };
  cache.set(cacheKey, loaded);
  return loaded;
}

/** Turns a published scope back into a load request. */
export function scopeToRequest(scope: ReviewScope): ReviewScopeRequest {
  return {
    type: scope.type,
    repoId: scope.repoId,
    pullRequestId: scope.pullRequestId,
    ref: scope.type === 'commit-range' ? scope.ref : undefined,
    title: scope.title,
  };
}
