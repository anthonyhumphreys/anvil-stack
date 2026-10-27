import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FactoryReceipt, FactoryRun, FactoryRunControlInput } from '../../../shared/factories';
import type {
  Persona,
  PublicWorkflowRun,
  RepoInfo,
  WorkflowNodeRunStatus,
  WorkspaceWithRepos,
} from '../../../shared/types';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cx } from '../ui/cx';
import { canReadRunSource } from './factory-ui-policy';
import {
  absoluteTime,
  formatDuration,
  isTerminal,
  nextStep,
  relativeTime,
  runBudgets,
  runPosition,
  shortSha,
  type FactoryRunState,
} from './factory-line';
import { RUN_STATE_META, RunJourney, RunStateIcon } from './FactoryLine';
import {
  Disclosure,
  ExternalAnchor,
  Field,
  Mono,
  Notice,
  TextAction,
  inputClass,
} from './FactoryPrimitives';
import { githubIdentity } from './factory-definition';

type RunAction = FactoryRunControlInput['action'];
export type TakeoverContext = NonNullable<FactoryRunControlInput['takeoverContext']>;

const CALLOUT_TONE: Record<FactoryRunState, string> = {
  live: 'border-accent/25 bg-accent/[0.04]',
  waiting: 'border-info/25 bg-info/[0.04]',
  'needs-you': 'border-warning/35 bg-warning/[0.07]',
  blocked: 'border-error/35 bg-error/[0.07]',
  paused: 'border-border bg-bg-secondary',
  cancelling: 'border-warning/30 bg-warning/[0.05]',
  done: 'border-success/30 bg-success/[0.05]',
  cancelled: 'border-border-subtle bg-bg-secondary',
  'handed-off': 'border-border-subtle bg-bg-secondary',
};

