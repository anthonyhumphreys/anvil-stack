import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Undo2 } from 'lucide-react';
import type { RepoInfo } from '../../../../shared/types';
import { Button, ConfirmDialog, PromptDialog } from '../../ui';
import {
  planTurnUndo,
  repoRelativePath,
  type TurnChangeSummary,
  type TurnUndoEligibility,
} from '../chat-turn-changes';
import { loadTurnUndoEligibility } from './turn-undo';

type ActionBusy = 'commit' | 'pr' | 'undo' | 'undo-check' | null;

interface ActionResult {
  kind: 'success' | 'error';
  text: string;
  url?: string;
}

const DIALOG_FILE_LIMIT = 12;

/** Dialog descriptions render inside a `<p>`, so the list is built from spans. */
function FileListPreview({ paths }: { paths: readonly string[] }) {
  const shown = paths.slice(0, DIALOG_FILE_LIMIT);
  return (
    <span
      role="list"
      className="mt-2 block max-h-48 space-y-0.5 overflow-auto rounded-md border border-border-subtle bg-bg-secondary/40 px-2.5 py-2 font-mono text-xs text-text-secondary"
    >
      {shown.map((path) => (
        <span role="listitem" key={path} className="block break-all">
          {path}
        </span>
      ))}
      {paths.length > shown.length && (
        <span role="listitem" className="block font-sans text-text-tertiary">
          …and {paths.length - shown.length} more
        </span>
      )}
    </span>
  );
}

export interface TurnChangesActionsProps {
  summary: TurnChangeSummary;
  repo: RepoInfo | null;
  /** Thread access is read-only: mutations (Undo, Commit, Open PR) are hidden. */
  readOnly: boolean;
  /** Files later turns in this thread edited; blocks Undo for overlapping files. */
  laterTurnEditedPaths?: readonly string[];
  /** Run the (read-only) undo eligibility check — set once the panel is open. */
  checkUndo: boolean;
  onOpenInChanges?: () => void;
}

/**
 * Turn-level actions under the expanded file list. Every mutation is an
 * explicit click plus a confirm dialog that names exactly what will change.
 */
