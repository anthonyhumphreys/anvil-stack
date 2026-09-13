import { presentPullRequestError } from '../../utils/pull-request-error';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Link2, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import type {
  ChatThread,
  ChatThreadPullRequestLink,
  CodeReviewPullRequest,
} from '../../../shared/types';
import { useChatContext } from '../../contexts/ChatContext';

const button =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
export function PullRequestThreads({
  workspaceId,
  repoId,
  pullRequest,
}: {
  workspaceId: string;
  repoId: string;
  pullRequest: Pick<CodeReviewPullRequest, 'id' | 'provider'> & Partial<CodeReviewPullRequest>;
}) {
  const navigate = useNavigate();
  const { launchPreparedChat } = useChatContext();
  const [links, setLinks] = useState<ChatThreadPullRequestLink[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadId, setThreadId] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setLinks([]);
    if (!window.anvil.chat.listPullRequestThreads) {
      setLoadError('Thread linking is unavailable in this app session.');
      setLoading(false);
      return;
    }
    void window.anvil.chat
      .listPullRequestThreads(repoId, pullRequest.provider, pullRequest.id)
      .then((value) => {
        if (!cancelled) setLinks(value.filter((link) => link.workspaceId === workspaceId));
      })
      .catch((reason) => {
        if (!cancelled) setLoadError(presentPullRequestError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, pullRequest.provider, pullRequest.id, workspaceId, revision]);
  useEffect(() => {
    if (!choosing) return;
    let cancelled = false;
    setLoadingThreads(true);
    setError('');
    setThreads([]);
    void Promise.all([
      window.anvil.chat.listThreads(workspaceId),
      window.anvil.chat.listWorkItemThreads(workspaceId),
    ])
      .then(([classic, workitems]) => {
        if (!cancelled)
          setThreads(
            [...classic, ...workitems].filter(
              (thread) => thread.workspaceId === workspaceId && thread.repoIds?.includes(repoId),
            ),
          );
      })
      .catch((reason) => {
        if (!cancelled) setError(presentPullRequestError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingThreads(false);
      });
    return () => {
      cancelled = true;
    };
  }, [choosing, workspaceId, repoId]);
  async function mutate(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      setRevision((value) => value + 1);
      setThreadId('');
    } catch (reason) {
      setError(presentPullRequestError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    const context = links[0]?.pullRequest ?? pullRequest;
    await mutate(async () => {
      const id = await launchPreparedChat({
        personaId: 'coder',
        repoIds: [repoId],
        threadTitle: `PR #${pullRequest.id}${context.title ? `: ${context.title}` : ''}`,
        pullRequest: { repoId, provider: pullRequest.provider, pullRequestId: pullRequest.id },
        message: `Help me review and continue work on PR #${pullRequest.id}${context.title ? `: ${context.title}` : ''}.\n${context.url ?? ''}\n${context.sourceBranch ? `Source branch: ${context.sourceBranch}; target branch: ${context.targetBranch}.` : ''}\nInspect the current source and evidence before proposing changes.`,
      });
      if (!id)
        throw new Error(
          'The linked chat could not start. Refresh linked threads to resume any saved draft.',
        );
      navigate(`/chat?${new URLSearchParams({ thread: id })}`);
    });
  }
  return (
    <section
      className="space-y-3 border-b border-border-subtle p-4"
      aria-label="Pull request threads"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Linked threads</h3>
        <button
          className={button}
          aria-label="Refresh linked threads"
          disabled={loading || busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {loadError ? (
        <p role="alert" className="text-xs leading-5 text-warning">
          {loadError}
        </p>
      ) : loading ? (
        <p role="status" className="text-xs text-text-secondary">
          Loading linked conversations…
        </p>
      ) : links.length ? (
        <ul className="space-y-2">
          {links.map((link) => (
            <li key={link.id}>
              <Link
                to={`/chat?${new URLSearchParams({ thread: link.threadId })}`}
                className="flex items-start gap-2 rounded-sm text-xs leading-5 text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <MessageSquare size={13} className="mt-1 shrink-0" />
                <span className="min-w-0 line-clamp-2" title={link.threadTitle}>
                  {link.threadTitle}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-5 text-text-secondary">
          Keep investigation and implementation conversations attached to this PR.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs leading-5 text-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={busy || !!loadError}
          onClick={() => setChoosing((value) => !value)}
          aria-expanded={choosing}
        >
          <Link2 size={13} />
          Link existing thread
        </button>
        <button className={button} disabled={busy || !!loadError} onClick={() => void start()}>
          <Plus size={13} />
          Start linked chat
        </button>
      </div>
      {choosing ? (
        <div className="space-y-2">
          <label className="block space-y-1 text-xs text-text-secondary">
            Workspace thread
            <select
              className="w-full min-w-0 rounded-md border border-border bg-bg-primary px-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-accent"
              value={threadId}
              disabled={loadingThreads || busy}
              onChange={(event) => setThreadId(event.target.value)}
            >
              <option value="">{loadingThreads ? 'Loading threads…' : 'Choose a thread'}</option>
              {threads
                .filter((thread) => !links.some((link) => link.threadId === thread.id))
                .map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                    {thread.workItemId ? ` · ${thread.workItemTitle ?? 'Work Item'}` : ''}
                    {thread.settledAt ? ' · Archived' : ''}
                  </option>
                ))}
            </select>
          </label>
          <button
            className={button}
            disabled={busy || !threadId}
            onClick={() =>
              void mutate(() =>
                window.anvil.chat.linkPullRequest(threadId, {
                  repoId,
                  provider: pullRequest.provider,
                  pullRequestId: pullRequest.id,
                }),
              )
            }
          >
            Link thread
          </button>
        </div>
      ) : null}
    </section>
  );
}
