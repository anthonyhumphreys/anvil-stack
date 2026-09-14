import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react';
import type {
  ApprovalRecord,
  ExecutionAttempt,
  HandoffRecord,
  JobState,
  JobSummary,
  SyncAttemptActivity,
  SyncDevice,
} from '../../../shared/sync-runtime';

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** §18 honest labeling: stopping-in-progress and lost contact never read as cancelled. */
function jobStateLabel(state: JobState): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'awaiting-approval':
      return 'Needs approval';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancel-requested':
      return 'Stopping…';
    case 'cancelled':
      return 'Cancelled';
    case 'unknown-outcome':
      return 'Lost contact — outcome unknown';
  }
}

function jobStateTone(state: JobState): string {
  switch (state) {
    case 'running':
      return 'text-accent';
    case 'awaiting-approval':
    case 'cancel-requested':
    case 'unknown-outcome':
      return 'text-warning';
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    default:
      return 'text-text-tertiary';
  }
}

const JOB_TERMINAL: ReadonlySet<JobState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown-outcome',
]);

const ATTEMPT_TERMINAL: ReadonlySet<ExecutionAttempt['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'unknown-outcome',
]);

const ACTIVITY_TAIL = 120;

export function RemoteExecutionsPanel({ devices }: { devices: SyncDevice[] }): ReactNode {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, ExecutionAttempt[]>>({});
  const [approvalsByJob, setApprovalsByJob] = useState<Record<string, ApprovalRecord[]>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [observingAttemptId, setObservingAttemptId] = useState<string | null>(null);
  const [activity, setActivity] = useState<SyncAttemptActivity[]>([]);
  const activityRef = useRef<HTMLDivElement>(null);

  const deviceName = useCallback(
    (enrollmentId: string | undefined): string => {
      if (enrollmentId === undefined) return 'unplaced';
      const device = devices.find((d) => d.enrollmentId === enrollmentId);
      const base = device?.displayName ?? `device ${enrollmentId.slice(0, 8)}`;
      return device?.self === true ? `${base} (this device)` : base;
    },
    [devices],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [jobsNext, handoffsNext] = await Promise.all([
        window.anvil.syncRuntime.listMeshJobs(),
        window.anvil.syncRuntime.listMeshHandoffs(),
      ]);
      setJobs(jobsNext);
      setHandoffs(handoffsNext);
      setRefreshedAt(new Date().toLocaleTimeString());
      if (expandedJobId !== null) {
        const [detail, approvals] = await Promise.all([
          window.anvil.syncRuntime.getMeshJob(expandedJobId),
          window.anvil.syncRuntime.getMeshApprovals(expandedJobId),
        ]);
        setAttemptsByJob((prev) => ({ ...prev, [expandedJobId]: detail.attempts }));
        setApprovalsByJob((prev) => ({ ...prev, [expandedJobId]: approvals }));
      }
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [expandedJobId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const handleExpand = async (jobId: string): Promise<void> => {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      return;
    }
    setExpandedJobId(jobId);
    setError(null);
    try {
      const [detail, approvals] = await Promise.all([
        window.anvil.syncRuntime.getMeshJob(jobId),
        window.anvil.syncRuntime.getMeshApprovals(jobId),
      ]);
      setAttemptsByJob((prev) => ({ ...prev, [jobId]: detail.attempts }));
      setApprovalsByJob((prev) => ({ ...prev, [jobId]: approvals }));
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  const handleCancel = async (jobId: string): Promise<void> => {
    setBusyKey(`cancel:${jobId}`);
    setError(null);
    try {
      await window.anvil.syncRuntime.cancelMeshJob(jobId);
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleDecide = async (jobId: string, approvalId: string, decision: 'approved' | 'denied') => {
    setBusyKey(`approval:${approvalId}`);
    setError(null);
    try {
      await window.anvil.syncRuntime.decideMeshApproval(approvalId, decision);
      const [detail, approvals] = await Promise.all([
        window.anvil.syncRuntime.getMeshJob(jobId),
        window.anvil.syncRuntime.getMeshApprovals(jobId),
      ]);
      setAttemptsByJob((prev) => ({ ...prev, [jobId]: detail.attempts }));
      setApprovalsByJob((prev) => ({ ...prev, [jobId]: approvals }));
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyKey(null);
    }
  };

  // Observe/unobserve the live attempt stream — paired with the IPC
  // subscription the service holds per sender.
  useEffect(() => {
    if (observingAttemptId === null) return;
    setActivity([]);
    const unsubscribe = window.anvil.syncRuntime.observeAttemptActivity(
      observingAttemptId,
      (item) => {
        setActivity((prev) => {
          const next = [...prev, item];
          return next.length > ACTIVITY_TAIL ? next.slice(next.length - ACTIVITY_TAIL) : next;
        });
      },
    );
    return unsubscribe;
  }, [observingAttemptId]);

  useEffect(() => {
    activityRef.current?.scrollTo({ top: activityRef.current.scrollHeight });
  }, [activity]);

  const targetLabel = (job: JobSummary): string => {
    if (job.targetEnrollmentId !== undefined) {
      return deviceName(job.targetEnrollmentId);
    }
    if (job.requestedTarget.kind === 'device') {
      return deviceName(job.requestedTarget.enrollmentId);
    }
    return 'auto-placement pending';
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-tertiary">
          {refreshedAt === null ? 'Loading…' : `Refreshed ${refreshedAt}`}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {jobs === null ? (
        <p className="flex items-center gap-2 text-sm text-text-tertiary">
          <Loader2 size={14} className="animate-spin" /> Loading jobs…
        </p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-text-tertiary">No remote executions on this account yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {jobs.map((job) => (
            <li key={job.id} className="rounded-md border border-border">
              <button
                type="button"
                onClick={() => void handleExpand(job.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-tertiary/50"
              >
                {expandedJobId === job.id ? (
                  <ChevronDown size={14} className="shrink-0 text-text-tertiary" />
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-text-tertiary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">
                    {job.kind} · {job.id.slice(0, 8)}…
                  </span>
                  <span className="block text-xs text-text-tertiary">
                    {deviceName(job.sourceEnrollmentId)} → {targetLabel(job)}
                    {job.placementExplanation ? ` · ${job.placementExplanation}` : ''}
                  </span>
                </span>
                <span className={`shrink-0 text-xs ${jobStateTone(job.state)}`}>
                  {jobStateLabel(job.state)}
                </span>
              </button>

              {expandedJobId === job.id && (
                <div className="space-y-3 border-t border-border-subtle px-3 py-2.5">
                  {(attemptsByJob[job.id] ?? []).length === 0 ? (
                    <p className="text-xs text-text-tertiary">No attempts yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {(attemptsByJob[job.id] ?? []).map((attempt) => (
                        <li
                          key={attempt.id}
                          className="rounded-md border border-border-subtle bg-bg-primary/50 px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-mono text-xs text-text-secondary">
                              attempt {attempt.id.slice(0, 8)}… · {attempt.state}
                            </p>
                            {!ATTEMPT_TERMINAL.has(attempt.state) && (
                              <button
                                type="button"
                                onClick={() =>
                                  setObservingAttemptId(
                                    observingAttemptId === attempt.id ? null : attempt.id,
                                  )
                                }
                                className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              >
                                {observingAttemptId === attempt.id ? (
                                  <EyeOff size={11} />
                                ) : (
                                  <Eye size={11} />
                                )}
                                {observingAttemptId === attempt.id ? 'Hide' : 'Watch'}
                              </button>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-text-tertiary">
                            lease until {new Date(attempt.leaseExpiresAt).toLocaleTimeString()} ·
                            worker {attempt.workerIncarnation.slice(0, 8)}…
                          </p>
                          {observingAttemptId === attempt.id && (
                            <div
                              ref={activityRef}
                              className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border bg-bg-primary p-2 font-mono text-xs leading-relaxed text-text-secondary"
                            >
                              {activity.length === 0 ? (
                                <p className="text-text-tertiary">
                                  Listening — durable replay fills history, live frames append…
                                </p>
                              ) : (
                                activity.map((item, index) => (
                                  <div key={`${item.sequence}:${index}`}>
                                    {item.gapBefore && (
                                      <p className="my-1 border-y border-dashed border-warning/40 py-0.5 text-center text-[10px] text-warning">
                                        gap in stream — replay may still be filling it
                                      </p>
                                    )}
                                    <p
                                      className={
                                        item.kind === 'stderr'
                                          ? 'text-error'
                                          : item.kind === 'status'
                                            ? 'text-text-tertiary'
                                            : ''
                                      }
                                    >
                                      {item.text}
                                    </p>
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {(approvalsByJob[job.id] ?? []).length > 0 && (
                    <ul className="space-y-1.5">
                      {(approvalsByJob[job.id] ?? []).map((approval) => (
                        <li
                          key={approval.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5"
                        >
                          <p className="min-w-0 text-xs text-text-secondary">
                            <span className="font-medium text-text-primary">
                              {approval.state === 'pending' ? 'Approval requested' : approval.state}
                            </span>{' '}
                            · {approval.actionDigest.slice(0, 12)}… · expires{' '}
                            {new Date(approval.expiresAt).toLocaleTimeString()}
                          </p>
                          {approval.state === 'pending' && (
                            <span className="flex shrink-0 gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  void handleDecide(job.id, approval.id, 'approved')
                                }
                                disabled={busyKey === `approval:${approval.id}`}
                                className="flex items-center gap-1 rounded-md bg-success/15 px-2 py-1 text-xs font-medium text-success transition-colors hover:bg-success/25 disabled:opacity-50"
                              >
                                <CheckCircle2 size={11} /> Approve
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDecide(job.id, approval.id, 'denied')}
                                disabled={busyKey === `approval:${approval.id}`}
                                className="flex items-center gap-1 rounded-md bg-error/15 px-2 py-1 text-xs font-medium text-error transition-colors hover:bg-error/25 disabled:opacity-50"
                              >
                                <XCircle size={11} /> Deny
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {!JOB_TERMINAL.has(job.state) && (
                    <button
                      type="button"
                      onClick={() => void handleCancel(job.id)}
                      disabled={busyKey === `cancel:${job.id}` || job.state === 'cancel-requested'}
                      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-error disabled:opacity-50"
                    >
                      <Square size={10} className="fill-current" />
                      {job.state === 'cancel-requested'
                        ? 'Stop already requested'
                        : busyKey === `cancel:${job.id}`
                          ? 'Stopping…'
                          : 'Stop job'}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {handoffs.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
            Session handoffs
          </p>
          <ul className="space-y-1.5">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 text-sm text-text-primary">
                    {deviceName(handoff.sourceEnrollmentId)} →{' '}
                    {deviceName(handoff.targetEnrollmentId)}
                  </p>
                  <span className="shrink-0 text-xs text-text-tertiary">{handoff.state}</span>
                </div>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  session {handoff.sessionId.slice(0, 8)}… · generation{' '}
                  {handoff.targetGeneration ?? handoff.sourceGeneration}
                  {handoff.checkpoint !== null &&
                    ' · target resumes from a checkpoint — no live process migrates'}
                </p>
                {handoff.cancelReason !== null && (
                  <p className="mt-0.5 text-xs text-warning">
                    cancelled from {handoff.cancelledFrom}: {handoff.cancelReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error !== null && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
