import { presentPullRequestError } from '../../utils/pull-request-error';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, GitPullRequest, Link2, RefreshCw, X } from 'lucide-react';
import type { ChatThreadPullRequestLink, CodeReviewPullRequest } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const button =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const field =
  'w-full min-w-0 rounded-md border border-border bg-bg-primary px-2 py-2 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent';

export function ThreadPullRequests({
  threadId,
  preferredRepoId,
  repoIds,
}: {
  threadId: string;
  preferredRepoId?: string;
  repoIds: string[];
}) {
  const { activeWorkspace } = useWorkspace();
  const scopedRepos = activeWorkspace?.repos.filter((repo) => repoIds.includes(repo.id)) ?? [];
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ChatThreadPullRequestLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [repoId, setRepoId] = useState(preferredRepoId ?? scopedRepos[0]?.id ?? '');
  const [pullRequests, setPullRequests] = useState<CodeReviewPullRequest[]>([]);
  const [prId, setPrId] = useState('');
  const [loadingPrs, setLoadingPrs] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    if (!window.anvil.chat.listPullRequestLinks) {
      setLoadError('PR linking is unavailable in this app session.');
      setLoading(false);
      return;
    }
    void window.anvil.chat
      .listPullRequestLinks(threadId)
      .then((value) => {
        if (!cancelled) setLinks(value);
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
  }, [threadId, revision]);
  useEffect(() => {
    if (!open || !repoId) return;
    let cancelled = false;
    setLoadingPrs(true);
    setPullRequests([]);
    setPrId('');
    setError('');
    void window.anvil.codereview
      .listPullRequests(repoId)
      .then((value) => {
        if (!cancelled) setPullRequests(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(presentPullRequestError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoadingPrs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoId]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);
  async function mutate(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await task();
      setRevision((value) => value + 1);
      setPrId('');
    } catch (reason) {
      setError(presentPullRequestError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function refreshStatus() {
    if (!links.length) {
      setRevision((value) => value + 1);
      return;
    }
    setBusy(true);
    setError('');
    const outcomes = await Promise.allSettled(
      links.map((link) => window.anvil.chat.refreshPullRequestLink(threadId, link.id)),
    );
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    setLinks((current) =>
      current.map((link) => {
        const refreshed = outcomes.find(
          (outcome) => outcome.status === 'fulfilled' && outcome.value.id === link.id,
        );
        return refreshed?.status === 'fulfilled' ? refreshed.value : link;
      }),
    );
    if (failures.length)
      setError(
        'Some PR statuses could not be refreshed. Their last observed status is still shown.',
      );
    setBusy(false);
  }
  const selected = pullRequests.find((pr) => pr.id === prId);
  return (
    <div
      ref={container}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          container.current?.querySelector('button')?.focus();
        }
      }}
    >
      <button
        className={button}
        aria-expanded={open}
        aria-controls={`thread-pr-${threadId}`}
        onClick={() => setOpen((value) => !value)}
        title="Link this thread to a pull request"
      >
        <GitPullRequest size={13} />
        <span>
          {loading
            ? 'PRs…'
            : loadError
              ? 'PRs unavailable'
              : links.length === 1
                ? `PR #${links[0].pullRequest.id} · ${links[0].availability !== 'current' ? 'Unavailable' : links[0].pullRequest.isDraft ? 'Draft' : links[0].pullRequest.state}`
                : links.length
                  ? `${links.length} PRs`
                  : 'Link PR'}
        </span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <section
          id={`thread-pr-${threadId}`}
          aria-label="Thread pull requests"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] space-y-4 rounded-lg border border-border bg-bg-secondary p-4 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text-primary">Linked pull requests</h3>
            <button
              className={button}
              aria-label="Refresh linked pull requests"
              disabled={loading || busy}
              onClick={() => void refreshStatus()}
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
              Loading PR links…
            </p>
          ) : links.length ? (
            <ul className="divide-y divide-border-subtle">
              {links.map((link) => (
                <li key={link.id} className="space-y-1 py-2 first:pt-0">
                  <div className="flex items-start gap-2">
                    {link.availability !== 'current' ? (
                      <span className="min-w-0 flex-1 text-xs leading-5 text-text-secondary">
                        #{link.pullRequest.id} · {link.pullRequest.title}
                      </span>
                    ) : (
                      <Link
                        className="min-w-0 flex-1 rounded-sm text-xs font-medium leading-5 text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                        to={`/codereview/${encodeURIComponent(link.repoId)}?${new URLSearchParams({ pr: link.pullRequest.id, view: 'diff', provider: link.pullRequest.provider })}`}
                        title={link.pullRequest.title}
                      >
                        #{link.pullRequest.id} · {link.pullRequest.title}
                      </Link>
                    )}
                    <button
                      className={button}
                      aria-label={`Unlink PR #${link.pullRequest.id}`}
                      disabled={busy}
                      onClick={() =>
                        void mutate(() => window.anvil.chat.unlinkPullRequest(threadId, link.id))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {link.availability !== 'current' ? (
                    <p className="text-xs leading-5 text-warning">
                      Link unavailable ·{' '}
                      {link.availability === 'repository_changed'
                        ? 'repository identity changed'
                        : 'thread repository changed'}
                      . Unlink it to remove the saved association.
                    </p>
                  ) : null}
                  <p className="text-xs text-text-secondary">
                    {link.pullRequest.isDraft ? 'Draft' : link.pullRequest.state} ·{' '}
                    {link.pullRequest.sourceBranch}
                  </p>
                  <p className="text-xs text-text-tertiary">
                    Observed {new Date(link.observedAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs leading-5 text-text-secondary">
              Keep the PR and its working conversation connected.
            </p>
          )}
          <div className="space-y-3 border-t border-border-subtle pt-3">
            {!scopedRepos.length ? (
              <p className="text-xs leading-5 text-text-secondary">
                Add a repository to this thread before linking a pull request.
              </p>
            ) : null}
            <label className="block space-y-1 text-xs text-text-secondary">
              Repository
              <select
                className={field}
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
              >
                {scopedRepos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-xs text-text-secondary">
              Pull request
              <select
                className={field}
                value={prId}
                onChange={(event) => setPrId(event.target.value)}
                disabled={loadingPrs || !repoId}
              >
                <option value="">
                  {loadingPrs ? 'Loading pull requests…' : 'Choose a pull request'}
                </option>
                {pullRequests.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    #{pr.id} · {pr.title}
                  </option>
                ))}
              </select>
            </label>
            {!loadingPrs && !error && !pullRequests.length && repoId ? (
              <p className="text-xs text-text-tertiary">
                No pull requests available for this repository.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs leading-5 text-error">
                {error}
              </p>
            ) : null}
            <button
              className={button}
              disabled={busy || !selected || !!loadError}
              onClick={() =>
                selected &&
                void mutate(() =>
                  window.anvil.chat.linkPullRequest(threadId, {
                    repoId,
                    provider: selected.provider,
                    pullRequestId: selected.id,
                  }),
                )
              }
            >
              <Link2 size={13} />
              {busy ? 'Saving…' : 'Link pull request'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
