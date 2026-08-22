import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { GitPullRequest, Play, Loader2, Zap, GraduationCap } from 'lucide-react';
import type {
  CodeReview,
  CodeReviewMode,
  CodeReviewScopeRef,
  CodeReviewScopeType,
} from '../../../shared/types';
import { CodeReviewReport } from './CodeReviewReport';
import { CodeReviewScopeSelector } from './CodeReviewScopeSelector';
import { RepoSelector } from '../shared/RepoSelector';
import { PullRequestCanvas } from './PullRequestCanvas';
import { EmptyState, ViewHeader } from '../layout/ViewScaffold';

export function CodeReviewView() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const visualisePullRequestId = searchParams.get('pr');
  const initialCanvasMode = searchParams.get('view') === 'diff' ? 'diff' : 'map';

  // Review state
  const [reviews, setReviews] = useState<CodeReview[]>([]);
  const [selectedReview, setSelectedReview] = useState<CodeReview | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ message: '', percent: 0 });
  const [error, setError] = useState<string | null>(null);

  // Config state
  const [mode, setMode] = useState<CodeReviewMode>('quick_glance');
  const [scopeReady, setScopeReady] = useState(false);
  const [pendingScope, setPendingScope] = useState<{
    scopeType: CodeReviewScopeType;
    scopeRef?: CodeReviewScopeRef;
  } | null>(null);

  useEffect(() => {
    setScopeReady(false);
    setPendingScope(null);
    setRunning(false);
    setProgress({ message: '', percent: 0 });
    setSelectedReview(null);
    setReviews([]);
    setError(null);
  }, [repoId]);

  const syncReviewState = useCallback(
    async (preferredReviewId?: string | null) => {
      if (!repoId || !window.anvil.codereview) {
        return;
      }

      const [nextReviews, runningReview] = await Promise.all([
        window.anvil.codereview.list(repoId),
        window.anvil.codereview.getRunning(repoId),
      ]);

      setReviews(nextReviews);
      setRunning(Boolean(runningReview));
      setSelectedReview((current) => {
        const targetId =
          preferredReviewId ?? current?.id ?? runningReview?.id ?? nextReviews[0]?.id ?? null;
        if (!targetId) return null;
        return nextReviews.find((review) => review.id === targetId) ?? nextReviews[0] ?? null;
      });

      if (runningReview) {
        setProgress((current) =>
          current.percent > 0
            ? current
            : { message: 'Review in progress (reconnected)...', percent: 5 },
        );
      } else {
        setProgress((current) =>
          current.message || current.percent > 0 ? { message: '', percent: 0 } : current,
        );
      }
    },
    [repoId],
  );

  useEffect(() => {
    void syncReviewState();
  }, [syncReviewState]);

  useEffect(() => {
    if (!repoId || !running || !window.anvil.codereview) return;

    const interval = window.setInterval(() => {
      void syncReviewState();
    }, 2500);

    return () => window.clearInterval(interval);
  }, [repoId, running, syncReviewState]);

  // Listen for progress events
  useEffect(() => {
    if (!repoId || !window.anvil.codereview) return;
    const unsub = window.anvil.codereview.onProgress((data) => {
      if (data.repoId !== repoId) return;
      setProgress({ message: data.message, percent: data.percent });
      setRunning(data.percent > 0 && data.percent < 100);

      if (data.percent >= 100 || data.percent === 0) {
        void syncReviewState();
      }
    });
    return unsub;
  }, [repoId, syncReviewState]);

  const handleScopeSelected = useCallback(
    (scopeType: CodeReviewScopeType, scopeRef?: CodeReviewScopeRef) => {
      setPendingScope({ scopeType, scopeRef });
      setScopeReady(true);
    },
    [],
  );

  const handleScopeDirty = useCallback(() => {
    setScopeReady(false);
    setPendingScope(null);
  }, []);

  const handleRunReview = useCallback(async () => {
    if (!repoId || !pendingScope || !window.anvil.codereview) return;
    setRunning(true);
    setError(null);
    setScopeReady(false);
    setProgress({ message: 'Starting review...', percent: 0 });
    try {
      const review = await window.anvil.codereview.run(
        repoId,
        mode,
        pendingScope.scopeType,
        pendingScope.scopeRef,
      );
      if (review) {
        setSelectedReview(review);
        setReviews((prev) => [review, ...prev.filter((existing) => existing.id !== review.id)]);
        await syncReviewState(review.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review failed');
      setRunning(false);
      setProgress({ message: '', percent: 0 });
      await syncReviewState();
    }
  }, [repoId, mode, pendingScope, syncReviewState]);

  // API not available (preload needs rebuild/restart)
  if (repoId && !window.anvil.codereview) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <GitPullRequest size={48} className="mx-auto mb-3 text-text-tertiary opacity-30" />
          <p className="text-sm font-medium text-text-primary">Code Review API not available</p>
          <p className="mt-1 text-xs text-text-secondary">
            Restart the app to load the code review module.
          </p>
        </div>
      </div>
    );
  }

  if (repoId && visualisePullRequestId) {
    return (
      <PullRequestCanvas
        repoId={repoId}
        pullRequestId={visualisePullRequestId}
        reviewId={
          selectedReview?.scopeRef?.pullRequest?.id === visualisePullRequestId
            ? selectedReview.id
            : undefined
        }
        initialMode={initialCanvasMode}
        onClose={() => setSearchParams({})}
      />
    );
  }

  // Repo selection view
  if (!repoId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader
          icon={GitPullRequest}
          title="Code Review"
          description="Review a branch, commit range, working tree, or pull request with repository context."
        />
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <RepoSelector
            selectedRepoId={null}
            onSelect={(repo) => navigate(`/codereview/${repo.id}`)}
          />
        </div>
      </div>
    );
  }

  // Review view for specific repo
  return (
    <div className="flex h-full flex-1">
      {/* Sidebar */}
      <div className="flex w-[280px] shrink-0 flex-col border-r border-border-subtle bg-bg-secondary">
        <div className="border-b border-border-subtle p-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-text-primary">
            <GitPullRequest size={16} className="text-accent" />
            Code Review
          </h2>

          {/* Mode toggle */}
          <div className="mt-3 flex rounded-lg bg-bg-tertiary p-0.5">
            <button
              onClick={() => setMode('quick_glance')}
              disabled={running}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                mode === 'quick_glance'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              } disabled:opacity-50`}
            >
              <Zap size={14} />
              Quick Glance
            </button>
            <button
              onClick={() => setMode('senior_dev')}
              disabled={running}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors ${
                mode === 'senior_dev'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              } disabled:opacity-50`}
            >
              <GraduationCap size={14} />
              Senior Dev
            </button>
          </div>
        </div>

        {/* Scope selector */}
        {!running && (
          <div className="border-b border-border-subtle p-4">
            <p className="mb-2 text-sm font-medium text-text-secondary">Review scope</p>
            <CodeReviewScopeSelector
              repoId={repoId}
              onScopeSelected={handleScopeSelected}
              onScopeDirty={handleScopeDirty}
              disabled={running}
            />
          </div>
        )}

        {/* Run button */}
        {scopeReady && !running && (
          <div className="border-b border-border-subtle p-4">
            <button
              onClick={handleRunReview}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Play size={14} />
              Run {mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review'}
            </button>
          </div>
        )}

        {/* Progress bar during review */}
        {running && (
          <div className="border-b border-border-subtle p-4">
            <div className="mb-2 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-accent" />
              <span className="text-xs font-medium text-text-secondary">Running...</span>
            </div>
            <p className="mb-1.5 text-xs text-text-tertiary">{progress.message}</p>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${progress.percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Review history */}
        <div className="flex-1 overflow-auto p-2">
          <p className="px-2 pb-1 text-sm font-medium text-text-secondary">Review history</p>
          {reviews.map((review) => (
            <button
              key={review.id}
              onClick={() => setSelectedReview(review)}
              className={`mb-1 flex w-full flex-col rounded-md px-3 py-2 text-left text-sm transition-colors ${
                selectedReview?.id === review.id
                  ? 'bg-accent text-white'
                  : 'text-text-secondary hover:bg-bg-tertiary'
              }`}
            >
              <span className="font-medium">
                {new Date(review.startedAt).toLocaleDateString()}{' '}
                {new Date(review.startedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <span
                className={`mt-0.5 text-xs ${review.status === 'failed' ? 'text-error' : selectedReview?.id === review.id ? 'text-white/70' : 'text-text-secondary'}`}
              >
                {review.status === 'completed'
                  ? `${review.mode === 'quick_glance' ? 'Quick' : 'Senior'} — ${formatScopeLabel(review.scopeType, review.scopeRef)}`
                  : review.status === 'failed'
                    ? 'Failed'
                    : review.status === 'running'
                      ? 'In progress...'
                      : review.status}
              </span>
            </button>
          ))}
          {reviews.length === 0 && !running && (
            <p className="p-3 text-center text-xs text-text-secondary">
              No reviews yet. Configure scope and run your first review.
            </p>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 rounded-md border border-error bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}
        {selectedReview ? (
          <CodeReviewReport
            review={selectedReview}
            onVisualisePullRequest={(pullRequestId) =>
              setSearchParams({ pr: pullRequestId, view: 'map' })
            }
          />
        ) : (
          <EmptyState
            icon={GitPullRequest}
            title={running ? 'Review in progress' : 'Ready for a review'}
            description={
              running
                ? progress.message || 'Anvil is inspecting the selected scope.'
                : 'Choose a scope in the left panel, then run Quick Glance or Senior Dev Review.'
            }
          />
        )}
      </div>
    </div>
  );
}

function formatScopeLabel(scopeType: CodeReviewScopeType, scopeRef?: CodeReviewScopeRef): string {
  if (scopeType === 'pull_request' && scopeRef?.pullRequest?.id) {
    return `PR #${scopeRef.pullRequest.id}`;
  }

  return scopeType.replace(/_/g, ' ');
}
