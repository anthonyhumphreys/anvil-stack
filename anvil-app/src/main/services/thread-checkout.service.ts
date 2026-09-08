import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import simpleGit from 'simple-git';
import type {
  CheckoutOptions,
  ThreadCheckout,
  ThreadCheckoutInput,
  RepoInfo,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

const selectingThreads = new Set<string>();

type RepoRow = { id: string; name: string; path: string };
function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
type ThreadRow = {
  id: string;
  workspace_id: string | null;
  repo_ids_json: string;
  active_repo_id: string | null;
};

function repoRow(repoId: string): RepoRow {
  const repo = getDb().prepare('SELECT id, name, path FROM repos WHERE id = ?').get(repoId) as
    | RepoRow
    | undefined;
  if (!repo) throw new Error('Repository is no longer connected.');
  return repo;
}

export function getThreadCheckouts(threadId: string): ThreadCheckout[] {
  return getDb()
    .prepare(
      `SELECT repo_id AS repoId, source_repo_id AS sourceRepoId,
    path, branch, base_commit AS baseCommit, owned FROM thread_checkouts WHERE thread_id = ?`,
    )
    .all(threadId)
    .map((row) => {
      const checkout = row as Omit<ThreadCheckout, 'owned'> & { owned: number };
      return { ...checkout, owned: checkout.owned === 1 };
    });
}

export async function listCheckoutOptions(repoId: string): Promise<CheckoutOptions> {
  const repo = repoRow(repoId);
  const git = simpleGit(repo.path);
  const [porcelain, refs] = await Promise.all([
    git.raw(['worktree', 'list', '--porcelain', '-z']),
    git.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
  ]);
  const threads = getDb()
    .prepare(
      `SELECT id, title, repo_ids_json FROM chat_threads
    WHERE attention_state IN ('working', 'approval', 'input')`,
    )
    .all() as Array<{ id: string; title: string; repo_ids_json: string }>;
  const repos = getDb().prepare('SELECT id, path FROM repos').all() as RepoRow[];
  const checkouts: CheckoutOptions['checkouts'] = [];
  let current: CheckoutOptions['checkouts'][number] | undefined;
  for (const field of porcelain.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice(9), branch: null, activeThreads: [], locked: false };
      checkouts.push(current);
    } else if (current && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length);
    } else if (current && (field === 'locked' || field.startsWith('locked '))) {
      current.locked = true;
    }
  }
  for (const checkout of checkouts) {
    const ids = repos
      .filter((candidate) => canonicalPath(candidate.path) === canonicalPath(checkout.path))
      .map((candidate) => candidate.id);
    checkout.activeThreads = threads
      .filter((thread) => {
        const selected = JSON.parse(thread.repo_ids_json) as string[];
        return ids.some((id) => selected.includes(id));
      })
      .map(({ id, title }) => ({ id, title }));
  }
  return {
    currentPath: canonicalPath(repo.path),
    checkouts,
    branches: refs
      .trim()
      .split('\n')
      .filter((ref) => ref && !ref.endsWith('/HEAD')),
  };
}

export function assertCheckoutSelectionIdle(threadId: string): void {
  if (selectingThreads.has(threadId))
    throw new Error('Checkout setup is still running. Wait before starting this thread.');
}

export function assertThreadCheckoutMutable(threadId: string): void {
  const db = getDb();
  if (
    db.prepare(`SELECT 1 FROM chat_sessions WHERE thread_id = ? LIMIT 1`).get(threadId) ||
    db.prepare(`SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1`).get(threadId)
  ) {
    throw new Error(
      'This thread has already started. Start a new thread to choose another checkout.',
    );
  }
}