/** Polls the delegated workflow run while the Build station is live. Local executor only. */
function useWorkerRun(run: FactoryRun): PublicWorkflowRun | null {
  const [worker, setWorker] = useState<PublicWorkflowRun | null>(null);
  const id = !run.remote && run.workflowRunId ? run.workflowRunId : null;
  const position = runPosition(run);
  const live = position.state === 'live' && position.station === 'build';
  useEffect(() => {
    setWorker(null);
    if (!id) return;
    let current = true;
    const load = () =>
      window.anvil.workflow
        .getRun(id)
        .then((next) => {
          if (current) setWorker(next);
        })
        .catch(() => {
          if (current) setWorker(null);
        });
    void load();
    const timer = live ? window.setInterval(load, 4000) : undefined;
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [id, live]);
  return worker;
}

const NODE_STATUS: Record<
  WorkflowNodeRunStatus,
  { label: string; icon: LucideIcon | 'live'; className: string }
> = {
  waiting: { label: 'Waiting', icon: CircleDashed, className: 'text-text-tertiary' },
  queued: { label: 'Queued', icon: CircleDashed, className: 'text-text-tertiary' },
  interrupted: { label: 'Interrupted', icon: TriangleAlert, className: 'text-warning' },
  running: { label: 'Running', icon: 'live', className: 'text-accent' },
  completed: { label: 'Done', icon: Check, className: 'text-success' },
  failed: { label: 'Failed', icon: X, className: 'text-error' },
  skipped: { label: 'Skipped', icon: CircleDashed, className: 'text-text-tertiary' },
  cancelled: { label: 'Cancelled', icon: X, className: 'text-text-tertiary' },
};

function WorkerGraph({
  run,
  worker,
  now,
  onOpenThread,
  onOpenWorkflowRun,
}: {
  run: FactoryRun;
  worker: PublicWorkflowRun | null;
  now: number;
  onOpenThread: (threadId: string, personaId?: string) => void;
  onOpenWorkflowRun: (runId: string) => void;
}) {
  const nodes = run.snapshot.workflow.nodes;
  return (
    <div className="space-y-3">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2" aria-label="Pinned graph steps">
        {nodes.map((node, index) => {
          const state = worker?.nodeRuns.find((item) => item.nodeId === node.id);
          const meta = state ? NODE_STATUS[state.status] : null;
          const Icon = meta?.icon;
          return (
            <li key={node.id} className="flex items-center gap-1">
              {index > 0 && <ArrowRight size={12} aria-hidden="true" className="text-text-muted" />}
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs',
                  state?.status === 'running'
                    ? 'border-accent/40 bg-accent/[0.06] text-text-primary'
                    : 'border-border-subtle text-text-secondary',
                )}
              >
                {Icon === 'live' ? (
                  <span className="live-glyph live-glyph--sm" aria-hidden="true">
                    <span className="live-glyph-ring" />
                    <span className="live-glyph-dot" />
                  </span>
                ) : Icon ? (
                  <Icon size={12} aria-hidden="true" className={meta?.className} />
                ) : null}
                <span className="font-medium">{node.name}</span>
                <span className="text-text-tertiary">{node.model}</span>
                {meta && <span className="sr-only">{meta.label}</span>}
                {state?.status === 'running' && state.startedAt && (
                  <span className="text-text-tertiary tabular-nums">
                    {formatDuration(now - Date.parse(state.startedAt))}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {(run.workflowRunId || run.workerThreadId) && !run.remote ? (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {run.workflowRunId && (
            <TextAction icon={Workflow} onClick={() => onOpenWorkflowRun(run.workflowRunId!)}>
              Open run in Workflows
            </TextAction>
          )}
          {run.workerThreadId && (
            <TextAction
              icon={MessageSquare}
              onClick={() => onOpenThread(run.workerThreadId!, nodes[0]?.personaId)}
            >
              Open worker chat
            </TextAction>
          )}
        </div>
      ) : run.remote ? (
        <p className="text-xs text-text-tertiary">
          Worker transcripts stay on the executing device. Pick up the run to continue it yourself.
        </p>
      ) : null}
    </div>
  );
}

const RECEIPT_STATUS: Record<
  FactoryReceipt['status'],
  { label: string; icon: LucideIcon; className: string }
> = {
  intent: { label: 'In progress', icon: CircleDot, className: 'text-text-tertiary' },
  succeeded: { label: 'Succeeded', icon: Check, className: 'text-success' },
  uncertain: { label: 'Outcome unknown', icon: TriangleAlert, className: 'text-warning' },
  failed: { label: 'Failed', icon: X, className: 'text-error' },
};

const RECEIPT_KIND: Record<FactoryReceipt['kind'], string> = {
  checkout: 'Prepared checkout',
  workflow: 'Ran workflow',
  verify: 'Verified criteria',
  publish: 'Published PR',
  merge: 'Requested merge',
  'cancel-merge': 'Cancelled merge',
  'post-merge': 'Post-merge checks',
};

function Receipts({
  run,
  sourceAccess,
  now,
}: {
  run: FactoryRun;
  sourceAccess: boolean;
  now: number;
}) {
  const receipts = [...run.receipts].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  if (!receipts.length)
    return <p className="text-xs text-text-tertiary">No receipts recorded yet.</p>;
  return (
    <ol className="relative space-y-3 before:absolute before:top-1 before:bottom-1 before:left-[6.5px] before:w-px before:bg-border-subtle">
      {receipts.map((receipt) => {
        const status = RECEIPT_STATUS[receipt.status];
        const Icon = status.icon;
        return (
          <li key={receipt.id} className="relative flex gap-3 text-xs">
            <span className="relative z-10 mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-bg-primary">
              <Icon size={12} aria-hidden="true" className={status.className} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-text-primary">{RECEIPT_KIND[receipt.kind]}</span>
                <span className={status.className}>{status.label}</span>
                <time
                  className="ml-auto text-text-tertiary"
                  dateTime={receipt.updatedAt}
                  title={absoluteTime(receipt.updatedAt)}
                >
                  {relativeTime(receipt.updatedAt, now)}
                </time>
              </span>
              {sourceAccess && receipt.error && (
                <span className="mt-0.5 block break-words text-text-secondary">
                  {receipt.error}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Evidence({ evidence }: { evidence: NonNullable<FactoryRun['evidence']> }) {
  return (
    <div className="space-y-3">
      <ol className="space-y-2.5">
        {evidence.criteria.map((criterion, index) => {
          const command = evidence.commands[index];
          const Icon =
            criterion.status === 'passed' ? Check : criterion.status === 'failed' ? X : CircleAlert;
          const tone =
            criterion.status === 'passed'
              ? 'text-success'
              : criterion.status === 'failed'
                ? 'text-error'
                : 'text-warning';
          return (
            <li key={`${criterion.criterion}-${index}`} className="flex gap-2.5 text-xs">
              <Icon size={14} aria-hidden="true" className={cx('mt-0.5 shrink-0', tone)} />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words text-sm text-text-primary">{criterion.criterion}</p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-tertiary">
                  <span className={tone}>
                    {criterion.status === 'passed'
                      ? 'Passed'
                      : criterion.status === 'failed'
                        ? 'Failed'
                        : 'Blocked'}
                  </span>
                  {command && (
                    <>
                      <Mono>{command.command}</Mono>
                      <span>
                        {command.timedOut ? 'timed out' : `exit ${command.exitCode ?? 'unknown'}`}
                      </span>
                    </>
                  )}
                </p>
                {criterion.evidence && (
                  <p className="break-words text-text-secondary">{criterion.evidence}</p>
                )}
                {command?.output && (
                  <details className="group/output text-text-tertiary">
                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm py-0.5 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        size={12}
                        aria-hidden="true"
                        className="transition-transform duration-150 group-open/output:rotate-90 motion-reduce:transition-none"
                      />
                      Command output
                    </summary>
                    <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-secondary p-3 font-mono text-xs text-text-secondary">
                      {command.output}
                    </pre>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="font-mono text-xs text-text-tertiary">
        Commit {shortSha(evidence.headSha)} tree {shortSha(evidence.treeSha)}
      </p>
    </div>
  );
}

function PullRequestStatus({ run, now }: { run: FactoryRun; now: number }) {
  const observation = run.observation!;
  const required = run.snapshot.definition.merge.requiredChecks;
  const checks = observation.checks.filter((check) => check.headSha === observation.headSha);
  const stale = observation.checks.length - checks.length;
  return (
    <div className="space-y-3 text-xs">
      <ul className="space-y-1.5">
        {checks.map((check) => {
          const Icon =
            check.status === 'passed' ? Check : check.status === 'failed' ? X : LoaderCircle;
          const tone =
            check.status === 'passed'
              ? 'text-success'
              : check.status === 'failed'
                ? 'text-error'
                : 'text-info';
          return (
            <li key={`${check.name}-${check.headSha}`} className="flex items-center gap-2">
              <Icon size={13} aria-hidden="true" className={cx('shrink-0', tone)} />
              <Mono className="text-text-primary">{check.name}</Mono>
              {required.includes(check.name) && (
                <span className="text-text-tertiary">required</span>
              )}
              <span className={cx('ml-auto capitalize', tone)}>{check.status}</span>
            </li>
          );
        })}
        {required
          .filter((name) => !checks.some((check) => check.name === name))
          .map((name) => (
            <li key={name} className="flex items-center gap-2">
              <CircleDashed size={13} aria-hidden="true" className="shrink-0 text-text-tertiary" />
              <Mono className="text-text-primary">{name}</Mono>
              <span className="text-text-tertiary">required</span>
              <span className="ml-auto text-text-tertiary">Not reported</span>
            </li>
          ))}
      </ul>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-text-tertiary">
        <span>
          Review{' '}
          <span className="text-text-secondary">{observation.review.replaceAll('-', ' ')}</span>
        </span>
        <span>
          Head <Mono>{shortSha(observation.headSha)}</Mono>
        </span>
        <span>{observation.draft ? 'Draft' : 'Ready for review'}</span>
        <span title={absoluteTime(observation.observedAt)}>
          Observed {relativeTime(observation.observedAt, now)}
        </span>
        {stale > 0 && <span>{stale} older-head results ignored</span>}
      </p>
      {observation.feedback.length > 0 && (
        <ul className="space-y-1.5">
          {observation.feedback.map((item) => (
            <li key={item.id} className="rounded-lg bg-bg-secondary px-3 py-2 text-text-secondary">
              <span className="line-clamp-3 break-words">{item.body}</span>
              {item.url && (
                <span className="mt-1 block">
                  <ExternalAnchor href={item.url}>View on GitHub</ExternalAnchor>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PickupPanel({
  run,
  personas,
  workspaces,
  defaultWorkspaceId,
  busy,
  onCancel,
  onConfirm,
}: {
  run: FactoryRun;
  personas: Persona[];
  workspaces: Array<{ id: string; name: string }>;
  defaultWorkspaceId: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (context: TakeoverContext) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [workspace, setWorkspace] = useState<WorkspaceWithRepos | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState(
    personas.some((persona) => persona.id === 'coder') ? 'coder' : (personas[0]?.id ?? 'coder'),
  );
  const [repoId, setRepoId] = useState('');
  useEffect(() => {
    setRepoId('');
    setLoadError(null);
    if (!workspaceId) {
      setWorkspace(null);
      return;
    }
    let current = true;
    setLoading(true);
    window.anvil.workspace
      .get(workspaceId)
      .then((next) => {
        if (current) setWorkspace(next);
      })
      .catch((cause) => {
        if (!current) return;
        setWorkspace(null);
        setLoadError(
          cause instanceof Error ? cause.message : 'Could not load the selected workspace.',
        );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [workspaceId]);
  const source = run.snapshot.definition.github;
  const matching = useMemo<RepoInfo[]>(
    () =>
      (workspace?.repos ?? []).filter((repo) => {
        const local = githubIdentity(repo);
        return (
          local.host.toLowerCase() === source.host.toLowerCase() &&
          local.owner.toLowerCase() === source.owner.toLowerCase() &&
          local.repo.toLowerCase() === source.repo.toLowerCase()
        );
      }),
    [workspace, source],
  );
  return (
    <section
      aria-label="Pick up issue run"
      className="space-y-4 rounded-xl border border-border bg-bg-secondary p-4"
    >
      <div>
        <h3 className="text-sm font-semibold text-text-primary">
          Pick up this run in a private chat
        </h3>
        <p className="mt-1 max-w-prose text-xs leading-5 text-text-secondary">
          The run is claimed and paused first. Your chat starts with the issue, graph, branch and
          evidence. Nothing is sent and no agent turn starts until you write.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Your workspace">
          <select
            className={inputClass()}
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Agent">
          <select
            className={inputClass()}
            value={personaId}
            onChange={(event) => setPersonaId(event.target.value)}
          >
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Local checkout"
        hint={`Only a checkout of ${source.owner}/${source.repo} can be attached for code context.`}
      >
        <select
          className={inputClass()}
          value={repoId}
          disabled={loading || !workspaceId}
          onChange={(event) => setRepoId(event.target.value)}
        >
          <option value="">Snapshot only, no local checkout</option>
          {matching.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.name}
            </option>
          ))}
        </select>
      </Field>
      {loadError && (
        <Notice tone="error" icon={CircleAlert}>
          {loadError}
        </Notice>
      )}
      {workspaceId && !loading && !loadError && matching.length === 0 && (
        <Notice tone="warning" icon={TriangleAlert}>
          {workspace?.name ?? 'This workspace'} has no checkout of {source.owner}/{source.repo}. The
          chat gets the shared snapshot but cannot run commands against the code.
        </Notice>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || loading || !workspaceId || !personaId}
          onClick={() => onConfirm({ workspaceId, personaId, ...(repoId ? { repoId } : {}) })}
        >
          <MessageSquare size={13} aria-hidden="true" />
          {busy ? 'Claiming…' : 'Claim and open chat'}
        </Button>
      </div>
    </section>
  );
}

export function FactoryRunDetail({
  run,
  canOperate,
  busyAction,
  now,
  personas,
  workspaces,
  activeWorkspaceId,
  onAction,
  onOpenThread,
  onOpenWorkflowRun,
}: {
  run: FactoryRun;
  canOperate: boolean;
  busyAction: string | null;
  now: number;
  personas: Persona[];
  workspaces: Array<{ id: string; name: string }>;
  activeWorkspaceId: string;
  onAction: (action: RunAction, context?: TakeoverContext) => Promise<boolean>;
  onOpenThread: (threadId: string, personaId?: string) => void;
  onOpenWorkflowRun: (runId: string) => void;
}) {
  const [pickupOpen, setPickupOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const worker = useWorkerRun(run);
  useEffect(() => {
    setPickupOpen(false);
    setConfirmCancel(false);
  }, [run.id]);

  const sourceAccess = canReadRunSource(run);
  const position = runPosition(run);
  const step = nextStep(run);
  const terminal = isTerminal(run);
  const autoMerge = run.snapshot.definition.merge.mode === 'auto-merge';
  const head = run.observation?.headSha;
  const busy = busyAction !== null;
  const budgets = runBudgets(run, now);
  const primary =
    !canOperate || terminal ? null : run.stage === 'awaiting-merge-approval' && !autoMerge ? (
      <Button disabled={busy || !head} onClick={() => void onAction('approve-merge')}>
        <GitPullRequest size={14} aria-hidden="true" />
        {busyAction === 'approve-merge' ? 'Approving…' : `Approve merge at ${shortSha(head)}`}
      </Button>
    ) : run.stage === 'blocked' ? (
      <Button disabled={busy} onClick={() => void onAction('retry')}>
        <RotateCcw size={14} aria-hidden="true" />
        {busyAction === 'retry' ? 'Retrying…' : 'Retry'}
      </Button>
    ) : run.stage === 'paused' && !run.pendingControl ? (
      <Button disabled={busy} onClick={() => void onAction('resume')}>
        <Play size={14} aria-hidden="true" />
        {busyAction === 'resume' ? 'Resuming…' : 'Resume'}
      </Button>
    ) : null;

  return (
    <article aria-label="Factory run details" className="min-w-0 space-y-5 px-5 py-5 @container">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-tertiary">
          <span
            className={cx(
              'inline-flex items-center gap-1.5 font-medium',
              RUN_STATE_META[position.state].className,
            )}
          >
            <RunStateIcon state={position.state} size={13} />
            {RUN_STATE_META[position.state].label}
          </span>
          {sourceAccess && <span className="font-mono">#{run.issue.number}</span>}
          <span>Revision {run.revision}</span>
          <span title={absoluteTime(run.createdAt)}>
            Started {relativeTime(run.createdAt, now)}
          </span>
        </div>
        <h2 className="text-base font-semibold leading-snug text-balance text-text-primary">
          {sourceAccess ? run.issue.title : 'Source issue details are unavailable'}
        </h2>
        {sourceAccess && (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {run.issue.url && (
              <ExternalAnchor href={run.issue.url} icon={ExternalLink}>
                Issue #{run.issue.number}
              </ExternalAnchor>
            )}
            {run.pullRequest && (
              <ExternalAnchor href={run.pullRequest.url} icon={GitPullRequest}>
                PR #{run.pullRequest.number}
              </ExternalAnchor>
            )}
            {(run.pullRequest?.branch ?? run.checkout?.branch) && (
              <span className="text-xs text-text-tertiary">
                Branch <Mono>{run.pullRequest?.branch ?? run.checkout?.branch}</Mono>
              </span>
            )}
          </div>
        )}
      </header>

      <section
        aria-live="polite"
        className={cx(
          'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border px-4 py-3.5',
          CALLOUT_TONE[position.state],
        )}
      >
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold text-text-primary">{step.title}</p>
          <p className="mt-0.5 break-words text-xs leading-5 text-text-secondary">
            {sourceAccess || run.stage !== 'blocked'
              ? step.detail
              : 'The run stopped. Details need source access.'}
          </p>
        </div>
        {primary}
      </section>

      {run.pendingControl === 'cancel' && (
        <Notice tone="warning" icon={LoaderCircle}>
          Cancellation waits for GitHub to confirm that queued or automatic merge work is clear. The
          run is not cancelled until then.
        </Notice>
      )}
      {run.pendingControl === 'takeover' && !run.takeoverThreadId && (
        <Notice tone="warning" icon={LoaderCircle}>
          Pickup is waiting for the owner’s device to pause the live run. Your private chat appears
          here once the claimed snapshot arrives.
        </Notice>
      )}
      {run.takeoverThreadId && (
        <Notice
          tone="info"
          icon={MessageSquare}
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onOpenThread(run.takeoverThreadId!)}
            >
              Open pickup chat
            </Button>
          }
        >
          A private pickup chat is ready in your selected workspace.
        </Notice>
      )}

      <RunJourney run={run} />

      <dl className="grid grid-cols-3 gap-4">
        {budgets.map((budget) => (
          <div key={budget.id} className="min-w-0">
            <dt className="text-xs text-text-tertiary">{budget.label}</dt>
            <dd
              className={cx(
                'mt-0.5 text-sm tabular-nums',
                budget.tone === 'exhausted'
                  ? 'text-error'
                  : budget.tone === 'warning'
                    ? 'text-warning'
                    : 'text-text-primary',
              )}
            >
              {budget.value}
              {budget.tone !== 'normal' && (
                <span className="sr-only">
                  {budget.tone === 'exhausted' ? ', exhausted' : ', nearly used'}
                </span>
              )}
            </dd>
            <div className="factory-meter mt-1.5" data-tone={budget.tone} aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, budget.ratio)})` }} />
            </div>
          </div>
        ))}
      </dl>

      <div>
        <Disclosure
          title="Worker"
          meta={`${run.snapshot.workflow.name}, ${run.snapshot.workflow.nodes.length} ${run.snapshot.workflow.nodes.length === 1 ? 'step' : 'steps'}`}
          defaultOpen={position.station === 'build' && position.state === 'live'}
        >
          <WorkerGraph
            run={run}
            worker={worker}
            now={now}
            onOpenThread={onOpenThread}
            onOpenWorkflowRun={onOpenWorkflowRun}
          />
        </Disclosure>
        {sourceAccess && run.observation && (
          <Disclosure
            title="Pull request"
            meta={run.pullRequest ? `#${run.pullRequest.number}` : undefined}
            defaultOpen={['checks', 'merge'].includes(position.station) && !terminal}
          >
            <PullRequestStatus run={run} now={now} />
          </Disclosure>
        )}
        {sourceAccess && run.evidence && (
          <Disclosure
            title="Acceptance evidence"
            meta={run.evidence.passed ? 'All passed' : 'Needs attention'}
            defaultOpen={!run.evidence.passed}
          >
            <Evidence evidence={run.evidence} />
          </Disclosure>
        )}
        {sourceAccess && run.postMergeEvidence && (
          <Disclosure
            title="Post-merge evidence"
            meta={run.postMergeEvidence.passed ? 'Passed' : 'Needs attention'}
          >
            <Evidence evidence={run.postMergeEvidence} />
          </Disclosure>
        )}
        <Disclosure title="Receipts" meta={`${run.receipts.length}`}>
          <Receipts run={run} sourceAccess={sourceAccess} now={now} />
        </Disclosure>
        {sourceAccess && run.issue.body && (
          <Disclosure title="Issue description">
            <p className="max-w-prose whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
              {run.issue.body}
            </p>
          </Disclosure>
        )}
      </div>

      {canOperate && !terminal && !pickupOpen && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          {run.stage !== 'paused' && run.stage !== 'blocked' && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAction('pause')}
            >
              <Pause size={13} aria-hidden="true" />
              Pause
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || Boolean(run.pendingControl)}
            onClick={() => setPickupOpen(true)}
          >
            <MessageSquare size={13} aria-hidden="true" />
            Pick up in chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto hover:text-error"
            disabled={busy || run.pendingControl === 'cancel'}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel run
          </Button>
        </div>
      )}
      {canOperate && !terminal && pickupOpen && (
        <PickupPanel
          run={run}
          personas={personas}
          workspaces={workspaces}
          defaultWorkspaceId={activeWorkspaceId}
          busy={busyAction === 'takeover'}
          onCancel={() => setPickupOpen(false)}
          onConfirm={(context) => {
            void onAction('takeover', context).then((ok) => {
              if (ok) setPickupOpen(false);
            });
          }}
        />
      )}
      {!canOperate && !terminal && (
        <p className="border-t border-border-subtle pt-4 text-xs text-text-tertiary">
          You can follow this run. Operators and owners can pause, retry or pick it up.
        </p>
      )}

      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this issue run?"
        description={
          run.mergeReceipt
            ? 'A merge request is outstanding. Cancellation stays pending until GitHub confirms the merge work is clear; a merge that already won stays merged.'
            : 'The worker stops and the run will not publish or merge. Its branch and evidence remain for review.'
        }
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        tone="danger"
        loading={busyAction === 'cancel'}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          void onAction('cancel').then(() => setConfirmCancel(false));
        }}
      />
    </article>
  );
}
