import { isFindingAccepted } from '../../../shared/change-review-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Play, RefreshCw, CheckCheck, Download, MessageSquare } from 'lucide-react';
import type {
  ChangeReview,
  ReviewRun,
  ReviewCapture,
  ReviewScenario,
} from '../../../shared/change-review-types';
import type { WorkItem } from '../../../shared/types';
import { useChatContext } from '../../contexts/ChatContext';
import { matchesReviewContext } from '../../utils/change-review-context';
import { NativeEvidencePanel } from './NativeEvidencePanel';
import { copyTextToClipboard } from '../../utils/clipboard';

const button =
  'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';
const field =
  'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent';
const initialScenario: ReviewScenario = {
  name: 'Primary journey',
  fixtureVersion: '',
  setupCommand: '',
  resetCommand: '',
  startCommand: '',
  readyPath: '/',
  steps: [
    { action: 'goto', value: '/' },
    { action: 'visible', locator: 'main' },
  ],
  viewports: [
    { name: 'Desktop', width: 1280, height: 800 },
    { name: 'Mobile', width: 390, height: 844 },
  ],
};
function CaptureImage({
  review,
  run,
  capture,
  pin,
  blend,
}: {
  review: ChangeReview;
  run: ReviewRun;
  capture: ReviewCapture;
  pin?: (x: number, y: number) => void;
  blend?: boolean;
}) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setImage('');
    setError('');
    void window.anvil.changeReview
      .artifact(review.id, run.id, capture.id)
      .then((value) => {
        if (!cancelled) setImage(value);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [review.id, run.id, capture.id]);
  if (error)
    return (
      <p role="alert" className="p-3 text-sm text-error">
        {error}
      </p>
    );
  if (!image) return <p className="p-3 text-sm text-text-secondary">Loading capture…</p>;
  return (
    <img
      src={image}
      alt={`${capture.viewport} capture, ${capture.outcome}`}
      className={`${blend ? 'mix-blend-difference' : ''} h-auto w-full ${pin ? 'cursor-crosshair' : ''}`}
      onClick={(event) => {
        if (!pin) return;
        const rect = event.currentTarget.getBoundingClientRect();
        pin((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
      }}
    />
  );
}
export function ChangeReviewPanel({
  workspaceId,
  repoId,
  workItem,
  connectionId,
  initialReviewId,
  initialRunId,
  initialCaptureId,
  initialFindingId,
  initialCriterionId,
  initialScenarioVersion,
  initialBaseRef,
  origin,
}: {
  workspaceId: string;
  repoId: string;
  workItem?: WorkItem;
  connectionId?: string;
  initialReviewId?: string;
  initialRunId?: string;
  initialCaptureId?: string;
  initialFindingId?: string;
  initialCriterionId?: string;
  initialScenarioVersion?: string;
  initialBaseRef?: string;
  origin?: ChangeReview['origin'];
}) {
  const navigate = useNavigate();
  const captureSection = useRef<HTMLElement>(null);
  const findingsSection = useRef<HTMLElement>(null);
  const criteriaSection = useRef<HTMLElement>(null);
  const scenarioSection = useRef<HTMLElement>(null);
  const { launchPreparedChat, setChatLayout } = useChatContext();
  const [reviews, setReviews] = useState<ChangeReview[]>([]);
  const [review, setReview] = useState<ChangeReview>();
  const [baseRef, setBaseRef] = useState(initialBaseRef ?? 'HEAD');
  const [localCriteria, setLocalCriteria] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState<ReviewScenario>(initialScenario);
  const [configuring, setConfiguring] = useState(false);
  const [runId, setRunId] = useState('');
  const [viewport, setViewport] = useState('Desktop');
  const [comparison, setComparison] = useState<'side' | 'overlay' | 'difference'>('side');
  const [note, setNote] = useState('');
  const [locator, setLocator] = useState('');
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const [decisionNote, setDecisionNote] = useState('');
  const [acceptedCriteria, setAcceptedCriteria] = useState<string[]>([]);
  const [exportText, setExportText] = useState('');
  const [copied, setCopied] = useState(false);
  const run = review?.runs.find((run) => run.id === runId) ?? review?.runs.at(-1);
  const running = review?.runs.some((run) => run.outcome === 'running') ?? false;
  const criteria = review?.criteria.at(-1);
  const stale = Boolean(
    review &&
    run &&
    (review.freshness !== 'current' ||
      run.candidate.tree !== review.candidate.tree ||
      run.criteriaVersion !== criteria?.id ||
      run.scenarioVersion !== review.scenarioVersion),
  );
  const baseCapture = run?.base.find((c) => c.viewport === viewport);
  const candidateCapture = run?.candidateCaptures.find((c) => c.viewport === viewport);
  const select = useCallback(
    (value: ChangeReview) => {
      setReview(value);
      setScenario(value.scenario ?? initialScenario);
      setConfiguring(!value.scenario || Boolean(initialScenarioVersion));
      const finding = value.findings.find((f) => f.id === initialFindingId);
      const targetRun = value.runs.find((r) => r.id === (initialRunId ?? finding?.runId));
      const targetCapture = targetRun?.candidateCaptures.find(
        (c) => c.id === (initialCaptureId ?? finding?.captureId),
      );
      if (initialRunId && !targetRun)
        setError('The linked run is unavailable. The latest run is shown below.');
      if (initialScenarioVersion && initialScenarioVersion !== value.scenarioVersion)
        setError(
          'The linked scenario has changed. The current saved scenario is shown below; earlier evidence remains stale.',
        );
      if (
        initialCriterionId &&
        !value.criteria.at(-1)?.items.some((c) => c.id === initialCriterionId)
      )
        setError(
          'The linked criterion is no longer in the current criteria. Review the updated expectations below.',
        );
      setRunId(targetRun?.id ?? '');
      if (targetCapture) setViewport(targetCapture.viewport);
      setAcceptedCriteria([]);
      setDecisionNote('');
      setPoint(undefined);
    },
    [initialRunId, initialCaptureId, initialFindingId, initialScenarioVersion, initialCriterionId],
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.anvil.changeReview
      .list(workspaceId)
      .then((values) => {
        if (cancelled) return;
        const matching = values.filter((r) =>
          matchesReviewContext(r, {
            repoId,
            reviewId: initialReviewId,
            origin,
            workItemId: workItem?.id,
            connectionId,
          }),
        );
        setReviews(matching);
        if (initialReviewId && !matching.length)
          setError('This review is unavailable in the selected workspace and repository.');
        if (matching[0]) {
          select(matching[0]);
        } else {
          setReview(undefined);
          setScenario(initialScenario);
          setConfiguring(false);
          setRunId('');
          setAcceptedCriteria([]);
          setDecisionNote('');
          setPoint(undefined);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    repoId,
    workItem?.id,
    connectionId,
    initialReviewId,
    origin?.automationRunId,
    origin?.workflowRunId,
    origin?.pullRequest?.id,
    origin?.pullRequest?.provider,
    origin?.pullRequest?.headSha,
    select,
  ]);
  useEffect(() => {
    if (!review?.id) return;
    let cancelled = false;
    const refresh = () => {
      void window.anvil.changeReview
        .get(review.id)
        .then((value) => {
          if (!cancelled) setReview(value);
        })
        .catch((err) => {
          if (!cancelled) setError(String(err));
        });
    };
    refresh();
    const timer = setInterval(refresh, running ? 2000 : 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [review?.id, running]);
  useEffect(() => {
    setAcceptedCriteria([]);
    setDecisionNote('');
  }, [criteria?.id, run?.id]);
  useEffect(() => {
    if (loading) return;
    const section = initialFindingId
      ? findingsSection
      : initialCriterionId
        ? criteriaSection
        : initialScenarioVersion
          ? scenarioSection
          : initialCaptureId
            ? captureSection
            : undefined;
    section?.current?.scrollIntoView({ block: 'start' });
  }, [loading, initialFindingId, initialCriterionId, initialScenarioVersion, initialCaptureId]);
  async function action(task: () => Promise<ChangeReview | void>) {
    setBusy(true);
    setError('');
    try {
      const value = await task();
      if (value) setReview(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    await action(async () => {
      const value = await window.anvil.changeReview.create({
        workspaceId,
        repoId,
        baseRef,
        localCriteria,
        origin,
        workItemRef:
          workItem && connectionId
            ? { connectionId, provider: workItem.provider, id: workItem.id }
            : undefined,
      });
      select(value);
      setReviews((values) => [value, ...values]);
      return value;
    });
  }
  async function requestFix(findingId: string) {
    if (!review) return;
    const finding = review.findings.find((f) => f.id === findingId)!;
    const sourceRun = review.runs.find((r) => r.id === finding.runId)!;
    await action(async () => {
      const threadId = await launchPreparedChat({
        personaId: 'coder',
        repoIds: [repoId],
        workItem: review.workItem,
        collaborationMode: 'default',
        threadTitle: `Fix review: ${review.title}`,
        changeReviewId: review.id,
        message: [
          `Resolve this review finding for ${review.title}.`,
          `Review ${review.id}; finding ${finding.id}; source tree ${sourceRun.candidate.tree}.`,
          finding.note,
          review.origin?.executionPath
            ? `Repair only in retained candidate worktree ${review.origin.executionPath}; do not change the normal repository checkout.`
            : '',
          `Return to evidence and replay: /review?repo=${encodeURIComponent(repoId)}&review=${encodeURIComponent(review.id)}&finding=${encodeURIComponent(finding.id)}`,
          finding.locator ? `Locator: ${finding.locator}` : '',
          finding.x !== undefined ? `Capture coordinates: ${finding.x}, ${finding.y}` : '',
          `Acceptance criteria from the Work Item:\n${criteria?.sourceText || 'No explicit criteria.'}`,
          `Approved replay scenario:\n${JSON.stringify(review.scenario, null, 2)}`,
          'Keep the established expectations intact. Report ready for recheck when implemented; do not declare the finding accepted. The reviewer will rerun the scenario in Anvil and decide.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      });
      if (!threadId)
        throw new Error('The repair chat could not be started. Try requesting the fix again.');
      await window.anvil.changeReview.repairFinding(review.id, finding.id, { threadId });
      navigate('/chat');
    });
  }
  if (loading)
    return (
      <p className="p-5 text-sm text-text-secondary" role="status">
        Loading review history…
      </p>
    );
  return (
    <div className="min-w-0 space-y-5 p-5">
      {error ? (
        <div role="alert" className="flex items-start gap-2 text-sm text-error">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      ) : null}
      {!review ? (
        <div className="max-w-xl space-y-4">
          <h3 className="text-lg font-semibold">Review the resulting change</h3>
          <p className="text-sm leading-6 text-text-secondary">
            Capture this checkout, compare it with a base revision, and attach verification to the
            exact candidate. Your staged and unstaged changes stay in place.
          </p>
          <label className="block space-y-1 text-sm">
            Base revision
            <input
              className={field}
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              placeholder="HEAD, main or a commit SHA"
            />
          </label>
          {!workItem ? (
            <label className="block space-y-1 text-sm">
              Local acceptance criteria
              <textarea
                className={field}
                rows={4}
                value={localCriteria}
                onChange={(e) => setLocalCriteria(e.target.value)}
                placeholder="One expectation per line"
              />
            </label>
          ) : null}
          <button
            className={button}
            disabled={busy || !baseRef.trim()}
            onClick={() => void create()}
          >
            <CheckCheck size={15} />
            Create review
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-lg font-semibold">Change review</h3>
            {reviews.length > 1 ? (
              <select
                aria-label="Review history"
                className={button}
                value={review.id}
                onChange={(e) => {
                  const value = reviews.find((r) => r.id === e.target.value);
                  if (value)
                    void action(async () => {
                      const fresh = await window.anvil.changeReview.get(value.id);
                      select(fresh);
                      return fresh;
                    });
                }}
              >
                {reviews.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              className={button}
              disabled={busy || running}
              onClick={() => void action(() => window.anvil.changeReview.refresh(review.id))}
            >
              <RefreshCw size={14} />
              Refresh candidate
            </button>
          </div>
          <div className="space-y-1 text-xs leading-5 text-text-secondary">
            {review.origin?.executionPath ? (
              <p className="break-all">
                Execution checkout: <code>{review.origin.executionPath}</code>
              </p>
            ) : null}
            {review.origin?.automationRunId ? (
              <p>
                Watchtower run <code>{review.origin.automationRunId}</code>
              </p>
            ) : null}
            {review.origin?.workflowRunId ? (
              <p>
                Workflow run <code>{review.origin.workflowRunId}</code>
              </p>
            ) : null}
            <p>
              Base <code>{review.baseCommit.slice(0, 12)}</code> · Candidate{' '}
              <code>{review.candidate.tree.slice(0, 12)}</code>
            </p>
            <p>
              {review.freshnessDetail ||
                'Evidence applies to the captured source and saved scenario.'}
            </p>
            <p>
              Criteria fetched {new Date(criteria!.fetchedAt).toLocaleString()}
              {review.workItemRef ? ` from ${review.workItemRef.provider}` : ' locally'}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={busy || running}
              onClick={() => setConfiguring((value) => !value)}
            >
              {configuring ? 'Hide scenario' : 'Edit scenario'}
            </button>
            <button
              className={`${button} border-accent text-accent`}
              disabled={busy || running || !review.scenario}
              onClick={() => {
                setRunId('');
                void action(() => window.anvil.changeReview.run(review.id));
              }}
            >
              <Play size={14} />
              {running ? 'Verification running…' : 'Run base and candidate'}
            </button>
            {running ? (
              <button
                className={button}
                onClick={() => void action(() => window.anvil.changeReview.cancel(review.id))}
              >
                Cancel run
              </button>
            ) : null}
          </div>
          <NativeEvidencePanel key={review.id} review={review} onUpdate={setReview} />
          {configuring ? (
            <section ref={scenarioSection} className="space-y-4 border-y border-border py-4">
              <h4 className="font-semibold">Replay scenario</h4>
              <p className="max-w-prose text-xs leading-5 text-text-secondary">
                Commands run in isolated worktrees using the same saved steps for both versions. Use
                PORT for the server and ANVIL_REVIEW_DATA for separate test data. Playwright must
                already be installed in the repository or installed by your setup command.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    'name',
                    'fixtureVersion',
                    'startCommand',
                    'resetCommand',
                    'setupCommand',
                    'readyPath',
                  ] as const
                ).map((key) => (
                  <label key={key} className="space-y-1 text-sm">
                    <span>
                      {
                        {
                          name: 'Scenario name',
                          fixtureVersion: 'Fixture version',
                          startCommand: 'Start server command',
                          resetCommand: 'Reset test data command',
                          setupCommand: 'Setup command, optional',
                          readyPath: 'Readiness path',
                        }[key]
                      }
                    </span>
                    <input
                      className={field}
                      value={scenario[key] ?? ''}
                      onChange={(e) => setScenario((s) => ({ ...s, [key]: e.target.value }))}
                      placeholder={
                        key === 'startCommand'
                          ? 'pnpm dev --host 127.0.0.1 --port $PORT'
                          : key === 'resetCommand'
                            ? 'Your fixture reset command'
                            : ''
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="space-y-2">
                {scenario.steps.map((step, index) => (
                  <div key={index} className="flex flex-wrap gap-2">
                    <select
                      aria-label={`Step ${index + 1} action`}
                      className={button}
                      value={step.action}
                      onChange={(e) => {
                        const kind = e.target.value;
                        setScenario((s) => ({
                          ...s,
                          steps: s.steps.map((old, i) =>
                            i === index
                              ? kind === 'goto'
                                ? { action: 'goto', value: '/' }
                                : kind === 'click' || kind === 'visible'
                                  ? { action: kind, locator: '' }
                                  : {
                                      action: kind as 'fill' | 'press' | 'text',
                                      locator: '',
                                      value: '',
                                    }
                              : old,
                          ),
                        }));
                      }}
                    >
                      {['goto', 'click', 'fill', 'press', 'visible', 'text'].map((action) => (
                        <option key={action}>{action}</option>
                      ))}
                    </select>
                    {'locator' in step ? (
                      <input
                        aria-label={`Step ${index + 1} locator`}
                        className={`${field} min-w-36 flex-1`}
                        value={step.locator}
                        placeholder="CSS or Playwright locator"
                        onChange={(e) =>
                          setScenario((s) => ({
                            ...s,
                            steps: s.steps.map((old, i) =>
                              i === index ? { ...old, locator: e.target.value } : old,
                            ),
                          }))
                        }
                      />
                    ) : null}
                    {'value' in step ? (
                      <input
                        aria-label={`Step ${index + 1} value`}
                        className={`${field} min-w-36 flex-1`}
                        value={step.value}
                        placeholder="Path, text or key"
                        onChange={(e) =>
                          setScenario((s) => ({
                            ...s,
                            steps: s.steps.map((old, i) =>
                              i === index ? { ...old, value: e.target.value } : old,
                            ),
                          }))
                        }
                      />
                    ) : null}
                    <button
                      className={button}
                      aria-label={`Remove step ${index + 1}`}
                      onClick={() =>
                        setScenario((s) => ({ ...s, steps: s.steps.filter((_, i) => i !== index) }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  className={button}
                  onClick={() =>
                    setScenario((s) => ({
                      ...s,
                      steps: [...s.steps, { action: 'visible', locator: '' }],
                    }))
                  }
                >
                  Add step
                </button>
              </div>
              <p className="text-xs text-text-secondary">
                Desktop 1280 × 800 and mobile 390 × 844. Each uses a fresh browser context. Test
                data must be deterministic and independent of any production account.
              </p>
              <button
                className={button}
                disabled={busy || running}
                onClick={() =>
                  void action(async () => {
                    const value = await window.anvil.changeReview.configure(review.id, scenario);
                    setConfiguring(false);
                    return value;
                  })
                }
              >
                Save approved scenario
              </button>
            </section>
          ) : null}
          {run ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Verification run"
                  value={run.id}
                  className={button}
                  onChange={(e) => {
                    setRunId(e.target.value);
                    setPoint(undefined);
                  }}
                >
                  {[...review.runs].reverse().map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.startedAt).toLocaleString()} · {r.outcome}
                    </option>
                  ))}
                </select>
                <span
                  className={`text-sm ${stale ? 'text-warning' : run.outcome === 'passed' ? 'text-success' : 'text-text-secondary'}`}
                >
                  {review.freshness === 'unknown'
                    ? 'Freshness unknown'
                    : stale
                      ? 'Stale evidence'
                      : run.outcome}{' '}
                  · runner-observed
                </span>
              </div>
              {run.error ? <p className="text-sm text-error">{run.error}</p> : null}
              <p className="text-xs text-text-secondary">{run.environment}</p>
              {candidateCapture && baseCapture ? (
                <section ref={captureSection} className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label="Viewport"
                      value={viewport}
                      onChange={(e) => {
                        setViewport(e.target.value);
                        setPoint(undefined);
                      }}
                      className={button}
                    >
                      {run.candidateCaptures.map((c) => (
                        <option key={c.id} value={c.viewport}>
                          {c.viewport}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Comparison mode"
                      value={comparison}
                      onChange={(e) => setComparison(e.target.value as typeof comparison)}
                      className={button}
                    >
                      <option value="side">Side by side</option>
                      <option value="overlay">Overlay</option>
                      <option value="difference">Pixel difference</option>
                    </select>
                  </div>
                  {comparison !== 'side' && (
                    <div className="flex flex-wrap justify-between gap-2 text-xs text-text-secondary">
                      <span>Base · {baseCapture.outcome}</span>
                      <span>Candidate · {candidateCapture.outcome}</span>
                    </div>
                  )}
                  <div className={comparison === 'side' ? 'grid gap-3 xl:grid-cols-2' : 'grid'}>
                    <div className={comparison === 'side' ? '' : 'col-start-1 row-start-1'}>
                      {comparison === 'side' && (
                        <p className="mb-2 text-xs text-text-secondary">
                          Base · {baseCapture.outcome}
                        </p>
                      )}
                      <CaptureImage review={review} run={run} capture={baseCapture} />
                    </div>
                    <div
                      className={
                        comparison === 'side'
                          ? ''
                          : `col-start-1 row-start-1 ${comparison === 'overlay' ? 'opacity-50' : ''}`
                      }
                    >
                      {comparison === 'side' && (
                        <p className="mb-2 text-xs text-text-secondary">
                          Candidate · {candidateCapture.outcome}
                        </p>
                      )}
                      <CaptureImage
                        review={review}
                        run={run}
                        capture={candidateCapture}
                        blend={comparison === 'difference'}
                        pin={(x, y) => setPoint({ x, y })}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-text-tertiary">
                    Click the candidate to pin a position, or describe a finding below. Pixel
                    differences are a viewing aid, not a regression verdict.
                  </p>
                  <div className="space-y-2">
                    <label className="block text-sm">
                      Flag a problem
                      <textarea
                        rows={2}
                        className={field}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="What is wrong, and what should happen?"
                      />
                    </label>
                    <input
                      aria-label="Element locator, optional"
                      className={field}
                      value={locator}
                      onChange={(e) => setLocator(e.target.value)}
                      placeholder="Element locator, optional"
                    />
                    {point ? (
                      <p className="text-xs text-text-secondary">
                        Pinned at {Math.round(point.x * 100)}%, {Math.round(point.y * 100)}%
                      </p>
                    ) : null}
                    <button
                      className={button}
                      disabled={!note.trim() || busy || running}
                      onClick={() =>
                        void action(async () => {
                          const value = await window.anvil.changeReview.annotate(review.id, {
                            runId: run.id,
                            captureId: candidateCapture.id,
                            note,
                            locator: locator || undefined,
                            ...point,
                          });
                          setNote('');
                          setPoint(undefined);
                          return value;
                        })
                      }
                    >
                      Save finding
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        void action(() =>
                          window.anvil.changeReview.openTrace(
                            review.id,
                            run.id,
                            candidateCapture.id,
                          ),
                        )
                      }
                    >
                      Reveal Playwright trace
                    </button>
                  </div>
                  <details>
                    <summary className="cursor-pointer text-sm text-text-secondary">
                      Actions and assertions
                    </summary>
                    <ol className="mt-2 space-y-2">
                      {candidateCapture.steps.map((step, i) => (
                        <li key={i} className="break-words text-xs">
                          <span
                            className={
                              step.outcome === 'failed' ? 'text-error' : 'text-text-secondary'
                            }
                          >
                            {step.outcome}
                          </span>{' '}
                          <code>{step.action}</code>
                          {step.detail ? <p className="mt-1 text-error">{step.detail}</p> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                </section>
              ) : (
                <p className="text-sm text-text-secondary">
                  {running
                    ? 'Preparing isolated worktrees and capturing the journey…'
                    : 'No complete comparison was captured. Inspect the run output and replay.'}
                </p>
              )}
              <details>
                <summary className="cursor-pointer text-sm text-text-secondary">
                  Runner output
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words bg-bg-primary p-3 text-xs">
                  {run.log || 'No output recorded.'}
                </pre>
              </details>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              Not checked. Save a scenario and run both versions to collect evidence.
            </p>
          )}
          {review.findings.length ? (
            <section ref={findingsSection} className="space-y-3 border-t border-border pt-4">
              <h4 className="font-semibold">Findings</h4>
              {review.findings.map((f) => (
                <div
                  key={f.id}
                  id={`finding-${f.id}`}
                  className={`space-y-2 rounded-md ${initialFindingId === f.id ? 'bg-bg-tertiary p-3' : ''}`}
                >
                  <p className="whitespace-pre-wrap text-sm">{f.note}</p>
                  <p className="text-xs text-text-secondary">
                    {f.history.at(-1)?.state === 'accepted' && !isFindingAccepted(review, f)
                      ? 'stale acceptance, recheck required'
                      : f.history.at(-1)?.state.replaceAll('_', ' ')}{' '}
                    · {f.history.length} history entries
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {f.repair?.threadId ? (
                      <button
                        className={button}
                        onClick={() =>
                          void action(async () => {
                            await setChatLayout(review.workItem ? 'workitems' : 'classic');
                            navigate(
                              `/chat?${new URLSearchParams({ thread: f.repair!.threadId! })}`,
                            );
                          })
                        }
                      >
                        <MessageSquare size={14} />
                        Open repair thread
                      </button>
                    ) : null}
                    <button
                      className={button}
                      disabled={busy || running}
                      onClick={() => {
                        const source = review.runs.find((r) => r.id === f.runId);
                        const capture = source?.candidateCaptures.find((c) => c.id === f.captureId);
                        setRunId(f.runId);
                        if (capture) setViewport(capture.viewport);
                        captureSection.current?.scrollIntoView({ block: 'start' });
                      }}
                    >
                      View source capture
                    </button>
                    <button
                      className={button}
                      disabled={busy || running || !review.scenario}
                      onClick={() => {
                        setRunId('');
                        void action(async () => {
                          await window.anvil.changeReview.refresh(review.id);
                          return window.anvil.changeReview.run(review.id);
                        });
                      }}
                    >
                      <Play size={14} />
                      Replay current candidate
                    </button>
                    <button
                      className={button}
                      disabled={busy || running}
                      onClick={() => void requestFix(f.id)}
                    >
                      <MessageSquare size={14} />
                      Request fix
                    </button>
                    <button
                      className={button}
                      disabled={busy || running}
                      onClick={() =>
                        void action(() =>
                          window.anvil.changeReview.resolveFinding(
                            review.id,
                            f.id,
                            'ready_for_recheck',
                            run?.id ?? f.runId,
                          ),
                        )
                      }
                    >
                      Ready for recheck
                    </button>
                    <button
                      className={button}
                      disabled={
                        busy || running || stale || run?.outcome !== 'passed' || run.id === f.runId
                      }
                      onClick={() =>
                        void action(() =>
                          window.anvil.changeReview.resolveFinding(
                            review.id,
                            f.id,
                            'accepted',
                            run!.id,
                          ),
                        )
                      }
                    >
                      Accept replay
                    </button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
          <section ref={criteriaSection} className="space-y-3 border-t border-border pt-4">
            <h4 className="font-semibold">Acceptance criteria</h4>
            <p className="text-xs leading-5 text-text-secondary">
              A passing scenario does not automatically satisfy every criterion. Inspect its
              assertions and record any manual checks before accepting.
            </p>
            {criteria?.items.length ? (
              criteria.items.map((c) => (
                <label
                  key={c.id}
                  className={`flex items-start gap-3 rounded-md text-sm leading-6 ${initialCriterionId === c.id ? 'bg-bg-tertiary p-3' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1.5 accent-accent"
                    checked={acceptedCriteria.includes(c.id)}
                    onChange={(e) =>
                      setAcceptedCriteria((ids) =>
                        e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id),
                      )
                    }
                    disabled={busy || running || stale || run?.outcome !== 'passed'}
                  />
                  <span>
                    {c.text}
                    <span className="block text-xs text-text-tertiary">
                      {acceptedCriteria.includes(c.id)
                        ? 'Human reviewed against the selected run'
                        : 'Not yet accepted'}
                    </span>
                  </span>
                </label>
              ))
            ) : (
              <p className="text-sm text-warning">
                No explicit criteria. Your decision must state what you checked.
              </p>
            )}
            <label className="block text-sm">
              Decision and manual verification notes
              <textarea
                className={field}
                rows={3}
                value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder="Explain the acceptance decision, including visual or keyboard checks."
              />
            </label>
            <div className="flex flex-wrap gap-2">
              {(['accepted', 'rejected'] as const).map((outcome) => (
                <button
                  key={outcome}
                  className={button}
                  disabled={
                    busy ||
                    running ||
                    !run ||
                    stale ||
                    !decisionNote.trim() ||
                    (outcome === 'accepted' &&
                      (run.outcome !== 'passed' ||
                        acceptedCriteria.length !== criteria?.items.length ||
                        review.findings.some((f) => !isFindingAccepted(review, f))))
                  }
                  onClick={() =>
                    void action(() =>
                      window.anvil.changeReview.decide(review.id, {
                        runId: run!.id,
                        outcome,
                        note: decisionNote,
                        criterionDecisions: criteria!.items.map((c) => ({
                          criterionId: c.id,
                          outcome: acceptedCriteria.includes(c.id) ? 'accepted' : 'not_checked',
                          note: decisionNote,
                        })),
                      }),
                    )
                  }
                >
                  {outcome === 'accepted' ? 'Accept this candidate' : 'Request changes'}
                </button>
              ))}
            </div>
            {review.decisions.map((d) => (
              <p key={d.id} className="text-xs leading-5 text-text-secondary">
                {d.outcome} by {d.reviewer}, {new Date(d.at).toLocaleString()}, candidate{' '}
                {d.snapshot.slice(0, 12)}
                {d.snapshot !== review.candidate.tree || d.criteriaVersion !== criteria?.id
                  ? ' · historical decision'
                  : ''}
                . {d.note}
              </p>
            ))}
          </section>
          <details
            onToggle={(e) => {
              if (!e.currentTarget.open) setExportText('');
            }}
          >
            <summary className="cursor-pointer text-sm text-text-secondary">
              Export evidence
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs leading-5 text-text-secondary">
                Logs, commands and binary artifacts are omitted. Review and redact the text below
                before copying it elsewhere.
              </p>
              <div className="flex gap-2">
                {(['markdown', 'json'] as const).map((format) => (
                  <button
                    key={format}
                    className={button}
                    onClick={() =>
                      void action(async () => {
                        setExportText(await window.anvil.changeReview.export(review.id, format));
                        setCopied(false);
                      })
                    }
                  >
                    <Download size={14} />
                    Preview {format}
                  </button>
                ))}
              </div>
              {exportText ? (
                <>
                  <textarea
                    aria-label="Redact evidence export"
                    className={`${field} font-mono`}
                    rows={12}
                    value={exportText}
                    onChange={(e) => setExportText(e.target.value)}
                  />
                  <button
                    className={button}
                    onClick={() =>
                      void copyTextToClipboard(exportText)
                        .then(() => setCopied(true))
                        .catch((err) => setError(String(err)))
                    }
                  >
                    {copied ? 'Copied' : 'Copy redacted evidence'}
                  </button>
                  {review.workItemRef && review.decisions.length ? (
                    <button
                      className={button}
                      disabled={
                        busy ||
                        running ||
                        !!review.publications?.some(
                          (p) => p.decisionId === review.decisions.at(-1)!.id,
                        )
                      }
                      onClick={() =>
                        void action(() =>
                          window.anvil.changeReview.publish(
                            review.id,
                            review.decisions.at(-1)!.id,
                            exportText,
                          ),
                        )
                      }
                    >
                      Publish this text to Work Item
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </details>
          {review.publications?.map((p) => (
            <p key={p.id} className="text-xs text-text-secondary">
              Work Item publication: {p.status}.{' '}
              {p.status === 'uncertain' ? 'Check the provider before sharing again.' : ''}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
