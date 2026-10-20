import { useState, useCallback, useEffect, useRef, useId, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FileText,
  FileDiff,
  ExternalLink,
  Terminal,
  Wrench,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Copy,
  GitBranch,
  RefreshCw,
  Pencil,
  Sparkles,
  Image as ImageIcon,
  Circle,
  CheckCircle2,
  ListChecks,
  Target,
  Users,
  MessageSquare,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type {
  ChatAttachment,
  ChatFollowUpIntent,
  ChatPlanStep,
  CodexEvent,
} from '../../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { DiffViewer } from './DiffViewer';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { copyTextToClipboard } from '../../utils/clipboard';
import { isAbsoluteEditorPath } from '../../../shared/editor-file-link';
import { buildApprovalAwareWorkSegments, type ChatTurnWorkItem } from './chat-turns';
import { agentEventLabel } from '../../utils/agent-display';
import { AgentUIIntentSurface } from './AgentUIIntentSurface';
import { useChatRequest } from './useChatRequest';
import { MessageStreamingContext } from './surface-fences';
import { FileEditReviewGrid } from './TurnChangesFooter';
import { LiveGlyph, ProcessingCard, useProcessingActive } from './ProcessingCard';
import {
  countProcessingActions,
  getOperationStatus,
  getProcessingState,
  type ProcessingState,
} from './processing-state';
import { displayCommand } from '../../utils/command-display';
import { buildChatRequestTargetDomId, getChatQuestionTargetId } from './chat-run-outcome';
import {
  ChatAssistantMessageActions,
  ChatAssistantMessageBody,
  ChatAssistantMessageFrame,
  ChatAssistantMessageHeader,
  ChatMessageRow,
  ChatUserMessageActions,
  ChatUserMessageFrame,
  ChatUserMessageHeader,
  ChatUserMessageSurface,
} from './shared/ChatPresentation';

interface ChatEventProps {
  event: CodexEvent & { sessionId?: string };
}

export function ChatEventRenderer({ event }: ChatEventProps) {
  const requestTarget = getChatQuestionTargetId(event);
  if (requestTarget) {
    return (
      <div
        id={buildChatRequestTargetDomId(requestTarget)}
        tabIndex={-1}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <ChatEventContent event={event} />
      </div>
    );
  }
  return <ChatEventContent event={event} />;
}

function ChatEventContent({ event }: ChatEventProps) {
  switch (event.type) {
    case 'text':
      return <TextEvent text={event.text ?? ''} />;
    case 'file_edit':
      return (
        <FileEditEvent
          filePath={event.filePath ?? ''}
          diff={event.diff ?? ''}
          agentLabel={agentEventLabel(event)}
        />
      );
    case 'command_exec':
      return (
        <CommandExecEvent
          command={event.command ?? ''}
          output={event.output ?? ''}
          exitCode={event.exitCode}
          toolStatus={event.toolStatus}
        />
      );
    case 'tool_call':
      return <ToolCallEvent event={event} />;
    case 'approval_request':
      return <ApprovalRequestEvent event={event} />;
    case 'input_request':
      return <InputRequestEvent event={event} />;
    case 'subagent_update':
      return <SubagentUpdateEvent event={event} />;
    case 'thread_status':
      return <ThreadStatusEvent event={event} />;
    case 'plan_update':
      return event.plan ? <PlanUpdateEvent plan={event.plan} /> : null;
    case 'agent_ui_intent':
      return event.agentUIIntent ? <AgentUIIntentSurface intent={event.agentUIIntent} /> : null;
    case 'agent_ui_intent_resolved':
      return null;
    case 'goal_update':
      return event.goal ? <GoalUpdateEvent goal={event.goal} /> : null;
    case 'goal_cleared':
      return <GoalClearedEvent />;
    case 'error':
      return <ErrorEvent message={event.errorMessage ?? 'Unknown error'} />;
    case 'status':
      return <StatusEvent status={event.status ?? 'executing'} />;
    case 'context_compaction':
      return (
        <p className="text-xs text-text-secondary">
          {event.toolStatus === 'completed' ? 'Context compacted' : 'Context compaction'}
        </p>
      );
    default:
      return null;
  }
}

function ApprovalAwareWorkTimeline({
  segments,
}: {
  segments: ReturnType<typeof buildApprovalAwareWorkSegments>;
}) {
  return (
    <div className="space-y-2 border-t border-border-subtle px-3 py-3" data-approval-work-timeline>
      {segments.map((segment) =>
        segment.kind === 'approval' ? (
          <ChatEventRenderer key={segment.key} event={segment.item.event} />
        ) : (
          <RoutineWorkSegment key={segment.key} segment={segment} />
        ),
      )}
    </div>
  );
}

function RoutineWorkSegment({
  segment,
}: {
  segment: Extract<ReturnType<typeof buildApprovalAwareWorkSegments>[number], { kind: 'routine' }>;
}) {
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? segment.expandedByDefault;
  const detailsId = useId();
  const summary = segment.items
    .map((item) => formatTurnWorkItemSummary(item))
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="border-y border-border-subtle/70">
      <button
        type="button"
        onClick={() => setExpandedOverride(!expanded)}
        className="flex min-h-9 w-full items-center gap-2 px-1 py-1.5 text-left text-xs transition-colors hover:bg-bg-secondary/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-expanded={expanded}
        aria-controls={detailsId}
      >
        <span className="shrink-0 text-text-tertiary">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Wrench size={12} className="shrink-0 text-text-tertiary" />
        <span className="font-medium text-text-secondary">Work</span>
        <span className="min-w-0 flex-1 truncate text-text-tertiary">{summary}</span>
      </button>
      {expanded && (
        <div id={detailsId} className="space-y-3 border-t border-border-subtle/70 px-2 py-3">
          {segment.items.map((item, index) => (
            <TurnWorkItemDetail key={workItemKey(item, index)} item={item} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

function TurnWorkItemDetail({ item, index }: { item: ChatTurnWorkItem; index: number }) {
  if (item.kind === 'progress') {
    return (
      <div className="pr-2">
        <p className="mb-1 text-xs font-medium text-text-muted">Progress update</p>
        <div className="max-w-[72ch] break-words text-text-secondary">
          <MarkdownRenderer content={item.content} />
        </div>
      </div>
    );
  }

  if (item.kind === 'thinking') {
    return (
      <div
        data-work-reasoning
        className="border-l border-border-subtle py-0.5 pl-3 pr-2 text-xs italic leading-relaxed text-text-tertiary"
      >
        <p className="mb-1 text-xs font-medium not-italic text-text-muted">Reasoning</p>
        <p className="whitespace-pre-wrap break-words">{item.content}</p>
      </div>
    );
  }

  return <ChatEventRenderer key={workItemKey(item, index)} event={item.event} />;
}

function workItemKey(item: ChatTurnWorkItem, index: number): string {
  if (item.kind !== 'event') return `${item.kind}-${item.sourceIndex}`;
  return buildActivityEventKey(item.event, index);
}

export function ActivityGroupMessage({
  events,
}: {
  events: Array<CodexEvent & { sessionId?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const detailsId = useId();
  const summary = summarizeActivityEvents(events);
  const hasApprovalHistory = events.some((event) => event.type === 'approval_request');
  const surfaceEvents = events.flatMap((event, index) =>
    isSurfaceEvent(event) && event.type !== 'approval_request' ? [{ event, index }] : [],
  );
  const surfaceEventIndexes = new Set(surfaceEvents.map(({ index }) => index));
  const approvalTimeline = buildApprovalAwareWorkSegments(
    events.flatMap((event, sourceIndex) =>
      surfaceEventIndexes.has(sourceIndex) ? [] : [{ kind: 'event' as const, event, sourceIndex }],
    ),
  );
  const fileEdits = events.filter((event) => event.type === 'file_edit' && event.filePath);
  const failedCommands = events.filter(
    (event) =>
      (event.type === 'command_exec' &&
        typeof event.exitCode === 'number' &&
        event.exitCode !== 0) ||
      (event.type === 'tool_call' && event.toolStatus === 'failed') ||
      event.type === 'error',
  );
  const preview = events
    .slice(-3)
    .map(formatActivityPreview)
    .filter((value): value is string => Boolean(value))
    .join(' \u2022 ');

  return (
    <div className="message-bubble flex justify-start">
      <div className="w-full border-y border-border-subtle bg-bg-secondary/25">
        {hasApprovalHistory ? (
          <div className="flex w-full items-start gap-2 px-3 py-2.5 text-left">
            <Wrench size={12} className="mt-0.5 shrink-0 text-text-tertiary" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-text-secondary">Activity</span>
                <span className="text-xs text-text-tertiary">{summary}</span>
                {failedCommands.length > 0 && (
                  <span className="rounded-full bg-error/10 px-2 py-0.5 text-eyebrow font-medium text-error">
                    {failedCommands.length} failed
                  </span>
                )}
              </div>
              {preview && <p className="truncate pt-1 text-xs text-text-tertiary">{preview}</p>}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg-tertiary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            <span className="mt-0.5 shrink-0 text-text-tertiary">
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <Wrench size={12} className="mt-0.5 shrink-0 text-text-tertiary" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium text-text-secondary">Activity</span>
                <span className="text-xs text-text-tertiary">{summary}</span>
                {failedCommands.length > 0 && (
                  <span className="rounded-full bg-error/10 px-2 py-0.5 text-eyebrow font-medium text-error">
                    {failedCommands.length} failed
                  </span>
                )}
              </div>
              {!expanded && preview && (
                <p className="truncate pt-1 text-xs text-text-tertiary">{preview}</p>
              )}
            </div>
          </button>
        )}
        {surfaceEvents.length > 0 && (
          <div
            className="space-y-2 border-t border-border-subtle px-3 py-3"
            role="region"
            aria-label="Requests and structured updates"
          >
            {surfaceEvents.map(({ event, index }) => (
              <ChatEventRenderer key={buildActivityEventKey(event, index)} event={event} />
            ))}
          </div>
        )}
        {hasApprovalHistory && <ApprovalAwareWorkTimeline segments={approvalTimeline} />}
        {fileEdits.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-2">
            <button
              type="button"
              onClick={() => setReviewOpen((open) => !open)}
              className="inline-flex items-center gap-1.5 rounded-md border border-info/30 bg-info/10 px-2.5 py-1 text-xs font-medium text-info transition-colors hover:bg-info/15"
            >
              <FileDiff size={12} />
              {reviewOpen ? 'Hide review' : 'Review changes'}
            </button>
            <span className="text-xs text-text-tertiary">
              {fileEdits.length} edited file{fileEdits.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
        {reviewOpen && (
          <FileEditReviewGrid
            edits={fileEdits.map((event) => ({
              filePath: event.filePath ?? '',
              diff: event.diff ?? '',
            }))}
            agentLabel={fileEdits[0]?.agentLabel ?? events[0]?.agentLabel}
          />
        )}
        {!hasApprovalHistory && (
          <div id={detailsId} hidden={!expanded}>
            {expanded && (
              <div className="max-h-96 space-y-2 overflow-auto border-t border-border-subtle p-3">
                {events.map((event, index) =>
                  surfaceEventIndexes.has(index) ? null : (
                    <ChatEventRenderer key={buildActivityEventKey(event, index)} event={event} />
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function TurnWorkMessage({
  items,
  active = false,
  outcome,
  waiting = false,
  answering = false,
  startedAt,
  endedAt,
}: {
  items: ChatTurnWorkItem[];
  active?: boolean;
  outcome?: CodexEvent['turnOutcome'];
  waiting?: boolean;
  /** The answer is streaming; the reply header carries the live indicator. */
  answering?: boolean;
  startedAt?: string;
  endedAt?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const resolvedTargets = new Set(
    items.flatMap((item) => {
      if (item.kind !== 'event' || item.event.type !== 'request_resolved') return [];
      const id = item.event.resolvedRequestId;
      if (id === undefined) return [];
      return [
        getChatQuestionTargetId({ ...item.event, type: 'approval_request', approvalRequestId: id }),
        getChatQuestionTargetId({ ...item.event, type: 'input_request', inputRequestId: id }),
      ];
    }),
  );
  const state = getProcessingState({ items, busy: active, outcome, waiting, answering });
  const liveSteps = state === 'working';
  const counts = countProcessingActions(items);
  const latest = [...items]
    .reverse()
    .find(
      (item) =>
        item.kind !== 'event' ||
        (!['request_resolved', 'agent_ui_intent_resolved'].includes(item.event.type) &&
          !resolvedTargets.has(getChatQuestionTargetId(item.event))),
    );
  const detail = formatTurnWorkItemSummary(latest, state === 'working') || IDLE_DETAIL[state];
  if (items.length === 0 && !active && !waiting && !outcome) return null;

  return (
    <ProcessingCard
      state={state}
      detail={detail}
      actions={counts.actions}
      failed={counts.failed}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      startedAt={startedAt}
      endedAt={endedAt}
    >
      {items.map((item, position) => {
        // The composer owns question input. Completed receipts render in the conversation.
        if (
          item.kind === 'event' &&
          item.event.type === 'agent_ui_intent' &&
          item.event.agentUIIntent?.kind === 'question'
        )
          return null;
        if (
          item.kind === 'event' &&
          (['request_resolved', 'agent_ui_intent_resolved'].includes(item.event.type) ||
            resolvedTargets.has(getChatQuestionTargetId(item.event)))
        )
          return null;
        const surfaced = item.kind === 'event' && isSurfaceEvent(item.event);
        return (
          <div
            key={workItemKey(item, item.sourceIndex)}
            className="processing-item"
            hidden={!expanded && !surfaced}
            data-step-status={
              item.kind === 'event' && STEP_OPERATION_TYPES.has(item.event.type)
                ? getOperationStatus(item.event, liveSteps)
                : undefined
            }
            style={{ '--step-index': position } as CSSProperties}
          >
            {(expanded || surfaced) && <TurnWorkItemDetail item={item} index={item.sourceIndex} />}
          </div>
        );
      })}
    </ProcessingCard>
  );
}

/** Card detail when the turn has no activity to summarise yet (or at all). */
const IDLE_DETAIL: Record<ProcessingState, string> = {
  working: 'Preparing the next step',
  waiting: 'Waiting for you',
  answering: 'Writing the response',
  completed: 'Answered directly',
  failed: 'No actions recorded',
  stopped: 'No actions recorded',
  ended: 'No actions recorded',
};

/** Rows whose timeline dot reflects an outcome; others stay neutral. */
const STEP_OPERATION_TYPES = new Set<CodexEvent['type']>([
  'tool_call',
  'command_exec',
  'file_edit',
]);

export type TurnActivityState = 'thinking' | 'working' | 'responding';

export function TurnActivityStatus({
  state,
  latestItem,
}: {
  state: TurnActivityState;
  latestItem?: ChatTurnWorkItem;
}) {
  const timerRef = useRef<HTMLSpanElement>(null);
  const startedAtRef = useRef(Date.now());
  const detail =
    state === 'thinking'
      ? 'Preparing the next step'
      : state === 'responding'
        ? 'Writing the response'
        : formatTurnWorkItemSummary(latestItem) || 'Running the next action';

  useEffect(() => {
    const update = () => {
      if (timerRef.current) {
        timerRef.current.textContent = formatElapsedTime(Date.now() - startedAtRef.current);
      }
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div
      className="message-bubble flex w-full justify-start"
      role="status"
      aria-live="polite"
      aria-label={`Anvil is working. ${detail}.`}
    >
      <div className="flex min-h-11 w-full items-center gap-2.5 border-y border-accent/20 bg-accent/[0.035] px-1 py-2.5">
        <WorkingDots />
        <div className="min-w-0 flex-1 text-xs">
          <span className="font-semibold text-text-primary">Anvil is working</span>
          <span className="text-text-tertiary"> · {detail}</span>
        </div>
        <span
          ref={timerRef}
          className="shrink-0 font-mono text-xs tabular-nums text-text-muted"
          aria-hidden="true"
        >
          0s
        </span>
      </div>
    </div>
  );
}

export function shouldShowTurnWorkDetails(
  _active: boolean,
  expandedOverride: boolean | null,
): boolean {
  return expandedOverride ?? false;
}

function WorkingDots({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`working-dots ${compact ? 'working-dots--compact' : ''}`} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function formatTurnWorkItemSummary(
  item: ChatTurnWorkItem | undefined,
  active = true,
): string {
  if (!item) return '';
  if (item.kind === 'progress') return summarizeProgress(item.content);
  if (item.kind === 'thinking') return 'Reasoning through the next step';

  switch (item.event.type) {
    case 'command_exec':
      if (item.event.command && typeof item.event.exitCode === 'number') {
        return item.event.exitCode === 0
          ? `Completed ${compactWorkValue(displayCommand(item.event.command), 84)}`
          : `Command failed (${item.event.exitCode}): ${compactWorkValue(displayCommand(item.event.command), 72)}`;
      }
      return item.event.command
        ? `${active ? 'Running' : 'Command:'} ${compactWorkValue(displayCommand(item.event.command), 84)}`
        : 'Reading command output';
    case 'file_edit':
      return item.event.filePath
        ? `Edited ${compactWorkValue(item.event.filePath, 84)}`
        : 'Edited files';
    case 'tool_call':
      if (item.event.toolStatus === 'failed') {
        return item.event.toolName ? `Tool failed: ${item.event.toolName}` : 'Tool failed';
      }
      if (item.event.toolStatus === 'completed') {
        return item.event.toolName ? `Finished ${item.event.toolName}` : 'Finished a tool call';
      }
      return item.event.toolName
        ? `${active ? 'Using' : 'Tool:'} ${item.event.toolName}`
        : 'Tool activity';
    case 'approval_request':
      return 'Waiting for approval';
    case 'input_request':
      return 'Waiting for your input';
    case 'subagent_update':
      return item.event.subagent?.status === 'failed'
        ? 'Agent work failed'
        : item.event.subagent?.status === 'completed'
          ? 'Agent work completed'
          : 'Coordinating agent work';
    case 'thread_status':
      if (item.event.threadActiveFlags?.includes('waitingOnUserInput'))
        return 'Waiting for your input';
      if (item.event.threadActiveFlags?.includes('waitingOnApproval'))
        return 'Waiting for approval';
      return 'Thread status updated';
    case 'plan_update':
      return 'Updating the plan';
    case 'agent_ui_intent':
      if (item.event.agentUIIntent?.kind === 'surface') {
        return `Published ${compactWorkValue(item.event.agentUIIntent.payload.title, 84)}`;
      }
      return item.event.agentUIIntent?.kind === 'question'
        ? 'Waiting for your input'
        : 'Updating the plan';
    case 'agent_ui_intent_resolved':
      return 'Resuming after input';
    case 'status':
      return item.event.status === 'complete'
        ? 'Work complete'
        : item.event.status === 'error'
          ? 'Work stopped with an error'
          : item.event.status === 'thinking'
            ? 'Preparing the next step'
            : 'Running the next action';
    case 'goal_update':
      return item.event.goal?.objective
        ? `Goal: ${compactWorkValue(item.event.goal.objective, 84)}`
        : 'Updating the goal';
    case 'goal_cleared':
      return 'Goal cleared';
    case 'context_compaction':
      return item.event.toolStatus === 'completed' ? 'Context compacted' : 'Compacting context';
    case 'error':
      return item.event.errorMessage
        ? `Error: ${compactWorkValue(item.event.errorMessage, 84)}`
        : 'Handling an error';
    default:
      return 'Processing the latest activity';
  }
}

function summarizeProgress(content: string): string {
  const plainText = content
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+)/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return compactWorkValue(plainText, 110) || 'Processing the latest update';
}

function compactWorkValue(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  const prefix = compact.slice(0, maxLength - 1);
  const lastSpace = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, lastSpace > maxLength * 0.6 ? lastSpace : prefix.length).trimEnd()}…`;
}

function isSurfaceEvent(event: CodexEvent): boolean {
  return (
    event.type === 'approval_request' ||
    event.type === 'input_request' ||
    event.type === 'agent_ui_intent'
  );
}

function formatElapsedTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function TextEvent({ text }: { text: string }) {
  return <MarkdownRenderer content={text} />;
}

export function buildChatFileReference(
  filePath: string,
  lineRange?: [number, number],
): string | null {
  if (!filePath) return null;
  if (!lineRange) return filePath;
  return `${filePath}:${lineRange[0]}-${lineRange[1]}`;
}

function FileEditEvent({
  filePath,
  diff,
  agentLabel = 'The agent',
}: {
  filePath: string;
  diff: string;
  agentLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copiedDiff, setCopiedDiff] = useState(false);
  const detailsId = useId();
  const openInEditor = useOpenEventFileInEditor(filePath);
  const hasDiff = diff.trim().length > 0;

  const copyDiff = useCallback(() => {
    if (!hasDiff) return;
    void copyTextToClipboard(diff).then(() => {
      setCopiedDiff(true);
      window.setTimeout(() => setCopiedDiff(false), 1600);
    });
  }, [diff, hasDiff]);

  return (
    <div className="chat-operation overflow-hidden rounded-lg border border-info/20 bg-bg-tertiary/60">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/80"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} edit details for ${filePath}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileDiff size={12} className="text-info" />
          <span className="min-w-0 flex-1 truncate">
            Edit <span className="font-mono text-text-primary">{filePath}</span>
          </span>
        </button>
        {filePath && (
          <button
            onClick={openInEditor}
            className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="Open in editor"
            aria-label={`Open ${filePath} in editor`}
          >
            <ExternalLink size={12} />
          </button>
        )}
        {hasDiff && (
          <button
            onClick={copyDiff}
            className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title={copiedDiff ? 'Copied diff' : 'Copy diff'}
            aria-label={copiedDiff ? 'Copied diff' : 'Copy diff'}
          >
            {copiedDiff ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
        )}
      </div>
      <div id={detailsId} hidden={!expanded}>
        {expanded && (
          <div className="border-t border-border-subtle">
            {hasDiff ? (
              <DiffViewer filePath={filePath} diff={diff} />
            ) : (
              <p className="px-4 py-3 text-xs text-text-tertiary">
                Change applied. {agentLabel} did not provide a renderable patch for this event.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function useOpenEventFileInEditor(filePath: string, line?: number): () => void {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();

  return useCallback(() => {
    if (!filePath) return;
    const isAbsolute = isAbsoluteEditorPath(filePath);
    navigate(
      buildEditorUrl({
        workspaceId: activeWorkspace?.id,
        absolutePath: isAbsolute ? filePath : undefined,
        relativePath: isAbsolute ? undefined : filePath,
        line,
        source: 'chat',
        title: line ? `${filePath}:${line}` : filePath,
      }),
    );
  }, [activeWorkspace?.id, filePath, line, navigate]);
}

function ApprovalRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const [resolved, setResolved] = useState<'accepted' | 'declined' | null>(null);
  const { pending, error, run } = useChatRequest('Could not send your decision. Try again.');
  const isCommand = event.approvalKind === 'command';
  const isPermissions = event.approvalKind === 'permissions';
  const cursorOptions = isPermissions ? getCursorPermissionOptions(event.approvalPermissions) : [];
  const label = agentEventLabel(event);
  const title = isCommand
    ? 'Approve command'
    : isPermissions
      ? event.toolName
        ? 'Approve ' + event.toolName
        : 'Approve additional permissions'
      : event.approvalKind === 'file_change'
        ? 'Approve file change'
        : `${label} requests approval`;
  // H8 — prefer the normalized fields the protocol layer extracted (command,
  // structured tool input like {command|path|url}, grant root) and only fall
  // back to a JSON blob when nothing readable exists.
  const toolInputSummary = event.toolInput ? formatApprovalToolInput(event.toolInput) : null;
  const detail =
    event.approvalCommand ??
    toolInputSummary ??
    (isPermissions
      ? formatRequestedPermissions(event.approvalPermissions, label)
      : event.approvalGrantRoot
        ? `Allow writes under ${event.approvalGrantRoot}`
        : `${label} wants permission to apply a change.`);

  const decide = async (decision: 'accept' | 'acceptForSession' | 'decline', optionId?: string) => {
    const { sessionId, approvalRequestId } = event;
    if (!sessionId || approvalRequestId === undefined || resolved) return;
    await run(async () => {
      await window.anvil.chat.resolveApproval(sessionId, approvalRequestId, decision, optionId);
      setResolved(decision === 'decline' ? 'declined' : 'accepted');
    });
  };

  return (
    <div
      aria-busy={pending}
      className="overflow-hidden rounded-xl border border-border bg-bg-secondary"
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{title}</p>
          {detail && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-primary/60 p-3 font-mono text-xs leading-5 text-text-secondary">
              {detail}
            </pre>
          )}
          {isPermissions && event.toolInput && !toolInputSummary && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-primary/60 p-2 font-mono text-xs text-text-secondary">
              {JSON.stringify(event.toolInput, null, 2)}
            </pre>
          )}
          {event.approvalReason && (
            <p className="mt-1 text-xs text-text-tertiary">{event.approvalReason}</p>
          )}
          {event.approvalCwd && (
            <p className="mt-1 break-words text-xs text-text-secondary">In {event.approvalCwd}</p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-error">
              {error}
            </p>
          )}
          {resolved && (
            <p role="status" className="mt-2 text-xs text-text-secondary">
              {resolved === 'accepted' ? 'Approved' : 'Declined'}
            </p>
          )}
        </div>
      </div>
      {!resolved && (
        <fieldset
          disabled={pending || !event.sessionId || event.approvalRequestId === undefined}
          className="flex flex-wrap items-center gap-2 border-t border-border-subtle px-4 py-2.5 disabled:opacity-60 [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-accent/70 [&_button]:disabled:cursor-wait"
        >
          {cursorOptions.length > 0 ? (
            cursorOptions.map((option) => (
              <button
                key={option.optionId}
                onClick={() => void decide(cursorPermissionDecision(option.kind), option.optionId)}
                className={
                  option.kind.startsWith('reject')
                    ? 'flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary'
                    : 'flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/85'
                }
              >
                {option.kind.startsWith('reject') ? <X size={12} /> : <Check size={12} />}
                {option.name}
              </button>
            ))
          ) : (
            <>
              <button
                onClick={() => void decide('accept')}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/85"
              >
                <Check size={12} /> Approve once
              </button>
              <button
                onClick={() => void decide('acceptForSession')}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary"
              >
                Approve for this session
              </button>
              <button
                onClick={() => void decide('decline')}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary"
              >
                <X size={12} /> Decline
              </button>
            </>
          )}
          {pending && (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 text-xs text-text-secondary"
            >
              <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> Sending
              decision…
            </span>
          )}
        </fieldset>
      )}
    </div>
  );
}

function InputRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  if (!event.inputRequest) return null;
  if (event.inputRequest.kind === 'user_input') {
    return <UserInputRequestEvent event={event} />;
  }
  if (event.inputRequest.kind === 'cursor_ask_question') {
    return <CursorQuestionRequestEvent event={event} />;
  }
  if (event.inputRequest.kind === 'cursor_create_plan') {
    return <CursorPlanRequestEvent event={event} />;
  }
  return <McpElicitationRequestEvent event={event} />;
}

function UserInputRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const request = event.inputRequest?.kind === 'user_input' ? event.inputRequest : undefined;
  const questions = request?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [resolved, setResolved] = useState(false);
  const {
    pending: submitting,
    error,
    run,
  } = useChatRequest('Could not send your answers. Try again.');
  const activeQuestion = questions[activeIndex];
  const complete =
    questions.length > 0 && questions.every((question) => answers[question.id]?.trim());

  const submit = async () => {
    const { sessionId, inputRequestId } = event;
    if (!sessionId || inputRequestId === undefined || !complete || resolved) return;
    await run(async () => {
      await window.anvil.chat.resolveInputRequest(sessionId, inputRequestId, {
        kind: 'user_input',
        answers: Object.fromEntries(
          questions.map((question) => [question.id, [answers[question.id].trim()]]),
        ),
      });
      setResolved(true);
    });
  };

  if (resolved) {
    return (
      <div className="flex items-center gap-3 border-y border-success/20 bg-success/[0.035] px-3 py-3">
        <CheckCircle2 size={14} className="shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text-primary">Answers sent</p>
          <p className="mt-1 text-xs leading-5 text-text-tertiary">
            {questions
              .map((question) =>
                question.isSecret
                  ? `${question.header}: answer provided`
                  : `${question.header}: ${answers[question.id]}`,
              )
              .join(' · ')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        if (activeIndex < questions.length - 1) setActiveIndex((current) => current + 1);
        else void submit();
      }}
      className="overflow-hidden rounded-xl border border-warning/35 bg-bg-secondary"
    >
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <MessageSquare size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">
            {agentEventLabel(event)} needs your input
          </p>
          <p className="mt-0.5 text-xs text-text-tertiary">
            {questions.length > 0
              ? `Question ${activeIndex + 1} of ${questions.length}`
              : 'No questions were provided'}
            {request?.autoResolutionMs
              ? ` · may continue after ${Math.ceil(request.autoResolutionMs / 1000)}s`
              : ''}
          </p>
        </div>
        {questions.length > 1 && (
          <div className="flex gap-1" aria-hidden="true">
            {questions.map((question, index) => (
              <span
                key={question.id}
                className={`h-1.5 w-6 rounded-full ${
                  index < activeIndex || answers[question.id]?.trim()
                    ? 'bg-success'
                    : index === activeIndex
                      ? 'bg-warning'
                      : 'bg-border'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {activeQuestion ? (
        <fieldset className="p-4">
          <legend className="text-xs font-semibold text-warning">{activeQuestion.header}</legend>
          <p className="mt-2 max-w-[68ch] text-sm leading-6 text-text-primary">
            {activeQuestion.question}
          </p>
          <div className="mt-4 grid gap-2">
            {(activeQuestion.options ?? []).map((option, optionIndex) => {
              const selected = answers[activeQuestion.id] === option.label;
              const recommended = /\(recommended\)/i.test(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() =>
                    setAnswers((previous) => ({
                      ...previous,
                      [activeQuestion.id]: option.label,
                    }))
                  }
                  className={`group flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                    selected
                      ? 'border-accent/60 bg-accent/10'
                      : 'border-border-subtle hover:border-border hover:bg-bg-tertiary/55'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-mono text-xs ${
                      selected
                        ? 'border-accent bg-accent text-accent-foreground'
                        : 'border-border text-text-tertiary group-hover:text-text-primary'
                    }`}
                  >
                    {optionIndex + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                      {option.label.replace(/\s*\(recommended\)/i, '')}
                      {recommended && (
                        <span className="rounded-full bg-info/10 px-2 py-0.5 text-xs font-medium text-info">
                          Recommended
                        </span>
                      )}
                    </span>
                    {option.description && (
                      <span className="mt-1 block text-sm leading-5 text-text-tertiary">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {selected && <Check size={14} className="mt-1 shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
          {(activeQuestion.isOther || (activeQuestion.options ?? []).length === 0) && (
            <label className="mt-3 block">
              <span className="sr-only">Custom answer</span>
              <input
                type={activeQuestion.isSecret ? 'password' : 'text'}
                value={
                  (activeQuestion.options ?? []).some(
                    (option) => option.label === answers[activeQuestion.id],
                  )
                    ? ''
                    : (answers[activeQuestion.id] ?? '')
                }
                onChange={(inputEvent) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [activeQuestion.id]: inputEvent.target.value,
                  }))
                }
                placeholder={
                  (activeQuestion.options ?? []).length > 0
                    ? 'Or enter another answer…'
                    : 'Type your answer…'
                }
                className="w-full rounded-lg border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
              />
            </label>
          )}
          {error && <p className="mt-3 text-xs text-error">{error}</p>}
        </fieldset>
      ) : (
        <p className="p-4 text-sm text-error">
          {agentEventLabel(event)} sent an empty input request.
        </p>
      )}

      {activeQuestion && (
        <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-3">
          {activeIndex > 0 && (
            <button
              type="button"
              onClick={() => setActiveIndex((current) => current - 1)}
              className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={
              !answers[activeQuestion.id]?.trim() ||
              submitting ||
              (activeIndex === questions.length - 1 && !complete)
            }
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            {activeIndex < questions.length - 1 ? 'Next question' : 'Send answers'}
          </button>
        </div>
      )}
    </form>
  );
}

function CursorQuestionRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const request = event.inputRequest?.kind === 'cursor_ask_question' ? event.inputRequest : null;
  const questions = request?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [resolved, setResolved] = useState(false);
  const { pending, error, run } = useChatRequest('Could not send your answers. Try again.');

  const toggleOption = (questionId: string, optionId: string, allowMultiple: boolean) => {
    setAnswers((previous) => {
      const selected = previous[questionId] ?? [];
      if (!allowMultiple) return { ...previous, [questionId]: [optionId] };
      return {
        ...previous,
        [questionId]: selected.includes(optionId)
          ? selected.filter((value) => value !== optionId)
          : [...selected, optionId],
      };
    });
  };

  const submit = async (action: 'submit' | 'cancel') => {
    const { sessionId, inputRequestId } = event;
    if (!sessionId || inputRequestId === undefined || !request || resolved) return;
    await run(async () => {
      await window.anvil.chat.resolveInputRequest(sessionId, inputRequestId, {
        kind: 'cursor_ask_question',
        action,
        answers: questions.map((question) => ({
          questionId: question.id,
          selectedOptionIds: answers[question.id] ?? [],
        })),
      });
      setResolved(true);
    });
  };

  return (
    <fieldset
      disabled={pending || resolved}
      aria-busy={pending}
      className="overflow-hidden rounded-xl border border-border bg-bg-secondary [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-accent/70 [&_button]:disabled:opacity-50"
    >
      <div className="border-b border-border-subtle px-4 py-3">
        <p className="text-sm font-semibold text-text-primary">
          {request?.title ?? 'Cursor needs your input'}
        </p>
      </div>
      <div className="space-y-4 p-4">
        {questions.map((question) => (
          <fieldset key={question.id}>
            <legend className="text-sm font-medium text-text-primary">{question.prompt}</legend>
            <div className="mt-2 grid gap-2">
              {question.options.map((option) => {
                const selected = (answers[question.id] ?? []).includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      toggleOption(question.id, option.id, question.allowMultiple === true)
                    }
                    className={
                      selected
                        ? 'rounded-lg border border-accent/60 bg-accent/10 px-3 py-2 text-left text-sm text-text-primary'
                        : 'rounded-lg border border-border-subtle px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-tertiary'
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        {resolved && (
          <p role="status" className="text-xs text-text-secondary">
            Answers sent
          </p>
        )}
      </div>
      {!resolved && (
        <div className="flex gap-2 border-t border-border-subtle px-4 py-3">
          <button
            type="button"
            onClick={() => void submit('submit')}
            disabled={questions.some((question) => (answers[question.id] ?? []).length === 0)}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? 'Sending…' : questions.length === 1 ? 'Send answer' : 'Send answers'}
          </button>
          <button
            type="button"
            onClick={() => void submit('cancel')}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
        </div>
      )}
    </fieldset>
  );
}

function CursorPlanRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const request = event.inputRequest?.kind === 'cursor_create_plan' ? event.inputRequest : null;
  const [resolved, setResolved] = useState<'accepted' | 'rejected' | 'cancelled' | null>(null);
  const { pending, error, run } = useChatRequest('Could not send your decision. Try again.');

  const decide = async (action: 'submit' | 'skip' | 'cancel') => {
    const { sessionId, inputRequestId } = event;
    if (!sessionId || inputRequestId === undefined || !request || resolved) return;
    await run(async () => {
      await window.anvil.chat.resolveInputRequest(sessionId, inputRequestId, {
        kind: 'cursor_create_plan',
        action,
      });
      setResolved(action === 'submit' ? 'accepted' : action === 'skip' ? 'rejected' : 'cancelled');
    });
  };

  return (
    <fieldset
      disabled={pending || !!resolved}
      aria-busy={pending}
      className="overflow-hidden rounded-xl border border-border bg-bg-secondary [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-accent/70 [&_button]:disabled:opacity-50"
    >
      <div className="border-b border-border-subtle px-4 py-3">
        <p className="text-sm font-semibold text-text-primary">
          {request?.title ?? 'Cursor plan approval'}
        </p>
        <p className="mt-1 text-xs text-text-tertiary">
          Cursor is waiting for approval before continuing.
        </p>
      </div>
      <div className="max-h-80 overflow-auto p-4">
        <MarkdownRenderer content={request?.plan ?? ''} />
        {error && (
          <p role="alert" className="mt-3 text-xs text-error">
            {error}
          </p>
        )}
        {resolved && (
          <p role="status" className="mt-3 text-xs text-text-secondary">
            Plan {resolved}.
          </p>
        )}
        {pending && (
          <p role="status" className="mt-3 text-xs text-text-secondary">
            Sending decision…
          </p>
        )}
      </div>
      {!resolved && (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-3">
          <button
            type="button"
            onClick={() => void decide('submit')}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent/85"
          >
            <Check size={12} className="mr-1 inline" /> Accept plan
          </button>
          <button
            type="button"
            onClick={() => void decide('skip')}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary"
          >
            <X size={12} className="mr-1 inline" /> Reject plan
          </button>
          <button
            type="button"
            onClick={() => void decide('cancel')}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
        </div>
      )}
    </fieldset>
  );
}

function McpElicitationRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const request = event.inputRequest?.kind === 'mcp_elicitation' ? event.inputRequest : undefined;
  const [content, setContent] = useState('{}');
  const [resolved, setResolved] = useState<'accepted' | 'declined' | 'cancelled' | null>(null);
  const { pending, error, run } = useChatRequest('Could not send your response. Try again.');
  const [copied, setCopied] = useState(false);

  const decide = async (action: 'accept' | 'decline' | 'cancel') => {
    const { sessionId, inputRequestId } = event;
    if (!sessionId || inputRequestId === undefined || resolved) return;
    await run(async () => {
      let parsedContent: unknown;
      if (action === 'accept' && request?.mode !== 'url') {
        try {
          parsedContent = JSON.parse(content);
        } catch {
          throw new Error('Enter valid JSON before continuing.');
        }
      }
      await window.anvil.chat.resolveInputRequest(sessionId, inputRequestId, {
        kind: 'mcp_elicitation',
        action,
        ...(parsedContent === undefined ? {} : { content: parsedContent }),
      });
      setResolved(
        action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      );
    });
  };

  const copyUrl = () => {
    if (!request?.url) return;
    void copyTextToClipboard(request.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <fieldset
      disabled={pending || !!resolved}
      aria-busy={pending}
      className="overflow-hidden rounded-xl border border-border bg-bg-secondary [&_button]:focus-visible:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-accent/70 [&_button]:disabled:opacity-50"
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">
            {request?.serverName
              ? `${request.serverName} needs input`
              : 'Connected tool needs input'}
          </p>
          {request?.message && (
            <p className="mt-1 text-xs text-text-secondary">{request.message}</p>
          )}
          {request?.mode === 'url' && request.url ? (
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary/50 p-2">
              <code className="min-w-0 flex-1 break-all text-xs text-text-secondary">
                {request.url}
              </code>
              <button
                type="button"
                onClick={copyUrl}
                className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary"
              >
                {copied ? 'Copied' : 'Copy URL'}
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                Response JSON
              </label>
              <textarea
                aria-label="Response JSON"
                value={content}
                disabled={resolved !== null}
                onChange={(inputEvent) => setContent(inputEvent.target.value)}
                className="min-h-24 w-full resize-y rounded-lg border border-border bg-bg-primary p-2 font-mono text-xs text-text-primary outline-none focus:border-accent"
              />
              {request?.requestedSchema !== undefined && (
                <details className="mt-2 text-xs text-text-tertiary">
                  <summary className="cursor-pointer">Requested schema</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-primary/60 p-2 text-xs">
                    {JSON.stringify(request.requestedSchema, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-error">
              {error}
            </p>
          )}
          {resolved && (
            <p role="status" className="mt-2 text-xs text-text-secondary">
              Request {resolved}
            </p>
          )}
          {pending && (
            <p role="status" className="mt-2 text-xs text-text-secondary">
              Sending response…
            </p>
          )}
        </div>
      </div>
      {!resolved && (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-2.5">
          <button
            type="button"
            onClick={() => void decide('accept')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent/85"
          >
            <Check size={12} /> Continue
          </button>
          <button
            type="button"
            onClick={() => void decide('decline')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary"
          >
            <X size={12} /> Decline
          </button>
          <button
            type="button"
            onClick={() => void decide('cancel')}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
        </div>
      )}
    </fieldset>
  );
}

function SubagentUpdateEvent({ event }: { event: CodexEvent }) {
  const update = event.subagent;
  if (!update) return null;
  const active =
    update.status === 'inProgress' || update.agents.some((agent) => agent.status === 'running');
  const failed =
    update.status === 'failed' || update.agents.some((agent) => agent.status === 'errored');
  const results = update.agents.filter((agent) => agent.message?.trim());
  const label = formatSubagentAction(update.tool, update.activityKind);

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-secondary/45 px-4 py-3">
      <div className="flex items-start gap-2.5">
        {active ? (
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-warning" />
        ) : failed ? (
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
        ) : (
          <Users size={14} className="mt-0.5 shrink-0 text-info" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-medium text-text-primary">{label}</p>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-eyebrow text-text-tertiary">
              {formatSubagentStatus(update.status, update.agents)}
            </span>
            {update.model && <span className="text-xs text-text-muted">{update.model}</span>}
          </div>
          {update.prompt && (
            <details className="mt-1 text-xs text-text-tertiary">
              <summary className="cursor-pointer line-clamp-2 hover:text-text-secondary">
                {update.prompt}
              </summary>
              <p className="mt-2 whitespace-pre-wrap leading-5">{update.prompt}</p>
            </details>
          )}
          {update.agents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {update.agents.map((agent, index) => (
                <span
                  key={agent.threadId}
                  className="rounded-md border border-border-subtle bg-bg-primary/50 px-2 py-1 text-xs font-medium text-text-secondary"
                  title={agent.threadId}
                >
                  {update.agentPath?.split('/').filter(Boolean).pop() ?? `Agent ${index + 1}`} ·{' '}
                  {agent.status}
                </span>
              ))}
            </div>
          )}
          {results.map((agent) => (
            <div
              key={`${agent.threadId}-result`}
              className="mt-3 max-h-96 overflow-auto border-t border-border-subtle pt-3 text-text-secondary"
            >
              <p className="mb-2 text-xs font-medium text-text-muted">Agent result</p>
              <MarkdownRenderer content={agent.message ?? ''} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadStatusEvent({ event }: { event: CodexEvent }) {
  const flags = event.threadActiveFlags ?? [];
  if (flags.length === 0) return null;
  const waitingForInput = flags.includes('waitingOnUserInput');
  return (
    <div className="flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
      <AlertCircle size={13} />
      <span>
        {waitingForInput ? 'Agent is waiting for your input' : 'Agent is waiting for approval'}
      </span>
    </div>
  );
}

function formatRequestedPermissions(
  permissions: Record<string, unknown> | undefined,
  agentLabel: string,
): string {
  if (!permissions) return `${agentLabel} requested additional runtime permissions.`;
  const scopes = [
    permissions.fileSystem ? 'filesystem' : null,
    permissions.network ? 'network' : null,
  ]
    .filter((scope): scope is string => Boolean(scope))
    .join(' and ');
  return scopes ? `Additional ${scopes} access requested.` : 'Additional permissions requested.';
}

/**
 * H8 — pull a human-readable summary out of an ACP tool call's input before
 * anyone reaches for JSON.stringify. ACP permission requests carry the raw
 * tool input ({command}, {path}, {url}, …); the common scalar fields describe
 * the action far better than a blob.
 */
function formatApprovalToolInput(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'path', 'file_path', 'filePath', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

type CursorPermissionOption = {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

function getCursorPermissionOptions(
  permissions: Record<string, unknown> | undefined,
): CursorPermissionOption[] {
  if (!Array.isArray(permissions?.options)) return [];
  return permissions.options.flatMap((option) => {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) return [];
    const candidate = option as Record<string, unknown>;
    if (typeof candidate.optionId !== 'string') return [];
    if (
      candidate.kind !== 'allow_once' &&
      candidate.kind !== 'allow_always' &&
      candidate.kind !== 'reject_once' &&
      candidate.kind !== 'reject_always'
    ) {
      return [];
    }
    return [
      {
        optionId: candidate.optionId,
        name:
          typeof candidate.name === 'string' && candidate.name.trim()
            ? candidate.name
            : candidate.kind,
        kind: candidate.kind,
      },
    ];
  });
}

function cursorPermissionDecision(
  kind: CursorPermissionOption['kind'],
): 'accept' | 'acceptForSession' | 'decline' {
  if (kind === 'allow_always') return 'acceptForSession';
  if (kind === 'reject_once' || kind === 'reject_always') return 'decline';
  return 'accept';
}

function formatSubagentAction(
  tool: NonNullable<CodexEvent['subagent']>['tool'],
  activityKind: NonNullable<CodexEvent['subagent']>['activityKind'],
): string {
  if (activityKind === 'completed') return 'Subagent completed';
  if (activityKind === 'errored') return 'Subagent failed';
  if (activityKind === 'started') return 'Subagent started';
  if (activityKind === 'interacted') return 'Subagent update';
  if (activityKind === 'interrupted') return 'Subagent interrupted';
  switch (tool) {
    case 'spawnAgent':
      return 'Spawn subagent';
    case 'sendInput':
      return 'Send input to subagent';
    case 'resumeAgent':
      return 'Resume subagent';
    case 'wait':
      return 'Wait for subagents';
    case 'closeAgent':
      return 'Close subagent';
    default:
      return 'Subagent activity';
  }
}

function formatSubagentStatus(
  status: NonNullable<CodexEvent['subagent']>['status'],
  agents: NonNullable<CodexEvent['subagent']>['agents'],
): string {
  if (status === 'inProgress') return 'running';
  if (status === 'completed') return 'complete';
  if (status === 'failed') return 'failed';
  if (agents.some((agent) => agent.status === 'running')) return 'running';
  if (agents.some((agent) => agent.status === 'errored')) return 'failed';
  return agents[0]?.status ?? 'updated';
}

function CommandExecEvent({
  command,
  output,
  exitCode,
  toolStatus,
}: {
  command: string;
  output: string;
  exitCode?: number;
  toolStatus?: CodexEvent['toolStatus'];
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const detailsId = useId();
  const active = useProcessingActive();
  const status = getOperationStatus({ type: 'command_exec', exitCode, toolStatus }, active);
  const success = status === 'completed';

  const copyCommand = useCallback(() => {
    if (!command) return;
    void copyTextToClipboard(command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [command]);

  const copyOutput = useCallback(() => {
    if (!output) return;
    void copyTextToClipboard(output).then(() => {
      setCopiedOutput(true);
      window.setTimeout(() => setCopiedOutput(false), 1600);
    });
  }, [output]);

  const shown = command ? displayCommand(command) : 'Command output';
  return (
    <div className="chat-operation overflow-hidden rounded-lg border border-border-subtle bg-bg-tertiary/60">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/80"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} command output for ${shown}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          title={command || undefined}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Terminal
            size={12}
            className={
              success ? 'text-success' : status === 'failed' ? 'text-error' : 'text-text-secondary'
            }
          />
          <span
            className={`min-w-0 truncate font-mono text-sm ${command ? 'text-text-primary' : 'text-text-tertiary'}`}
          >
            {shown}
          </span>
        </button>
        <span
          className={`w-16 shrink-0 text-right text-xs ${
            exitCode === undefined ? 'text-text-secondary' : success ? 'text-success' : 'text-error'
          }`}
        >
          {exitCode === undefined ? status : `exit ${exitCode}`}
        </span>
        <button
          onClick={copyCommand}
          disabled={!command}
          className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:invisible"
          title={copied ? 'Copied command' : 'Copy command'}
          aria-label={copied ? 'Copied command' : 'Copy command'}
          aria-hidden={!command || undefined}
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        </button>
        <button
          onClick={copyOutput}
          disabled={!output}
          className="w-16 rounded-lg px-2 py-1.5 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:invisible"
          title={copiedOutput ? 'Copied output' : 'Copy output'}
          aria-label={copiedOutput ? 'Copied output' : 'Copy output'}
          aria-hidden={!output || undefined}
        >
          {copiedOutput ? 'Copied' : 'Output'}
        </button>
      </div>
      <div id={detailsId} hidden={!expanded}>
        {expanded && output && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle p-4 text-xs font-mono leading-relaxed text-text-secondary">
            {output}
          </pre>
        )}
      </div>
    </div>
  );
}

function ToolCallEvent({ event }: { event: CodexEvent }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const status = getOperationStatus(event, useProcessingActive());
  const toolName = event.toolName ?? 'Tool';
  const hasInput = Boolean(event.toolInput && Object.keys(event.toolInput).length > 0);
  const hasOutput = Boolean(event.toolOutput);
  const hasDetails = hasInput || hasOutput;

  return (
    <div
      className={`chat-operation overflow-hidden rounded-lg border ${
        status === 'failed'
          ? 'border-error/30 bg-error/5'
          : 'border-border-subtle bg-bg-tertiary/60'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        disabled={!hasDetails}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary/80 disabled:cursor-default disabled:hover:bg-transparent"
        aria-label={
          hasDetails
            ? `${expanded ? 'Collapse' : 'Expand'} details for ${toolName}`
            : `${toolName} tool call`
        }
        aria-expanded={hasDetails ? expanded : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
      >
        {hasDetails && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        {status === 'failed' ? (
          <XCircle size={12} className="shrink-0 text-error" />
        ) : status === 'completed' ? (
          <CheckCircle2 size={12} className="shrink-0 text-success" />
        ) : (
          <Wrench size={12} className="shrink-0 text-text-secondary" />
        )}
        <span className="min-w-0 flex-1 truncate">
          Tool:{' '}
          <span className={status === 'failed' ? 'text-error' : 'text-text-secondary'}>
            {toolName}
          </span>
        </span>
        {status !== 'failed' && (
          <span className="shrink-0 text-xs text-text-secondary">{status}</span>
        )}
        {status === 'failed' && (
          <span className="ml-auto rounded-full bg-error/10 px-2 py-0.5 text-eyebrow font-medium text-error">
            failed
          </span>
        )}
      </button>
      {hasDetails && (
        <div id={detailsId} hidden={!expanded}>
          {expanded && (
            <div className="space-y-3 border-t border-border-subtle p-4">
              {hasInput && (
                <div>
                  <p className="mb-1 text-xs font-medium text-text-secondary">Input</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs font-mono leading-relaxed text-text-secondary">
                    {JSON.stringify(event.toolInput, null, 2)}
                  </pre>
                </div>
              )}
              {hasOutput && (
                <div>
                  <p className="mb-1 text-xs font-medium text-text-secondary">Output</p>
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs font-mono leading-relaxed text-text-secondary">
                    {event.toolOutput}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanUpdateEvent({ plan }: { plan: NonNullable<CodexEvent['plan']> }) {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;

  return (
    <div className="chat-operation overflow-hidden rounded-lg border border-info/25 bg-info/5">
      <div className="flex items-start gap-2.5 border-b border-info/15 px-4 py-3">
        <ListChecks size={14} className="mt-0.5 shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">Plan updated</p>
          <p className="text-xs text-text-tertiary">
            {completed}/{plan.steps.length} complete
          </p>
          {plan.explanation && (
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{plan.explanation}</p>
          )}
        </div>
      </div>
      {plan.steps.length > 0 && (
        <ol className="space-y-1 px-4 py-3">
          {plan.steps.map((step, index) => (
            <li key={`${index}-${step.step}`} className="flex min-w-0 items-start gap-2 text-sm">
              <PlanStepIcon status={step.status} />
              <span
                className={
                  step.status === 'completed'
                    ? 'text-text-tertiary line-through'
                    : 'text-text-secondary'
                }
              >
                {step.step}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GoalUpdateEvent({ goal }: { goal: NonNullable<CodexEvent['goal']> }) {
  return (
    <div className="chat-operation rounded-lg border border-success/20 bg-success/5 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <Target size={14} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">
            Goal {formatGoalStatus(goal.status)}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-text-secondary">{goal.objective}</p>
          <p className="mt-1 text-xs text-text-tertiary">
            {goal.tokensUsed.toLocaleString()} tokens
            {goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''} used
          </p>
        </div>
      </div>
    </div>
  );
}

function GoalClearedEvent() {
  return (
    <div className="chat-operation rounded-lg border border-border-subtle bg-bg-tertiary/50 px-4 py-3 text-sm text-text-tertiary">
      Goal cleared
    </div>
  );
}

function PlanStepIcon({ status }: { status: ChatPlanStep['status'] }) {
  if (status === 'completed')
    return <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />;
  if (status === 'in_progress')
    return <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-info" />;
  return <Circle size={13} className="mt-0.5 shrink-0 text-text-tertiary" />;
}

function formatGoalStatus(status: NonNullable<CodexEvent['goal']>['status']): string {
  switch (status) {
    case 'complete':
      return 'completed';
    case 'budgetLimited':
      return 'budget limited';
    default:
      return status;
  }
}

function ErrorEvent({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-error/20 bg-error/5 px-4 py-3">
      <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
      <p className="text-sm text-error leading-relaxed">{message}</p>
    </div>
  );
}

/** A recorded status change. The turn card owns the live indicator. */
function StatusEvent({ status }: { status: string }) {
  if (status === 'complete') return null;

  const label =
    {
      thinking: 'Thinking',
      executing: 'Executing',
    }[status] ?? status;

  return <div className="py-1 text-xs text-text-tertiary">{label}</div>;
}

export function ThinkingMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div className="message-bubble flex justify-start">
      <div className="w-full max-w-4xl overflow-hidden rounded-lg border border-border-subtle bg-bg-tertiary/30">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary/50"
          aria-label={expanded ? 'Collapse thinking' : 'Expand thinking'}
          aria-expanded={expanded}
          aria-controls={detailsId}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Sparkles size={12} className={content ? 'text-warning' : ''} />
          <span className="font-medium">Reasoning...</span>
        </button>
        <div id={detailsId} hidden={!expanded}>
          {expanded && content && (
            <div className="border-t border-border-subtle px-4 py-3">
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed italic text-text-tertiary">
                {content}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface MessageActionsProps {
  onCopy: () => void;
  onBranch?: () => void;
  onRegenerate?: () => void;
  onEdit?: () => void;
  copied: boolean;
  isUser?: boolean;
}

function MessageActionsToolbar({
  onCopy,
  onBranch,
  onRegenerate,
  onEdit,
  copied,
  isUser,
}: MessageActionsProps) {
  return (
    <div className="message-actions flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-secondary px-1 py-0.5 shadow-sm">
      <ActionButton
        onClick={onCopy}
        title={copied ? 'Copied!' : 'Copy to clipboard'}
        icon={copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      />
      {onBranch && (
        <ActionButton
          onClick={onBranch}
          title="Fork to new thread"
          icon={<GitBranch size={12} />}
        />
      )}
      {onRegenerate && !isUser && (
        <ActionButton
          onClick={onRegenerate}
          title="Regenerate response"
          icon={<RefreshCw size={12} />}
        />
      )}
      {onEdit && isUser && (
        <ActionButton onClick={onEdit} title="Reuse in composer" icon={<Pencil size={12} />} />
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  title,
  icon,
}: {
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
      title={title}
      aria-label={title}
    >
      {icon}
    </button>
  );
}

export function AssistantMessage({
  content,
  transformContent,
  onBranch,
  onRegenerate,
  label = 'Assistant',
  colour,
  active = false,
}: {
  content: string;
  transformContent?: (c: string) => string;
  onBranch?: () => void;
  onRegenerate?: () => void;
  label?: string;
  colour?: string;
  active?: boolean;
}) {
  const display = transformContent ? transformContent(content) : content;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await copyTextToClipboard(display);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [display]);

  return (
    <ChatMessageRow align="start">
      <ChatAssistantMessageFrame>
        <ChatAssistantMessageHeader
          role={active ? 'status' : undefined}
          aria-live={active ? 'polite' : undefined}
        >
          {active ? (
            <LiveGlyph size="sm" />
          ) : (
            <span
              className="h-1.5 w-1.5 rounded-full bg-text-tertiary"
              style={colour ? { backgroundColor: colour } : undefined}
              aria-hidden="true"
            />
          )}
          <span>{label}</span>
          {active && <span className="font-normal text-text-tertiary">Responding</span>}
        </ChatAssistantMessageHeader>
        <ChatAssistantMessageBody>
          <MessageStreamingContext.Provider value={active}>
            <MarkdownRenderer content={display} />
          </MessageStreamingContext.Provider>
        </ChatAssistantMessageBody>
        <ChatAssistantMessageActions>
          <MessageActionsToolbar
            onCopy={handleCopy}
            onBranch={onBranch}
            onRegenerate={onRegenerate}
            copied={copied}
          />
        </ChatAssistantMessageActions>
      </ChatAssistantMessageFrame>
    </ChatMessageRow>
  );
}

export function UserMessage({
  content,
  attachments,
  delivery,
  deliveryError,
  deliveryIntent,
  onEdit,
  onBranch,
}: {
  content: string;
  attachments?: ChatAttachment[];
  /** Delivery is separate from whether the agent completed the requested work. */
  delivery?: 'queued' | 'delivered' | 'failed' | 'uncertain';
  deliveryError?: string;
  deliveryIntent?: ChatFollowUpIntent;
  onEdit?: () => void;
  onBranch?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsible = shouldCollapseUserMessage(content);
  const lineCount = content.split('\n').length;

  const handleCopy = useCallback(async () => {
    await copyTextToClipboard(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <ChatMessageRow align="end">
      <ChatUserMessageFrame>
        <ChatUserMessageHeader>
          You
          {deliveryIntent && (
            <span className="font-normal">
              · {deliveryIntent === 'guide' ? 'Guidance' : 'Next task'}
            </span>
          )}
          {delivery === 'delivered' && (
            <span
              className="text-text-tertiary"
              title="Sent to the agent process. This does not confirm the work is complete."
            >
              Sent to agent
            </span>
          )}
          {delivery === 'queued' && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-info/10 px-1.5 py-0.5 text-eyebrow font-medium text-info"
              title="The agent is mid-turn; this message will be sent next"
            >
              Queued
            </span>
          )}
          {delivery === 'uncertain' && (
            <span
              className="text-warning"
              title="Delivery could not be confirmed. Check the conversation before sending again."
            >
              Delivery unknown
            </span>
          )}
          {delivery === 'failed' && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-error/10 px-1.5 py-0.5 text-eyebrow font-medium text-error"
              title="The message was rejected. You can edit it before sending again."
            >
              Not sent
            </span>
          )}
        </ChatUserMessageHeader>
        {deliveryError && (
          <p role="status" className="mb-2 text-right text-xs text-warning">
            {deliveryError}
          </p>
        )}
        <ChatUserMessageSurface collapsible={collapsible}>
          <div className={collapsible && !expanded ? 'max-h-64 overflow-hidden' : undefined}>
            {attachments && attachments.length > 0 && (
              <MessageAttachmentList attachments={attachments} />
            )}
            <p className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
              {content}
            </p>
          </div>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="mt-3 flex w-full items-center gap-1.5 border-t border-border-subtle pt-2 text-left text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded
                ? 'Show less'
                : `Show full request${lineCount > 1 ? ` (${lineCount} lines)` : ''}`}
            </button>
          )}
        </ChatUserMessageSurface>
        <ChatUserMessageActions>
          <MessageActionsToolbar
            onCopy={handleCopy}
            onEdit={onEdit}
            onBranch={onBranch}
            copied={copied}
            isUser
          />
        </ChatUserMessageActions>
      </ChatUserMessageFrame>
    </ChatMessageRow>
  );
}

export function shouldCollapseUserMessage(content: string): boolean {
  return content.length > 1_600 || content.split('\n').length > 24;
}

function MessageAttachmentList({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <MessageAttachmentChip key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function MessageAttachmentChip({ attachment }: { attachment: ChatAttachment }) {
  const openInEditor = useOpenEventFileInEditor(attachment.path);

  return (
    <div
      className="flex max-w-full items-center gap-2 rounded-lg border border-accent/20 bg-bg-secondary/50 px-2 py-1.5"
      title={attachment.path}
    >
      {attachment.kind === 'image' ? (
        <ImageIcon size={13} className="shrink-0 text-accent" />
      ) : (
        <FileText size={13} className="shrink-0 text-accent" />
      )}
      <div className="min-w-0">
        <p className="max-w-56 truncate text-xs font-medium text-text-primary">{attachment.name}</p>
        <p className="text-xs text-text-tertiary">{formatAttachmentBytes(attachment.size)}</p>
      </div>
      <button
        type="button"
        onClick={openInEditor}
        className="shrink-0 rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        title="Open attachment in editor"
        aria-label={`Open ${attachment.name} in editor`}
      >
        <ExternalLink size={12} />
      </button>
    </div>
  );
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function summarizeActivityEvents(events: Array<CodexEvent & { sessionId?: string }>): string {
  const labels = [
    summarizeActivityCount(events, 'tool_call', 'tool'),
    summarizeActivityCount(events, 'command_exec', 'command'),
    summarizeActivityCount(events, 'file_edit', 'file edit'),
    summarizeActivityCount(events, 'approval_request', 'approval'),
    summarizeActivityCount(events, 'input_request', 'input request'),
    summarizeActivityCount(events, 'subagent_update', 'agent update'),
    summarizeActivityCount(events, 'plan_update', 'plan update'),
    summarizeActivityCount(events, 'agent_ui_intent', 'structured interface'),
    summarizeActivityCount(events, 'goal_update', 'goal update'),
    summarizeActivityCount(events, 'goal_cleared', 'goal clear'),
  ].filter((value): value is string => Boolean(value));

  return `${events.length} item${events.length === 1 ? '' : 's'}${labels.length > 0 ? ` \u2022 ${labels.join(' \u2022 ')}` : ''}`;
}

function summarizeActivityCount(
  events: Array<CodexEvent & { sessionId?: string }>,
  type: CodexEvent['type'],
  label: string,
): string | null {
  const count = events.filter((event) => event.type === type).length;
  if (count === 0) return null;
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function formatActivityPreview(event: CodexEvent & { sessionId?: string }): string | null {
  switch (event.type) {
    case 'tool_call':
      if (event.toolStatus === 'failed') {
        return event.toolName ? `Tool failed: ${event.toolName}` : 'Tool call failed';
      }
      return event.toolName ? `Tool: ${event.toolName}` : 'Tool call';
    case 'command_exec':
      return event.command?.trim() || 'Command output';
    case 'file_edit':
      return event.filePath ? `Edit ${event.filePath}` : 'File edit';
    case 'approval_request':
      if (event.approvalKind === 'command') {
        return `Approval: ${event.approvalCommand ?? 'command'}`;
      }
      return event.approvalKind === 'permissions'
        ? 'Approval: additional permissions'
        : 'Approval: file change';
    case 'input_request':
      return event.inputRequest?.kind === 'mcp_elicitation'
        ? `Input: ${event.inputRequest.serverName ?? 'connected tool'}`
        : 'Input requested';
    case 'subagent_update':
      return formatSubagentAction(event.subagent?.tool, event.subagent?.activityKind);
    case 'thread_status':
      return event.threadActiveFlags?.includes('waitingOnUserInput')
        ? 'Waiting for input'
        : 'Waiting for approval';
    case 'plan_update':
      return event.plan ? `Plan: ${event.plan.steps.length} steps` : 'Plan update';
    case 'agent_ui_intent':
      if (event.agentUIIntent?.kind === 'surface') {
        return `Published ${event.agentUIIntent.payload.title}`;
      }
      return event.agentUIIntent?.kind === 'plan'
        ? `Plan: ${event.agentUIIntent.payload.steps.length} steps`
        : 'Input requested';
    case 'goal_update':
      return event.goal ? `Goal: ${event.goal.objective}` : 'Goal update';
    case 'goal_cleared':
      return 'Goal cleared';
    default:
      return null;
  }
}

function buildActivityEventKey(event: CodexEvent & { sessionId?: string }, index: number): string {
  const requestKey = getChatQuestionTargetId(event);
  if (requestKey) return requestKey;
  return [
    event.sessionId ?? event.appThreadId ?? 'thread',
    event.type,
    event.itemId ?? event.subagent?.id ?? event.agentUIIntent?.id ?? index,
    event.type === 'file_edit' ? event.filePath : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(':');
}
