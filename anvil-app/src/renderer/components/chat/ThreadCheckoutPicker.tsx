import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import type {
  CheckoutOptions,
  RepoInfo,
  ThreadCheckout,
  ThreadCheckoutInput,
} from '../../../shared/types';

type Props = {
  repos: RepoInfo[];
  checkouts: ThreadCheckout[];
  disabled: boolean;
  onChoose: (input: Omit<ThreadCheckoutInput, 'threadId'>) => Promise<void>;
};

export function ThreadCheckoutPicker({ repos, checkouts, disabled, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GitBranch size={14} aria-hidden="true" /> Checkouts
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[60vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-bg-secondary p-3">
          <p className="mb-3 text-sm font-medium text-text-primary">Thread checkouts</p>
          {repos.length === 0 && (
            <p className="text-xs text-text-secondary">Select a repository first.</p>
          )}
          {repos.map((repo) => (
            <CheckoutRow
              key={repo.id}
              repo={repo}
              binding={checkouts.find((checkout) => checkout.repoId === repo.id)}
              disabled={disabled}
              onChoose={onChoose}
            />
          ))}
          <p className="mt-3 text-xs text-text-tertiary">
            {disabled
              ? 'Start a new thread to choose a different checkout.'
              : 'Shared checkouts include uncommitted edits. Use Plan mode for reviews. New worktrees start from committed changes only.'}
          </p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-3 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-elevated focus-visible:outline-2 focus-visible:outline-accent"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}

function CheckoutRow({
  repo,
  binding,
  disabled,
  onChoose,
}: {
  repo: RepoInfo;
  binding?: ThreadCheckout;
  disabled: boolean;
  onChoose: Props['onChoose'];
}) {
  const [options, setOptions] = useState<CheckoutOptions | null>(null);
  const [mode, setMode] = useState<'existing' | 'worktree'>('existing');
  const [selectedPath, setSelectedPath] = useState(repo.path);
  const [branchName, setBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    window.anvil.chat
      .checkoutOptions(repo.id)
      .then((result) => {
        if (!cancelled) {
          setOptions(result);
          setError(null);
          const current = result.checkouts.find((checkout) => checkout.path === result.currentPath);
          setSelectedPath(current?.path ?? '');
          setBaseBranch(
            result.branches.includes('main')
              ? 'main'
              : result.branches.includes('origin/main')
                ? 'origin/main'
                : (current?.branch ?? ''),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [repo.id, repo.path, reload]);
  const current = options?.checkouts.find((checkout) => checkout.path === options.currentPath);
  const selection = options?.checkouts.find((checkout) => checkout.path === selectedPath);
  const fieldClass =
    'mt-1 w-full rounded-md border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
  async function apply() {
    setSaving(true);
    setError(null);
    try {
      await onChoose({ repoId: repo.id, mode, path: selectedPath, branchName, baseBranch });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="mb-3 space-y-2 border-b border-border pb-3 last:mb-0">
      <p className="break-words text-xs font-medium text-text-primary">{repo.name}</p>
      <p className="text-xs text-text-secondary">
        {current ? (current.branch ?? 'Detached HEAD') : binding?.branch || 'Loading branch…'}
        {binding?.owned ? ' · Created for this thread' : ' · Shared checkout'}
      </p>
      <p className="break-all font-mono text-xs text-text-tertiary">{repo.path}</p>
      {current && current.activeThreads.length > 0 && (
        <p className="text-xs text-warning">
          Active threads: {current.activeThreads.map((thread) => thread.title).join(', ')}
        </p>
      )}
      {!disabled && options && (
        <>
          <label className="block text-xs text-text-secondary">
            Checkout choice
            <select
              className={fieldClass}
              value={mode}
              disabled={saving}
              onChange={(event) => setMode(event.target.value as 'existing' | 'worktree')}
            >
              <option value="existing">Use existing checkout</option>
              <option value="worktree">Create isolated worktree</option>
            </select>
          </label>
          {mode === 'existing' ? (
            <>
              <label className="block text-xs text-text-secondary">
                Existing checkout
                <select
                  className={fieldClass}
                  value={selectedPath}
                  disabled={saving}
                  onChange={(event) => setSelectedPath(event.target.value)}
                >
                  <option value="" disabled>
                    Choose a checkout
                  </option>
                  {options.checkouts.map((checkout) => (
                    <option key={checkout.path} value={checkout.path} disabled={!checkout.branch}>
                      {checkout.branch ?? 'Detached HEAD'} · {checkout.path}
                    </option>
                  ))}
                </select>
              </label>
              {selection && selection.activeThreads.length > 0 && selection.path !== repo.path && (
                <p className="text-xs text-warning">
                  Sharing with {selection.activeThreads.map((thread) => thread.title).join(', ')}.
                </p>
              )}
            </>
          ) : (
            <>
              <label className="block text-xs text-text-secondary">
                Base branch
                <select
                  className={fieldClass}
                  value={baseBranch}
                  disabled={saving}
                  onChange={(event) => setBaseBranch(event.target.value)}
                >
                  <option value="" disabled>
                    Choose a base branch
                  </option>
                  {options.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-text-secondary">
                New feature branch
                <input
                  className={fieldClass}
                  value={branchName}
                  disabled={saving}
                  placeholder="feature/issue--description"
                  onChange={(event) => setBranchName(event.target.value)}
                />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={() => void apply()}
            disabled={
              saving || (mode === 'worktree' ? !branchName.trim() || !baseBranch : !selectedPath)
            }
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {saving
              ? 'Preparing checkout…'
              : mode === 'worktree'
                ? 'Create worktree'
                : 'Use checkout'}
          </button>
        </>
      )}
      {!options && !error && (
        <p role="status" className="text-xs text-text-tertiary">
          Loading checkouts…
        </p>
      )}
      {error && (
        <div role="alert" className="text-xs text-error">
          <p className="break-words">{error}</p>
          <button
            type="button"
            className="mt-1 underline"
            onClick={() => setReload((value) => value + 1)}
          >
            Refresh checkouts
          </button>
        </div>
      )}
    </section>
  );
}
