import type { CodexEvent } from '../../../shared/types';
import type { ChatTurnWorkItem } from './chat-turns';

export type ProcessingState = 'working' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'ended';
export type OperationStatus = 'running' | 'completed' | 'failed' | 'recorded';

export function getOperationStatus(event: CodexEvent, active: boolean): OperationStatus {
  if (event.toolStatus === 'failed') return 'failed';
  if (event.type === 'command_exec' && typeof event.exitCode === 'number') {
    return event.exitCode === 0 ? 'completed' : 'failed';
  }
  if (event.toolStatus === 'completed') return 'completed';
  return active ? 'running' : 'recorded';
}

export function getProcessingState({
  items,
  busy,
  outcome,
  waiting = false,
}: {
  items: readonly ChatTurnWorkItem[];
  busy: boolean;
  outcome?: CodexEvent['turnOutcome'];
  waiting?: boolean;
}): ProcessingState {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'failed') return 'failed';
  if (outcome === 'interrupted') return 'stopped';
  const events = items.flatMap((item) => (item.kind === 'event' ? [item.event] : []));
  const threadStatus = events.findLast((event) => event.type === 'thread_status');
  if (
    waiting ||
    threadStatus?.threadActiveFlags?.some(
      (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
    )
  )
    return 'waiting';
  const status = events.findLast((event) => event.type === 'status');
  if (status?.status === 'error') return 'failed';
  // A replayed inProgress item is observation, not evidence of a live run.
  return busy ? 'working' : 'ended';
}

export function countProcessingActions(items: readonly ChatTurnWorkItem[]) {
  let actions = 0;
  let failed = 0;
  for (const item of items) {
    if (item.kind !== 'event') continue;
    const event = item.event;
    if (['tool_call', 'command_exec', 'file_edit', 'subagent_update'].includes(event.type))
      actions++;
    if (
      event.type === 'error' ||
      getOperationStatus(event, false) === 'failed' ||
      (event.type === 'subagent_update' && event.subagent?.status === 'failed')
    )
      failed++;
  }
  return { actions, failed };
}

export function formatProcessingElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