export function TurnChangesActions({
  summary,
  repo,
  readOnly,
  laterTurnEditedPaths,
  checkUndo,
  onOpenInChanges,
}: TurnChangesActionsProps) {
  const undoReasonId = useId();
  const [busy, setBusy] = useState<ActionBusy>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [otherStaged, setOtherStaged] = useState<string[]>([]);
  const [prOpen, setPrOpen] = useState(false);
  const [prContext, setPrContext] = useState<{ branch: string; fileCount: number } | null>(null);
  const [undoEligibility, setUndoEligibility] = useState<TurnUndoEligibility | null>(null);
  const [undoConfirmPaths, setUndoConfirmPaths] = useState<string[] | null>(null);
  const [undone, setUndone] = useState(false);
  const checkSequence = useRef(0);

  const repoId = repo?.id ?? null;
  const turnPaths = useMemo(
    () =>
      repo
        ? summary.files
            .map((file) => repoRelativePath(file.filePath, repo.path))
            .filter((path): path is string => Boolean(path))
        : [],
    [repo, summary.files],
  );
  // Callers may pass a fresh array each render; key the plan on its contents.
  const laterKey = laterTurnEditedPaths ? laterTurnEditedPaths.join('\n') : null;
  const undoPlan = useMemo(
    () =>
      planTurnUndo(
        summary.files,
        repo?.path,
        laterKey === null ? undefined : laterKey.split('\n').filter(Boolean),
      ),
    [laterKey, repo?.path, summary.files],
  );

  const refreshUndo = useCallback(async (): Promise<TurnUndoEligibility> => {
    const sequence = ++checkSequence.current;
    const eligibility = repoId
      ? await loadTurnUndoEligibility(window.anvil.git, repoId, undoPlan)
      : ({ eligible: false, reason: 'No repository is attached to these changes.' } as const);
    if (sequence === checkSequence.current) setUndoEligibility(eligibility);
    return eligibility;
  }, [repoId, undoPlan]);

  useEffect(() => {
    if (!checkUndo || readOnly || undone) return;
    void refreshUndo();
  }, [checkUndo, readOnly, refreshUndo, undone]);

  if (readOnly) {
    return onOpenInChanges ? (
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onOpenInChanges}>
          Open in Changes
        </Button>
        <span className="text-xs text-text-tertiary">
          Read only thread — undo, commit and pull requests are hidden.
        </span>
      </div>
    ) : null;
  }

  const noRepo = (): boolean => {
    if (repoId) return false;
    setResult({ kind: 'error', text: 'No repository is attached to these changes.' });
    return true;
  };

  // --- Undo -----------------------------------------------------------------

  const requestUndo = async () => {
    if (noRepo()) return;
    setResult(null);
    setBusy('undo-check');
    const eligibility = await refreshUndo();
    setBusy(null);
    if (eligibility.eligible) setUndoConfirmPaths(eligibility.paths);
  };

  const confirmUndo = async () => {
    const expected = undoConfirmPaths;
    if (!repoId || !expected) return;
    setBusy('undo');
    try {
      // Re-check: anything that changed since the dialog opened still blocks.
      const eligibility = await refreshUndo();
      if (!eligibility.eligible) {
        setResult({ kind: 'error', text: `Undo stopped: ${eligibility.reason}` });
        return;
      }
      if (eligibility.paths.join('\n') !== expected.join('\n')) {
        setResult({
          kind: 'error',
          text: 'Undo stopped: the files changed. Review and try again.',
        });
        return;
      }
      await window.anvil.git.discard(repoId, eligibility.paths);
      setUndone(true);
      setUndoEligibility({ eligible: false, reason: 'This turn was undone.' });
      setResult({
        kind: 'success',
        text: `Undid this turn: restored ${eligibility.paths.length} file${eligibility.paths.length === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Undo failed' });
    } finally {
      setBusy(null);
      setUndoConfirmPaths(null);
    }
  };

  // --- Commit ---------------------------------------------------------------

  const openCommit = () => {
    if (noRepo()) return;
    setResult(null);
    setCommitMessage('');
    setOtherStaged([]);
    setCommitOpen(true);
    const turnSet = new Set(turnPaths);
    void window.anvil.git
      .status(repoId!)
      .then((status) =>
        setOtherStaged(
          status.files
            .filter((file) => file.staged && !turnSet.has(file.path))
            .map((file) => file.path),
        ),
      )
      .catch(() => undefined);
    void window.anvil.git
      .generateCommitMessage(repoId!)
      .then((message) => setCommitMessage(message))
      .catch(() => undefined);
  };

  const runCommit = async (message: string) => {
    setCommitOpen(false);
    if (noRepo()) return;
    setBusy('commit');
    setResult(null);
    try {
      if (turnPaths.length > 0) await window.anvil.git.stage(repoId!, turnPaths);
      const hash = await window.anvil.git.commit(repoId!, message);
      void window.anvil.metrics
        .track('change_applied', { fileCount: summary.files.length, via: 'commit' })
        .catch(() => {});
      setResult({ kind: 'success', text: `Committed ${hash.slice(0, 8)}` });
      setUndoEligibility(null);
      if (checkUndo) void refreshUndo();
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setBusy(null);
    }
  };

  // --- Pull request ---------------------------------------------------------

  const openPr = () => {
    if (noRepo()) return;
    setResult(null);
    setPrContext(null);
    setPrOpen(true);
    void window.anvil.git
      .status(repoId!)
      .then((status) => setPrContext({ branch: status.branch, fileCount: status.files.length }))
      .catch(() => undefined);
  };

  const runOpenPr = async () => {
    setPrOpen(false);
    if (noRepo()) return;
    setBusy('pr');
    setResult(null);
    try {
      const created = await window.anvil.git.createPullRequest(repoId!);
      void window.anvil.metrics
        .track('change_applied', { fileCount: summary.files.length, via: 'pr' })
        .catch(() => {});
      if (created.pullRequestUrl) {
        window.open(created.pullRequestUrl, '_blank', 'noopener');
        setResult({
          kind: 'success',
          text: `Pull request opened on ${created.branch}`,
          url: created.pullRequestUrl,
        });
      } else {
        setResult({
          kind: 'success',
          text: `Committed ${created.commitHash?.slice(0, 8) ?? 'changes'} — no PR provider is configured for ${created.repoName}.`,
        });
      }
      setUndoEligibility(null);
      if (checkUndo) void refreshUndo();
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Open PR failed' });
    } finally {
      setBusy(null);
    }
  };

  const undoBlocked = undoEligibility !== null && !undoEligibility.eligible;
  const undoReason = undoBlocked ? undoEligibility.reason : null;
  const repoName = repo?.name ?? 'this repository';

  return (
    <div className="border-t border-border-subtle">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {onOpenInChanges && (
          <Button variant="ghost" size="sm" onClick={onOpenInChanges} disabled={!repoId}>
            Open in Changes
          </Button>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void requestUndo()}
            disabled={!repoId || busy !== null || undoBlocked}
            aria-describedby={undoReason ? undoReasonId : undefined}
          >
            <Undo2 size={12} aria-hidden="true" />
            {busy === 'undo-check' ? 'Checking…' : busy === 'undo' ? 'Undoing…' : 'Undo turn…'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openCommit}
            disabled={!repoId || busy !== null}
          >
            <GitCommitHorizontal size={12} aria-hidden="true" />
            {busy === 'commit' ? 'Committing…' : 'Commit…'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={openPr}
            disabled={!repoId || busy !== null}
          >
            <GitPullRequest size={12} aria-hidden="true" />
            {busy === 'pr' ? 'Opening…' : 'Open PR…'}
          </Button>
        </span>
      </div>

      {undoReason && !undone && (
        <p id={undoReasonId} className="px-3 pb-2 text-xs text-text-tertiary">
          Undo isn't available: {undoReason}
        </p>
      )}

      {result && (
        <p
          className={`border-t border-border-subtle px-3 py-2 text-xs ${
            result.kind === 'success' ? 'text-success' : 'text-error'
          }`}
          role="status"
        >
          {result.text}
          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="ml-1.5 inline-flex items-center gap-0.5 text-info hover:underline"
            >
              Open <ExternalLink size={10} aria-hidden="true" />
            </a>
          )}
        </p>
      )}

      <ConfirmDialog
        open={undoConfirmPaths !== null}
        title="Undo this turn's changes?"
        tone="danger"
        confirmLabel={`Discard ${undoConfirmPaths?.length ?? 0} file${undoConfirmPaths?.length === 1 ? '' : 's'}`}
        loading={busy === 'undo'}
        description={
          <>
            Restores these files in {repoName} to how they were before this turn. Files this turn
            created are deleted. Anvil can't redo this.
            <FileListPreview paths={undoConfirmPaths ?? []} />
          </>
        }
        onConfirm={() => void confirmUndo()}
        onCancel={() => setUndoConfirmPaths(null)}
      />

      <PromptDialog
        open={commitOpen}
        title="Commit these changes"
        description={
          <>
            Stages the {turnPaths.length} file{turnPaths.length === 1 ? '' : 's'} this turn changed
            and commits them in {repoName}.
            <FileListPreview paths={turnPaths} />
            {otherStaged.length > 0 && (
              <span className="mt-2 block text-warning">
                {otherStaged.length} other already-staged file{otherStaged.length === 1 ? '' : 's'}{' '}
                will be included too.
              </span>
            )}
          </>
        }
        label="Commit message"
        defaultValue={commitMessage}
        placeholder="Describe the change"
        confirmLabel="Commit"
        onSubmit={(message) => void runCommit(message)}
        onCancel={() => setCommitOpen(false)}
      />

      <ConfirmDialog
        open={prOpen}
        title="Open a pull request?"
        confirmLabel="Commit and open PR"
        description={
          <>
            Commits every uncommitted change in {repoName}
            {prContext
              ? ` (${prContext.fileCount} file${prContext.fileCount === 1 ? '' : 's'})`
              : ''}
            , not only this turn&apos;s, with a generated message, pushes{' '}
            {prContext ? (
              <span className="font-mono">{prContext.branch}</span>
            ) : (
              'the current branch'
            )}
            , and opens a pull request.
          </>
        }
        onConfirm={() => void runOpenPr()}
        onCancel={() => setPrOpen(false)}
      />
    </div>
  );
}
