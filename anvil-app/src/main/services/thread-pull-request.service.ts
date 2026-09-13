import { randomUUID } from 'node:crypto';
import type { AnvilAPI } from '../../shared/ipc-api.js';
import type {
  ChatThread,
  ChatThreadPullRequestInput,
  ChatThreadPullRequestLink,
  CodeReviewPullRequest,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface LinkRow {
  thread_workspace_id: string | null;
  thread_repo_ids_json: string;
  current_remote_url: string | null;
  workspace_repo_id: string | null;
  id: string;
  thread_id: string;
  thread_title: string;
  workspace_id: string;
  repo_id: string;
  provider: 'github' | 'ado';
  pull_request_id: string;
  remote_url: string;
  pull_request_json: string;
  linked_at: string;
  observed_at: string;
}
const SELECT_LINKS =
  'SELECT l.*, t.title AS thread_title, t.workspace_id AS thread_workspace_id, t.repo_ids_json AS thread_repo_ids_json, r.remote_url AS current_remote_url, wr.repo_id AS workspace_repo_id FROM chat_thread_pull_requests l JOIN chat_threads t ON t.id = l.thread_id JOIN repos r ON r.id = l.repo_id LEFT JOIN workspace_repos wr ON wr.repo_id = l.repo_id AND wr.workspace_id = t.workspace_id';
function mapLink(row: LinkRow): ChatThreadPullRequestLink {
  const currentMembership =
    row.thread_workspace_id === row.workspace_id &&
    Boolean(row.workspace_repo_id) &&
    (JSON.parse(row.thread_repo_ids_json) as string[]).includes(row.repo_id);
  return {
    availability: !currentMembership
      ? 'thread_changed'
      : row.current_remote_url !== row.remote_url
        ? 'repository_changed'
        : 'current',
    id: row.id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    workspaceId: row.thread_workspace_id ?? row.workspace_id,
    repoId: row.repo_id,
    pullRequest: JSON.parse(row.pull_request_json) as CodeReviewPullRequest,
    linkedAt: row.linked_at,
    observedAt: row.observed_at,
  };
}
function validateInput(input: ChatThreadPullRequestInput): ChatThreadPullRequestInput {
  if (
    !input ||
    typeof input.repoId !== 'string' ||
    !input.repoId ||
    !['github', 'ado'].includes(input.provider) ||
    typeof input.pullRequestId !== 'string' ||
    !/^[1-9]\d*$/.test(input.pullRequestId)
  )
    throw new Error('Choose a repository, provider and numeric pull request ID.');
  return input;
}
function repoForThread(
  workspaceId: string | null | undefined,
  repoIds: string[],
  repoId: string,
): { remote_url: string } {
  if (!workspaceId || !repoIds.includes(repoId))
    throw new Error('The pull request repository must belong to this thread and workspace.');
  const repo = getDb()
    .prepare(
      'SELECT r.remote_url FROM repos r JOIN workspace_repos wr ON wr.repo_id = r.id WHERE r.id = ? AND wr.workspace_id = ?',
    )
    .get(repoId, workspaceId) as { remote_url: string | null } | undefined;
  if (!repo?.remote_url)
    throw new Error('The thread repository needs a linked workspace and remote.');
  return { remote_url: repo.remote_url };
}
function threadContext(threadId: string): { workspaceId: string; repoIds: string[] } {
  const thread = getDb()
    .prepare('SELECT workspace_id, repo_ids_json FROM chat_threads WHERE id = ?')
    .get(threadId) as { workspace_id: string | null; repo_ids_json: string } | undefined;
  if (!thread?.workspace_id) throw new Error('Thread not found in a workspace.');
  return {
    workspaceId: thread.workspace_id,
    repoIds: JSON.parse(thread.repo_ids_json) as string[],
  };
}
async function observe(
  remoteUrl: string,
  input: ChatThreadPullRequestInput,
): Promise<CodeReviewPullRequest> {
  const { getPullRequestMetadata } = await import('./code-review-pr.service.js');
  const pullRequest = await getPullRequestMetadata(remoteUrl, input.pullRequestId);
  if (pullRequest.provider !== input.provider || pullRequest.id !== input.pullRequestId)
    throw new Error('Pull request identity does not match the repository provider.');
  return pullRequest;
}
function persistLink(
  threadId: string,
  input: ChatThreadPullRequestInput,
  remoteUrl: string,
  pullRequest: CodeReviewPullRequest,
): ChatThreadPullRequestLink {
  const thread = threadContext(threadId);
  if (repoForThread(thread.workspaceId, thread.repoIds, input.repoId).remote_url !== remoteUrl)
    throw new Error('Repository remote changed while linking. Try again.');
  const observedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO chat_thread_pull_requests(id,thread_id,workspace_id,repo_id,provider,pull_request_id,remote_url,pull_request_json,linked_at,observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,repo_id,provider,pull_request_id) DO UPDATE SET pull_request_json = excluded.pull_request_json, observed_at = excluded.observed_at, remote_url = excluded.remote_url`,
    )
    .run(
      randomUUID(),
      threadId,
      thread.workspaceId,
      input.repoId,
      input.provider,
      input.pullRequestId,
      remoteUrl,
      JSON.stringify(pullRequest),
      observedAt,
      observedAt,
    );
  return mapLink(
    getDb()
      .prepare(
        `${SELECT_LINKS} WHERE l.thread_id = ? AND l.repo_id = ? AND l.provider = ? AND l.pull_request_id = ?`,
      )
      .get(threadId, input.repoId, input.provider, input.pullRequestId) as LinkRow,
  );
}
export async function linkThreadPullRequest(
  threadId: string,
  input: ChatThreadPullRequestInput,
): Promise<ChatThreadPullRequestLink> {
  validateInput(input);
  const thread = threadContext(threadId);
  const { remote_url } = repoForThread(thread.workspaceId, thread.repoIds, input.repoId);
  const pullRequest = await observe(remote_url, input);
  const latestThread = threadContext(threadId);
  if (latestThread.workspaceId !== thread.workspaceId)
    throw new Error('Thread workspace changed while linking. Try again.');
  return persistLink(threadId, input, remote_url, pullRequest);
}
export function listThreadPullRequestLinks(threadId: string): ChatThreadPullRequestLink[] {
  return (
    getDb()
      .prepare(`${SELECT_LINKS} WHERE l.thread_id = ? ORDER BY l.linked_at DESC`)
      .all(threadId) as LinkRow[]
  ).map(mapLink);
}
export function listPullRequestThreads(
  repoId: string,
  provider: 'github' | 'ado',
  pullRequestId: string,
): ChatThreadPullRequestLink[] {
  validateInput({ repoId, provider, pullRequestId });
  return (
    getDb()
      .prepare(
        `${SELECT_LINKS} WHERE l.repo_id = ? AND l.provider = ? AND l.pull_request_id = ? ORDER BY l.linked_at DESC`,
      )
      .all(repoId, provider, pullRequestId) as LinkRow[]
  )
    .map(mapLink)
    .filter((link) => link.availability === 'current');
}
export function unlinkThreadPullRequest(threadId: string, linkId: string): void {
  getDb()
    .prepare('DELETE FROM chat_thread_pull_requests WHERE id = ? AND thread_id = ?')
    .run(linkId, threadId);
}
export async function refreshThreadPullRequest(
  threadId: string,
  linkId: string,
): Promise<ChatThreadPullRequestLink> {
  const link = getDb()
    .prepare(`${SELECT_LINKS} WHERE l.id = ? AND l.thread_id = ?`)
    .get(linkId, threadId) as LinkRow | undefined;
  if (!link) throw new Error('Thread pull request link not found.');
  const thread = threadContext(threadId);
  if (
    repoForThread(thread.workspaceId, thread.repoIds, link.repo_id).remote_url !== link.remote_url
  )
    throw new Error('Repository remote changed. Unlink and choose the pull request again.');
  const input = {
    repoId: link.repo_id,
    provider: link.provider,
    pullRequestId: link.pull_request_id,
  };
  const pullRequest = await observe(link.remote_url, input);
  // An unlink during the provider request must stay unlinked.
  if (
    !getDb()
      .prepare('SELECT id FROM chat_thread_pull_requests WHERE id = ? AND thread_id = ?')
      .get(linkId, threadId)
  )
    throw new Error('The pull request was unlinked while refreshing.');
  if (threadContext(threadId).workspaceId !== thread.workspaceId)
    throw new Error('Thread workspace changed while refreshing. Try again.');
  return persistLink(threadId, input, link.remote_url, pullRequest);
}
export async function createThreadWithPullRequest(
  input: Parameters<AnvilAPI['chat']['createThread']>[0],
): Promise<ChatThread> {
  const { createChatThread } = await import('./chat-persistence.service.js');
  if (!input.pullRequest) return createChatThread(input);
  validateInput(input.pullRequest);
  const { remote_url } = repoForThread(
    input.workspaceId,
    input.repoIds ?? [],
    input.pullRequest.repoId,
  );
  const pullRequest = await observe(remote_url, input.pullRequest);
  return getDb().transaction(() => {
    // Revalidate membership and remote after the asynchronous provider lookup.
    if (
      repoForThread(input.workspaceId, input.repoIds ?? [], input.pullRequest!.repoId)
        .remote_url !== remote_url
    )
      throw new Error('Repository remote changed while linking. Try again.');
    const thread = createChatThread(input);
    const link = persistLink(thread.id, input.pullRequest!, remote_url, pullRequest);
    return { ...thread, pullRequestLinks: [link] };
  })();
}
