import type { AutomationRunStatus, AutomationTriageItem, WorkflowRunStatus } from './types';

/** The workflow owns its outstanding decision even after its launcher returns. */
export function deliveryNextAction(
  status: AutomationRunStatus,
  retainedWorktreeCount: number,
  workflowStatus?: WorkflowRunStatus,
): Pick<AutomationTriageItem, 'attention' | 'nextAction'> {
  if (workflowStatus === 'paused')
    return { attention: 'decision', nextAction: 'Open workflow to answer the pending decision' };
  if (workflowStatus === 'failed' || workflowStatus === 'cancelled')
    return { attention: 'blocked', nextAction: 'Open workflow to inspect and recover the attempt' };
  if (workflowStatus === 'running' || workflowStatus === 'queued')
    return { attention: 'running', nextAction: 'Open workflow to inspect current progress' };
  if (status === 'failed')
    return { attention: 'blocked', nextAction: 'Inspect the failure and retry when resolved' };
  if (status === 'running' || status === 'queued')
    return { attention: 'running', nextAction: 'Inspect current progress' };
  return {
    attention: 'changes',
    nextAction: retainedWorktreeCount
      ? 'Review the retained candidate and record an evidence decision'
      : 'Inspect the result; candidate evidence is unavailable',
  };
}
