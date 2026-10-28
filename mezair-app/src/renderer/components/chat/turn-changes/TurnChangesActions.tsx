import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ExternalLink, GitCommitHorizontal, GitPullRequest, Undo2 } from 'lucide-react';
import type {
  ScopedGitBridge,
  PreparedTurnDelivery,
  TurnDeliveryMode,
} from '../../../../shared/scoped-git';
import type { RepoInfo } from '../../../../shared/types';
import { Button, ConfirmDialog, Dialog } from '../../ui';
import { DiffViewer } from '../DiffViewer';
import {
  createTurnDeliveryReviewRequestGuard,
  planTurnUndo,
  turnDeliveryPaths,
  type TurnChangeSummary,
  type TurnUndoEligibility,
} from '../chat-turn-changes';
import { loadTurnUndoEligibility } from './turn-undo';

type ActionBusy = 'commit-review' | 'pr-review' | 'commit' | 'pr' | 'undo' | 'undo-check' | null;

interface ActionResult {
  kind: 'success' | 'warning' | 'error';
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
      {shown.map((filePath) => (
        <span role="listitem" key={filePath} className="block break-all">
          {filePath}
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

function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function TurnDeliveryDialog({
  mode,
  review,
  repoName,
  message,
  busy,
  error,
  onMessageChange,
  onSubmit,
  onRefresh,
  onCancel,
}: {
  mode: TurnDeliveryMode;
  review: PreparedTurnDelivery | null;
  repoName: string;
  message: string;
  busy: ActionBusy;
  error: string | null;
  onMessageChange: (value: string) => void;
  onSubmit: () => void;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const isPr = mode === 'pr';
  const waiting = busy === 'commit-review' || busy === 'pr-review';
  const saving = busy === 'commit' || busy === 'pr';
  const paths = review?.files.map((file) => file.path) ?? [];
  const canSubmit = review !== null && message.trim().length > 0 && !saving && !waiting;

  return (
    <Dialog
      open
      onClose={saving ? () => {} : onCancel}
      title={isPr ? 'Review pull request changes' : 'Review changes to commit'}
      description={
        <>
          These are the current Git changes in the selected files in {repoName}. They can include
          edits made after the turn ended. Compare this exact diff before delivery.
          {review && (
            <span className="mt-1 block">
              Captured from <span className="font-mono">{review.sourceBranch}</span> at{' '}
              <span className="font-mono">{review.sourceHead.slice(0, 8)}</span>.
            </span>
          )}
          {review?.baseBranch && (
            <span className="mt-1 block">
              The pull request will target <span className="font-mono">{review.baseBranch}</span>;
              its diff contains only the selected changes.
            </span>
          )}
          {review && <FileListPreview paths={paths} />}
        </>
      }
      size="xl"
      className="max-h-[calc(100vh-3rem)]"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={onRefresh} disabled={waiting || saving}>
            Review again
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {saving
              ? isPr
                ? 'Opening…'
                : 'Committing…'
              : isPr
                ? 'Commit and open PR'
                : 'Commit reviewed changes'}
          </Button>
        </>
      }
    >
      {waiting && !review ? (
        <p className="mt-5 text-sm text-text-secondary" role="status">
          Preparing the current Git diff…
        </p>
      ) : review ? (
        <div className="mt-4">
          <div className="max-h-[48vh] overflow-auto rounded-md border border-border-subtle">
            {review.files.map((file) => (
              <section key={`${file.previousPath ?? ''}:${file.path}`}>
                <p className="sticky top-0 z-10 border-b border-border-subtle bg-bg-secondary px-3 py-2 font-mono text-xs text-text-secondary">
                  <span className="mr-2 text-text-tertiary">{file.status}</span>
                  {file.previousPath && (
                    <span className="mr-1 text-text-tertiary">{file.previousPath} →</span>
                  )}
                  <span className="break-all">{file.path}</span>
                </p>
                <div className="overflow-x-auto">
                  {file.diff.includes('@@') ? (
                    <DiffViewer filePath={file.path} diff={file.diff} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs text-text-secondary">
                      {file.diff || 'Git reported a file mode change with no line content.'}
                    </pre>
                  )}
                </div>
              </section>
            ))}
          </div>

          <label className="mt-4 block">
            <span className="text-eyebrow uppercase text-text-tertiary">Commit message</span>
            <input
              className="workflow-input mt-1.5"
              value={message}
              onChange={(event) => onMessageChange(event.target.value)}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
          </label>
          <p className="mt-2 text-xs text-text-tertiary">
            Other staged files stay staged. Only the files listed above are delivered.
          </p>
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-border-subtle bg-bg-tertiary/40 p-3">
          <p className="text-sm text-text-secondary" role="status">
            {error ?? 'The current diff could not be prepared.'}
          </p>
          <p className="mt-1 text-xs text-text-tertiary">
            Review again to capture the latest branch and file state.
          </p>
        </div>
      )}
      {error && review && (
        <p className="mt-3 text-sm text-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export interface TurnChangesActionsProps {
  summary: TurnChangeSummary;
  repo: RepoInfo | null;
  /** Explains why the turn's file scope could not be resolved to one repository. */
  scopeError?: string;
  /** Thread access is read-only: mutations (Undo, Commit, Open PR) are hidden. */
  readOnly: boolean;
  /** Files later turns in this thread edited; blocks Undo for overlapping files. */
  laterTurnEditedPaths?: readonly string[];
  /** Run the (read-only) undo eligibility check — set once the panel is open. */
  checkUndo: boolean;
  onOpenInChanges?: () => void;
}

/**
 * Turn-level actions under the expanded file list. Delivery first captures a
 * main-process diff, shows that exact candidate, then commits only its paths.
 */
export function TurnChangesActions({
  summary,
  repo,
  scopeError,
  readOnly,
  laterTurnEditedPaths,
  checkUndo,
  onOpenInChanges,
}: TurnChangesActionsProps) {
  const undoReasonId = useId();
  const [busy, setBusy] = useState<ActionBusy>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<TurnDeliveryMode | null>(null);
  const [deliveryReview, setDeliveryReview] = useState<PreparedTurnDelivery | null>(null);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [commitDraft, setCommitDraft] = useState('');
  const [prDraft, setPrDraft] = useState('');
  const [undoEligibility, setUndoEligibility] = useState<TurnUndoEligibility | null>(null);
  const [undoConfirmPaths, setUndoConfirmPaths] = useState<string[] | null>(null);
  const [undone, setUndone] = useState(false);
  const checkSequence = useRef(0);
  const deliveryRequests = useRef(createTurnDeliveryReviewRequestGuard());

  const repoId = repo?.id ?? null;
  const pathScope = useMemo(
    () => (repo ? turnDeliveryPaths(summary.files, repo.path) : { paths: [] as string[] }),
    [repo, summary.files],
  );
  const turnPaths = pathScope.paths;
  const actionScopeError = scopeError ?? pathScope.reason;
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
      ? await loadTurnUndoEligibility(window.mezair.git, repoId, undoPlan)
      : ({
          eligible: false,
          reason: actionScopeError ?? 'No repository is attached to these changes.',
        } as const);
    if (sequence === checkSequence.current) setUndoEligibility(eligibility);
    return eligibility;
  }, [actionScopeError, repoId, undoPlan]);

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
    if (repoId && !actionScopeError) return false;
    setResult({
      kind: 'error',
      text: actionScopeError ?? 'No repository is attached to these changes.',
    });
    return true;
  };

  const prepareDelivery = async (mode: TurnDeliveryMode) => {
    if (noRepo()) return;
    const request = deliveryRequests.current.begin();
    setDeliveryMode(mode);
    setDeliveryReview(null);
    setDeliveryError(null);
    setResult(null);
    setBusy(mode === 'commit' ? 'commit-review' : 'pr-review');
    try {
      const bridge = window.mezair.git as typeof window.mezair.git & ScopedGitBridge;
      const review = await bridge.prepareTurnDelivery(repoId!, turnPaths, mode);
      if (!deliveryRequests.current.isCurrent(request)) return;
      setDeliveryReview(review);
      if (mode === 'commit') {
        setCommitDraft((current) => current || review.suggestedMessage);
      } else {
        setPrDraft((current) => current || review.suggestedMessage);
      }
    } catch (error) {
      if (!deliveryRequests.current.isCurrent(request)) return;
      setDeliveryError(messageForError(error, 'Could not prepare the current Git diff.'));
    } finally {
      if (deliveryRequests.current.finish(request)) setBusy(null);
    }
  };

  const closeDelivery = () => {
    if (busy === 'commit' || busy === 'pr') return;
    if (deliveryRequests.current.cancel()) setBusy(null);
    setDeliveryMode(null);
    setDeliveryReview(null);
    setDeliveryError(null);
  };

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
      await window.mezair.git.discard(repoId, eligibility.paths);
      setUndone(true);
      setUndoEligibility({ eligible: false, reason: 'This turn was undone.' });
      setResult({
        kind: 'success',
        text: `Undid this turn: restored ${eligibility.paths.length} file${eligibility.paths.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      setResult({ kind: 'error', text: messageForError(error, 'Undo failed.') });
    } finally {
      setBusy(null);
      setUndoConfirmPaths(null);
    }
  };

  const runCommit = async () => {
    if (!repoId || !deliveryReview) return;
    setBusy('commit');
    setDeliveryError(null);
    try {
      const bridge = window.mezair.git as typeof window.mezair.git & ScopedGitBridge;
      const committed = await bridge.commitTurnDelivery(
        repoId,
        deliveryReview.reviewId,
        commitDraft,
      );
      void window.mezair.metrics
        .track('change_applied', { fileCount: committed.files.length, via: 'commit' })
        .catch(() => {});
      setResult({
        kind: committed.indexWarning ? 'warning' : 'success',
        text: committed.indexWarning
          ? `Committed ${committed.commitHash.slice(0, 8)} on ${committed.branch}. ${committed.indexWarning}`
          : `Committed ${committed.commitHash.slice(0, 8)} on ${committed.branch}.`,
      });
      setDeliveryMode(null);
      setDeliveryReview(null);
      setUndoEligibility(null);
      if (checkUndo) void refreshUndo();
    } catch (error) {
      const message = messageForError(error, 'Commit failed.');
      setDeliveryError(message);
      setResult({ kind: 'error', text: message });
    } finally {
      setBusy(null);
    }
  };

  const runOpenPr = async () => {
    if (!repoId || !deliveryReview) return;
    setBusy('pr');
    setDeliveryError(null);
    try {
      const bridge = window.mezair.git as typeof window.mezair.git & ScopedGitBridge;
      const created = await bridge.createTurnPullRequest(repoId, deliveryReview.reviewId, prDraft);
      void window.mezair.metrics
        .track('change_applied', { fileCount: deliveryReview.files.length, via: 'pr' })
        .catch(() => {});
      if (created.status === 'opened') {
        void window.mezair.metrics
          .track('pull_request_opened', {
            fileCount: deliveryReview.files.length,
            branch: created.branch,
            baseBranch: created.baseBranch,
          })
          .catch(() => {});
        window.open(created.pullRequestUrl, '_blank', 'noopener');
        setResult({
          kind: 'success',
          text: `Pull request opened on ${created.branch} into ${created.baseBranch}.`,
          url: created.pullRequestUrl,
        });
      } else {
        setResult({
          kind: 'warning',
          text: `${created.detail} Commit ${created.commitHash?.slice(0, 8) ?? 'saved'} on ${created.branch}.`,
        });
      }
      setDeliveryMode(null);
      setDeliveryReview(null);
    } catch (error) {
      const message = messageForError(error, 'Pull request delivery failed.');
      setDeliveryError(message);
      setResult({ kind: 'error', text: message });
    } finally {
      setBusy(null);
    }
  };

  const undoBlocked = undoEligibility !== null && !undoEligibility.eligible;
  const undoReason = undoBlocked ? undoEligibility.reason : null;
  const repoName = repo?.name ?? 'this repository';
  const messageDraft = deliveryMode === 'pr' ? prDraft : commitDraft;

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
            disabled={!repoId || Boolean(actionScopeError) || busy !== null || undoBlocked}
            aria-describedby={undoReason ? undoReasonId : undefined}
          >
            <Undo2 size={12} aria-hidden="true" />
            {busy === 'undo-check' ? 'Checking…' : busy === 'undo' ? 'Undoing…' : 'Undo turn…'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void prepareDelivery('commit')}
            disabled={!repoId || Boolean(actionScopeError) || busy !== null}
          >
            <GitCommitHorizontal size={12} aria-hidden="true" />
            {busy === 'commit-review'
              ? 'Reviewing…'
              : busy === 'commit'
                ? 'Committing…'
                : 'Commit…'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void prepareDelivery('pr')}
            disabled={!repoId || Boolean(actionScopeError) || busy !== null}
          >
            <GitPullRequest size={12} aria-hidden="true" />
            {busy === 'pr-review' ? 'Reviewing…' : busy === 'pr' ? 'Opening…' : 'Open PR…'}
          </Button>
        </span>
      </div>

      {actionScopeError && (
        <p className="px-3 pb-2 text-xs text-warning">
          Turn-level Git actions unavailable: {actionScopeError}
        </p>
      )}
      {undoReason && !undone && (
        <p id={undoReasonId} className="px-3 pb-2 text-xs text-text-tertiary">
          Undo isn&apos;t available: {undoReason}
        </p>
      )}

      {result && (
        <p
          className={`border-t border-border-subtle px-3 py-2 text-xs ${
            result.kind === 'success'
              ? 'text-success'
              : result.kind === 'warning'
                ? 'text-warning'
                : 'text-error'
          }`}
          role={result.kind === 'error' ? 'alert' : 'status'}
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
            created are deleted. Mezair can&apos;t redo this.
            <FileListPreview paths={undoConfirmPaths ?? []} />
          </>
        }
        onConfirm={() => void confirmUndo()}
        onCancel={() => setUndoConfirmPaths(null)}
      />

      {deliveryMode && (
        <TurnDeliveryDialog
          mode={deliveryMode}
          review={deliveryReview}
          repoName={repoName}
          message={messageDraft}
          busy={busy}
          error={deliveryError}
          onMessageChange={(value) =>
            deliveryMode === 'pr' ? setPrDraft(value) : setCommitDraft(value)
          }
          onSubmit={() => void (deliveryMode === 'pr' ? runOpenPr() : runCommit())}
          onRefresh={() => void prepareDelivery(deliveryMode)}
          onCancel={closeDelivery}
        />
      )}
    </div>
  );
}