export async function selectThreadCheckout(input: ThreadCheckoutInput): Promise<RepoInfo> {
  if (
    !input ||
    typeof input.threadId !== 'string' ||
    typeof input.repoId !== 'string' ||
    !['existing', 'worktree'].includes(input.mode)
  )
    throw new Error('Invalid checkout selection.');
  assertCheckoutSelectionIdle(input.threadId);
  selectingThreads.add(input.threadId);
  let createdPath: string | undefined;
  try {
    assertThreadCheckoutMutable(input.threadId);
    const db = getDb();
    const thread = db
      .prepare(
        'SELECT id, workspace_id, repo_ids_json, active_repo_id FROM chat_threads WHERE id = ?',
      )
      .get(input.threadId) as ThreadRow | undefined;
    if (!thread) throw new Error('Thread no longer exists.');
    const repoIds = JSON.parse(thread.repo_ids_json) as string[];
    if (!repoIds.includes(input.repoId))
      throw new Error('Select a repository in this thread first.');
    const source = repoRow(input.repoId);
    const { addWorktree, getRepoMetadata } = await import('./git.service.js');
    const options = await listCheckoutOptions(input.repoId);
    let checkoutPath: string;
    let branch: string;
    let baseCommit: string;
    if (input.mode === 'worktree') {
      if (typeof input.branchName !== 'string' || !input.branchName.trim())
        throw new Error('Enter a new feature branch name.');
      if (typeof input.baseBranch !== 'string' || !options.branches.includes(input.baseBranch))
        throw new Error('Choose an available base branch.');
      branch = input.branchName.trim();
      const git = simpleGit(source.path);
      await git.raw(['check-ref-format', '--branch', branch]);
      baseCommit = (
        await git.raw(['rev-parse', '--verify', `${input.baseBranch}^{commit}`])
      ).trim();
      checkoutPath = path.join(
        app.getPath('userData'),
        'thread-worktrees',
        randomUUID(),
        source.id,
      );
      await addWorktree(source.path, checkoutPath, branch, baseCommit);
      createdPath = checkoutPath;
    } else {
      const selected = options.checkouts.find((checkout) => checkout.path === input.path);
      if (!selected?.branch) throw new Error('Choose an existing checkout with a branch.');
      checkoutPath = selected.path;
      branch = selected.branch;
      baseCommit = (await simpleGit(checkoutPath).revparse(['HEAD'])).trim();
    }
    checkoutPath = fs.realpathSync(checkoutPath);
    const metadata = await getRepoMetadata(checkoutPath);
    // Reuse existing repository IDs so all established repo-scoped controls target this checkout.
    const existing = (db.prepare('SELECT id, name, path FROM repos').all() as RepoRow[]).find(
      (candidate) => canonicalPath(candidate.path) === checkoutPath,
    );
    const repo: RepoInfo = {
      ...metadata,
      id: existing?.id ?? metadata.id,
      path: existing?.path ?? metadata.path,
      name: existing?.name ?? `${source.name} [${branch}]`,
      status: 'connected',
    };
    const priorBinding = getThreadCheckouts(input.threadId).find(
      (checkout) => checkout.repoId === repo.id && checkout.branch === branch,
    );
    db.transaction(() => {
      // Recheck after Git I/O: never rebind a thread that started while setup was pending.
      assertThreadCheckoutMutable(input.threadId);
      const latest = db
        .prepare('SELECT repo_ids_json FROM chat_threads WHERE id = ?')
        .get(input.threadId) as { repo_ids_json: string } | undefined;
      if (!latest || latest.repo_ids_json !== thread.repo_ids_json)
        throw new Error('Thread repositories changed during checkout setup. Try again.');
      db.prepare(
        `INSERT INTO repos (id, name, path, remote_url, default_branch, status, file_count, branch_count)
        VALUES (?, ?, ?, ?, ?, 'connected', ?, ?) ON CONFLICT(id) DO NOTHING`,
      ).run(
        repo.id,
        repo.name,
        repo.path,
        repo.remoteUrl ?? null,
        branch,
        repo.fileCount,
        repo.branchCount,
      );
      if (thread.workspace_id)
        db.prepare(
          'INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id, added_at) VALUES (?, ?, ?)',
        ).run(thread.workspace_id, repo.id, new Date().toISOString());
      db.prepare('DELETE FROM thread_checkouts WHERE thread_id = ? AND repo_id = ?').run(
        input.threadId,
        input.repoId,
      );
      db.prepare(
        `INSERT OR REPLACE INTO thread_checkouts (thread_id, repo_id, source_repo_id, path, branch, base_commit, owned)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.threadId,
        repo.id,
        priorBinding?.sourceRepoId ?? source.id,
        repo.path,
        branch,
        baseCommit,
        input.mode === 'worktree' || priorBinding?.owned ? 1 : 0,
      );
      const nextIds = [...new Set(repoIds.map((id) => (id === input.repoId ? repo.id : id)))];
      db.prepare(
        'UPDATE chat_threads SET repo_ids_json = ?, active_repo_id = ?, updated_at = ? WHERE id = ?',
      ).run(
        JSON.stringify(nextIds),
        thread.active_repo_id === input.repoId ? repo.id : thread.active_repo_id,
        new Date().toISOString(),
        input.threadId,
      );
    })();
    return repo;
  } catch (error) {
    if (createdPath)
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Worktree retained at ${createdPath}; no files were removed.`,
      );
    throw error;
  } finally {
    selectingThreads.delete(input.threadId);
  }
}

export async function validateThreadCheckouts(threadId: string, repoIds?: string[]): Promise<void> {
  assertCheckoutSelectionIdle(threadId);
  const db = getDb();
  const thread = db.prepare('SELECT repo_ids_json FROM chat_threads WHERE id = ?').get(threadId) as
    | { repo_ids_json: string }
    | undefined;
  if (!thread) throw new Error('Thread no longer exists.');
  const selectedIds = JSON.parse(thread.repo_ids_json) as string[];
  if (
    repoIds &&
    (repoIds.length !== selectedIds.length ||
      repoIds.some((id, index) => id !== selectedIds[index]))
  ) {
    throw new Error('Thread repositories changed. Reopen the thread before continuing.');
  }
  const bindings = getThreadCheckouts(threadId);
  for (const id of selectedIds) {
    if (bindings.some((binding) => binding.repoId === id)) continue;
    const repo = repoRow(id);
    const git = simpleGit(repo.path);
    const branch = (await git.raw(['branch', '--show-current'])).trim();
    const baseCommit = (await git.revparse(['HEAD'])).trim();
    db.prepare(
      `INSERT OR IGNORE INTO thread_checkouts (thread_id, repo_id, source_repo_id, path, branch, base_commit, owned)
      VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(threadId, id, id, repo.path, branch, baseCommit);
    bindings.push({
      repoId: id,
      sourceRepoId: id,
      path: repo.path,
      branch,
      baseCommit,
      owned: false,
    });
  }
  for (const checkout of bindings) {
    if (repoIds && !repoIds.includes(checkout.repoId))
      throw new Error('Thread checkout selection changed. Reopen the thread before continuing.');
    const repo = repoRow(checkout.repoId);
    if (repo.path !== checkout.path || !fs.existsSync(path.join(checkout.path, '.git'))) {
      throw new Error(
        `Thread checkout is missing at ${checkout.path}. Restore it or start a new thread.`,
      );
    }
    const branch = (await simpleGit(checkout.path).raw(['branch', '--show-current'])).trim();
    if (branch !== checkout.branch)
      throw new Error(
        `Thread expected ${checkout.branch} at ${checkout.path}, but found ${branch || 'a detached HEAD'}. Restore the branch or start a new thread.`,
      );
  }
}

export function copyThreadCheckouts(sourceThreadId: string, targetThreadId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO thread_checkouts (thread_id, repo_id, source_repo_id, path, branch, base_commit, owned)
    SELECT ?, repo_id, source_repo_id, path, branch, base_commit, 0 FROM thread_checkouts WHERE thread_id = ?`,
    )
    .run(targetThreadId, sourceThreadId);
}
