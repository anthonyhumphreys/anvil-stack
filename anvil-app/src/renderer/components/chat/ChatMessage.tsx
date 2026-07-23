import { useState, useCallback } from 'react';
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
} from 'lucide-react';
import type { ChatAttachment, ChatPlanStep, CodexEvent } from '../../../shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { DiffViewer } from './DiffViewer';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { copyTextToClipboard } from '../../utils/clipboard';
import { isAbsoluteEditorPath } from '../../../shared/editor-file-link';
import type { ChatTurnWorkItem } from './chat-turns';

interface ChatEventProps {
  event: CodexEvent & { sessionId?: string };
}

export function ChatEventRenderer({ event }: ChatEventProps) {
  switch (event.type) {
    case 'text':
      return <TextEvent text={event.text ?? ''} />;
    case 'file_read':
      return <FileReadEvent filePath={event.filePath ?? ''} lineRange={event.lineRange} />;
    case 'file_edit':
      return <FileEditEvent filePath={event.filePath ?? ''} diff={event.diff ?? ''} />;
    case 'command_exec':
      return (
        <CommandExecEvent
          command={event.command ?? ''}
          output={event.output ?? ''}
          exitCode={event.exitCode}
        />
      );
    case 'tool_call':
      return <ToolCallEvent toolName={event.toolName ?? ''} toolInput={event.toolInput} />;
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
    case 'goal_update':
      return event.goal ? <GoalUpdateEvent goal={event.goal} /> : null;
    case 'goal_cleared':
      return <GoalClearedEvent />;
    case 'error':
      return <ErrorEvent message={event.errorMessage ?? 'Unknown error'} />;
    case 'status':
      return <StatusEvent status={event.status ?? 'executing'} />;
    default:
      return null;
  }
}

export function ActivityGroupMessage({
  events,
}: {
  events: Array<CodexEvent & { sessionId?: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedEditIndex, setSelectedEditIndex] = useState(0);
  const summary = summarizeActivityEvents(events);
  const fileEdits = events.filter((event) => event.type === 'file_edit' && event.filePath);
  const failedCommands = events.filter(
    (event) =>
      event.type === 'command_exec' && typeof event.exitCode === 'number' && event.exitCode !== 0,
  );
  const selectedEdit = fileEdits[Math.min(selectedEditIndex, Math.max(fileEdits.length - 1, 0))];
  const preview = events
    .slice(-3)
    .map(formatActivityPreview)
    .filter((value): value is string => Boolean(value))
    .join(' \u2022 ');

  return (
    <div className="message-bubble flex justify-start">
      <div className="w-full max-w-3xl rounded-lg border border-border-subtle bg-bg-secondary/45">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-bg-tertiary/45"
          aria-label={expanded ? 'Collapse activity details' : 'Expand activity details'}
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
                <span className="rounded-full bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error">
                  {failedCommands.length} failed
                </span>
              )}
            </div>
            {!expanded && preview && (
              <p className="truncate pt-1 text-xs text-text-tertiary">{preview}</p>
            )}
          </div>
        </button>
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
        {reviewOpen && selectedEdit && (
          <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)] border-t border-border-subtle">
            <div className="max-h-96 overflow-auto border-r border-border-subtle bg-bg-secondary/40 p-2">
              {fileEdits.map((event, index) => (
                <button
                  key={`${event.filePath}-${index}`}
                  type="button"
                  onClick={() => setSelectedEditIndex(index)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                    index === selectedEditIndex
                      ? 'bg-info/10 text-info'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                  title={event.filePath}
                >
                  <FileDiff size={12} className="shrink-0" />
                  <span className="min-w-0 truncate">{event.filePath}</span>
                </button>
              ))}
            </div>
            <div className="max-h-96 overflow-auto">
              {selectedEdit.diff?.trim() ? (
                <DiffViewer filePath={selectedEdit.filePath ?? ''} diff={selectedEdit.diff} />
              ) : (
                <p className="px-4 py-3 text-xs text-text-tertiary">
                  Change applied, but Codex did not provide a renderable patch for this file.
                </p>
              )}
            </div>
          </div>
        )}
        {expanded && (
          <div className="max-h-96 space-y-2 overflow-auto border-t border-border-subtle p-3">
            {events.map((event, index) => (
              <ChatEventRenderer key={buildActivityEventKey(event, index)} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function TurnWorkMessage({
  items,
  active = false,
}: {
  items: ChatTurnWorkItem[];
  active?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const showDetails = expanded;
  const progressCount = items.filter((item) => item.kind === 'progress').length;
  const activityEvents = items
    .filter((item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> => item.kind === 'event')
    .map((item) => item.event);
  const blockingItems = items.filter(
    (item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> =>
      item.kind === 'event' &&
      (item.event.type === 'approval_request' || item.event.type === 'input_request'),
  );
  const blockingSourceIndexes = new Set(blockingItems.map((item) => item.sourceIndex));
  const failedCount = activityEvents.filter(
    (event) =>
      event.type === 'error' ||
      (event.type === 'command_exec' &&
        typeof event.exitCode === 'number' &&
        event.exitCode !== 0) ||
      (event.type === 'subagent_update' && event.subagent?.status === 'failed'),
  ).length;
  const summaryParts = [
    progressCount > 0 ? `${progressCount} update${progressCount === 1 ? '' : 's'}` : null,
    activityEvents.length > 0
      ? `${activityEvents.length} action${activityEvents.length === 1 ? '' : 's'}`
      : null,
  ].filter((part): part is string => Boolean(part));

  if (items.length === 0) return null;

  return (
    <div className="message-bubble flex justify-start">
      <div className="w-full max-w-[960px] border-y border-border-subtle/80">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="flex min-h-10 w-full items-center gap-2.5 py-2 text-left text-xs transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-expanded={showDetails}
          aria-label={showDetails ? 'Collapse work details' : 'Expand work details'}
        >
          <span className="shrink-0 text-text-tertiary">
            {showDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          {active ? (
            <WorkingDots compact />
          ) : (
            <Wrench size={12} className="shrink-0 text-text-tertiary" />
          )}
          <span className="font-medium text-text-secondary">{active ? 'Working' : 'Work'}</span>
          <span className="min-w-0 flex-1 truncate text-text-tertiary">
            {summaryParts.join(' · ') || 'Reasoning update'}
          </span>
          {failedCount > 0 && (
            <span className="rounded-full bg-error/10 px-2 py-0.5 font-medium text-error">
              {failedCount} failed
            </span>
          )}
        </button>

        {blockingItems.length > 0 && (
          <div className="space-y-2 border-t border-warning/20 py-3 pl-6 pr-2">
            {blockingItems.map((item, index) => (
              <ChatEventRenderer
                key={buildActivityEventKey(item.event, index)}
                event={item.event}
              />
            ))}
          </div>
        )}

        {showDetails && (
          <div className="space-y-3 border-t border-border-subtle/70 py-3 pl-6">
            {items.map((item, index) => {
              if (blockingSourceIndexes.has(item.sourceIndex)) return null;
              if (item.kind === 'progress') {
                return (
                  <div key={`progress-${item.sourceIndex}`} className="pr-2">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                      Update
                    </p>
                    <div className="text-text-secondary">
                      <MarkdownRenderer content={item.content} />
                    </div>
                  </div>
                );
              }

              if (item.kind === 'thinking') {
                return (
                  <div
                    key={`thinking-${item.sourceIndex}`}
                    className="pr-2 text-xs italic leading-relaxed text-text-tertiary"
                  >
                    {item.content}
                  </div>
                );
              }

              return (
                <ChatEventRenderer
                  key={buildActivityEventKey(item.event, index)}
                  event={item.event}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function TurnPendingMessage({ label = 'Thinking' }: { label?: string }) {
  return (
    <div className="message-bubble flex justify-start" role="status" aria-live="polite">
      <div className="flex min-h-9 items-center gap-2.5 text-xs text-text-tertiary">
        <WorkingDots />
        <span className="font-medium text-text-secondary">{label}</span>
      </div>
    </div>
  );
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

function TextEvent({ text }: { text: string }) {
  return <MarkdownRenderer content={text} />;
}

function FileReadEvent({
  filePath,
  lineRange,
}: {
  filePath: string;
  lineRange?: [number, number];
}) {
  const [expanded, setExpanded] = useState(false);
  const [copiedReference, setCopiedReference] = useState(false);
  const rangeStr = lineRange ? `:${lineRange[0]}-${lineRange[1]}` : '';
  const openInEditor = useOpenEventFileInEditor(filePath, lineRange?.[0]);
  const fileReference = buildChatFileReference(filePath, lineRange);

  const copyReference = useCallback(() => {
    if (!fileReference) return;
    void copyTextToClipboard(fileReference).then(() => {
      setCopiedReference(true);
      window.setTimeout(() => setCopiedReference(false), 1600);
    });
  }, [fileReference]);

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-tertiary/60 shadow-sm overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/80"
          aria-label={expanded ? 'Collapse file read details' : 'Expand file read details'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <FileText size={12} className="text-info" />
          <span className="min-w-0 truncate">
            Read{' '}
            <span className="font-mono text-text-primary">
              {filePath}
              {rangeStr}
            </span>
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
        {fileReference && (
          <button
            onClick={copyReference}
            className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title={copiedReference ? 'Copied reference' : 'Copy file reference'}
            aria-label={copiedReference ? 'Copied file reference' : 'Copy file reference'}
          >
            {copiedReference ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function buildChatFileReference(
  filePath: string,
  lineRange?: [number, number],
): string | null {
  if (!filePath) return null;
  if (!lineRange) return filePath;
  return `${filePath}:${lineRange[0]}-${lineRange[1]}`;
}

function FileEditEvent({ filePath, diff }: { filePath: string; diff: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copiedDiff, setCopiedDiff] = useState(false);
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
    <div className="rounded-xl border border-info/20 bg-bg-tertiary/60 shadow-sm overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/80"
          aria-label={expanded ? 'Collapse file edit details' : 'Expand file edit details'}
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
      {expanded && (
        <div className="border-t border-border-subtle">
          {hasDiff ? (
            <DiffViewer filePath={filePath} diff={diff} />
          ) : (
            <p className="px-4 py-3 text-xs text-text-tertiary">
              Change applied. Codex did not provide a renderable patch for this event.
            </p>
          )}
        </div>
      )}
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
  const [error, setError] = useState<string | null>(null);
  const isCommand = event.approvalKind === 'command';
  const isPermissions = event.approvalKind === 'permissions';
  const title = isCommand
    ? 'Approve command'
    : isPermissions
      ? 'Approve additional permissions'
      : 'Approve file change';
  const detail = isCommand
    ? event.approvalCommand
    : isPermissions
      ? formatRequestedPermissions(event.approvalPermissions)
      : event.approvalGrantRoot
        ? `Allow writes under ${event.approvalGrantRoot}`
        : 'Codex wants permission to apply a file change.';

  const decide = async (decision: 'accept' | 'acceptForSession' | 'decline') => {
    if (!event.sessionId || event.approvalRequestId === undefined) return;
    setError(null);
    try {
      await window.anvil.chat.resolveApproval(event.sessionId, event.approvalRequestId, decision);
      setResolved(decision === 'decline' ? 'declined' : 'accepted');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve approval');
    }
  };

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 shadow-sm overflow-hidden">
      <div className="flex items-start gap-2.5 px-4 py-3">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{title}</p>
          {detail && (
            <p className="mt-1 truncate font-mono text-xs text-text-secondary">{detail}</p>
          )}
          {isPermissions && event.approvalPermissions && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-bg-primary/60 p-2 font-mono text-[11px] text-text-secondary">
              {JSON.stringify(event.approvalPermissions, null, 2)}
            </pre>
          )}
          {event.approvalReason && (
            <p className="mt-1 text-xs text-text-tertiary">{event.approvalReason}</p>
          )}
          {event.approvalCwd && (
            <p className="mt-1 truncate text-xs text-text-tertiary">cwd: {event.approvalCwd}</p>
          )}
          {error && <p className="mt-2 text-xs text-error">{error}</p>}
          {resolved && (
            <p className="mt-2 text-xs text-text-tertiary">
              {resolved === 'accepted' ? 'Approved' : 'Declined'}
            </p>
          )}
        </div>
      </div>
      {!resolved && (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-2.5">
          <button
            onClick={() => void decide('accept')}
            className="flex items-center gap-1.5 rounded-lg border border-success/40 px-3 py-1.5 text-sm text-success transition-colors hover:bg-success/10"
          >
            <Check size={12} /> Approve
          </button>
          <button
            onClick={() => void decide('acceptForSession')}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary"
          >
            <Check size={12} /> Approve Session
          </button>
          <button
            onClick={() => void decide('decline')}
            className="flex items-center gap-1.5 rounded-lg border border-error/40 px-3 py-1.5 text-sm text-error transition-colors hover:bg-error/10"
          >
            <X size={12} /> Decline
          </button>
        </div>
      )}
    </div>
  );
}

function InputRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  if (!event.inputRequest) return null;
  return event.inputRequest.kind === 'user_input' ? (
    <UserInputRequestEvent event={event} />
  ) : (
    <McpElicitationRequestEvent event={event} />
  );
}

function UserInputRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const questions = event.inputRequest?.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const complete =
    questions.length > 0 && questions.every((question) => answers[question.id]?.trim());

  const submit = async () => {
    if (!event.sessionId || event.inputRequestId === undefined || !complete) return;
    setError(null);
    try {
      await window.anvil.chat.resolveInputRequest(event.sessionId, event.inputRequestId, {
        kind: 'user_input',
        answers: Object.fromEntries(
          questions.map((question) => [question.id, [answers[question.id].trim()]]),
        ),
      });
      setResolved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send answers');
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/5 shadow-sm">
      <div className="flex items-start gap-2.5 px-4 py-3">
        <MessageSquare size={14} className="mt-0.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">Codex needs your input</p>
          {event.inputRequest?.autoResolutionMs && (
            <p className="mt-1 text-xs text-text-tertiary">
              Codex may continue automatically after{' '}
              {Math.ceil(event.inputRequest.autoResolutionMs / 1000)} seconds.
            </p>
          )}
          <div className="mt-3 space-y-4">
            {questions.map((question) => {
              const options = question.options ?? [];
              const current = answers[question.id] ?? '';
              const isCustom = !options.some((option) => option.label === current);
              return (
                <fieldset key={question.id} disabled={resolved} className="space-y-2">
                  <legend className="text-xs font-medium text-text-primary">
                    {question.header}
                  </legend>
                  <p className="text-xs text-text-secondary">{question.question}</p>
                  {options.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {options.map((option) => {
                        const selected = current === option.label;
                        return (
                          <button
                            key={option.label}
                            type="button"
                            onClick={() =>
                              setAnswers((previous) => ({
                                ...previous,
                                [question.id]: option.label,
                              }))
                            }
                            className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                              selected
                                ? 'border-accent/60 bg-accent/10'
                                : 'border-border-subtle bg-bg-primary/40 hover:bg-bg-tertiary/60'
                            }`}
                          >
                            <span className="block text-xs font-medium text-text-primary">
                              {option.label}
                            </span>
                            {option.description && (
                              <span className="mt-0.5 block text-[11px] text-text-tertiary">
                                {option.description}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(question.isOther || options.length === 0) && (
                    <input
                      type={question.isSecret ? 'password' : 'text'}
                      value={isCustom ? current : ''}
                      onChange={(inputEvent) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [question.id]: inputEvent.target.value,
                        }))
                      }
                      placeholder={options.length > 0 ? 'Or enter another answer' : 'Your answer'}
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
                    />
                  )}
                </fieldset>
              );
            })}
          </div>
          {questions.length === 0 && (
            <p className="mt-2 text-xs text-error">Codex sent an empty input request.</p>
          )}
          {error && <p className="mt-2 text-xs text-error">{error}</p>}
          {resolved && <p className="mt-3 text-xs text-success">Answers sent</p>}
        </div>
      </div>
      {!resolved && questions.length > 0 && (
        <div className="border-t border-border-subtle px-4 py-2.5">
          <button
            type="button"
            disabled={!complete}
            onClick={() => void submit()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-success/40 px-3 py-1.5 text-sm text-success transition-colors hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check size={12} /> Send answers
          </button>
        </div>
      )}
    </div>
  );
}

function McpElicitationRequestEvent({ event }: { event: CodexEvent & { sessionId?: string } }) {
  const request = event.inputRequest;
  const [content, setContent] = useState('{}');
  const [resolved, setResolved] = useState<'accepted' | 'declined' | 'cancelled' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const decide = async (action: 'accept' | 'decline' | 'cancel') => {
    if (!event.sessionId || event.inputRequestId === undefined) return;
    setError(null);
    let parsedContent: unknown;
    if (action === 'accept' && request?.mode !== 'url') {
      try {
        parsedContent = JSON.parse(content);
      } catch {
        setError('Enter valid JSON before continuing.');
        return;
      }
    }
    try {
      await window.anvil.chat.resolveInputRequest(event.sessionId, event.inputRequestId, {
        kind: 'mcp_elicitation',
        action,
        ...(parsedContent === undefined ? {} : { content: parsedContent }),
      });
      setResolved(
        action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve request');
    }
  };

  const copyUrl = () => {
    if (!request?.url) return;
    void copyTextToClipboard(request.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-warning/30 bg-warning/5 shadow-sm">
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
              <code className="min-w-0 flex-1 truncate text-[11px] text-text-secondary">
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
                value={content}
                disabled={resolved !== null}
                onChange={(inputEvent) => setContent(inputEvent.target.value)}
                className="min-h-24 w-full resize-y rounded-lg border border-border bg-bg-primary p-2 font-mono text-xs text-text-primary outline-none focus:border-accent"
              />
              {request?.requestedSchema !== undefined && (
                <details className="mt-2 text-xs text-text-tertiary">
                  <summary className="cursor-pointer">Requested schema</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-primary/60 p-2 text-[11px]">
                    {JSON.stringify(request.requestedSchema, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
          {error && <p className="mt-2 text-xs text-error">{error}</p>}
          {resolved && <p className="mt-2 text-xs text-text-tertiary">Request {resolved}</p>}
        </div>
      </div>
      {!resolved && (
        <div className="flex flex-wrap gap-2 border-t border-border-subtle px-4 py-2.5">
          <button
            type="button"
            onClick={() => void decide('accept')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-success/40 px-3 py-1.5 text-sm text-success hover:bg-success/10"
          >
            <Check size={12} /> Continue
          </button>
          <button
            type="button"
            onClick={() => void decide('decline')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-error/40 px-3 py-1.5 text-sm text-error hover:bg-error/10"
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
    </div>
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
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-tertiary">
              {formatSubagentStatus(update.status, update.agents)}
            </span>
            {update.model && <span className="text-[10px] text-text-muted">{update.model}</span>}
          </div>
          {update.prompt && (
            <p className="mt-1 line-clamp-2 text-xs text-text-tertiary">{update.prompt}</p>
          )}
          {update.agents.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {update.agents.map((agent) => (
                <span
                  key={agent.threadId}
                  className="rounded-md border border-border-subtle bg-bg-primary/50 px-2 py-1 font-mono text-[10px] text-text-secondary"
                  title={agent.threadId}
                >
                  {agent.threadId.slice(0, 8)} · {agent.status}
                </span>
              ))}
            </div>
          )}
          {results.map((agent) => (
            <div
              key={`${agent.threadId}-result`}
              className="mt-3 max-h-96 overflow-auto border-t border-border-subtle pt-3 text-text-secondary"
            >
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Agent result
              </p>
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

function formatRequestedPermissions(permissions: Record<string, unknown> | undefined): string {
  if (!permissions) return 'Codex requested additional runtime permissions.';
  const scopes = [
    permissions.fileSystem ? 'filesystem' : null,
    permissions.network ? 'network' : null,
  ]
    .filter((scope): scope is string => Boolean(scope))
    .join(' and ');
  return scopes ? `Additional ${scopes} access requested.` : 'Additional permissions requested.';
}

function formatSubagentAction(
  tool: NonNullable<CodexEvent['subagent']>['tool'],
  activityKind: NonNullable<CodexEvent['subagent']>['activityKind'],
): string {
  if (activityKind) return `Subagent ${activityKind}`;
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
}: {
  command: string;
  output: string;
  exitCode?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const success = exitCode === 0 || exitCode === undefined;

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

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-tertiary/60 shadow-sm overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary/80"
          aria-label={expanded ? 'Collapse command output' : 'Expand command output'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Terminal size={12} className={success ? 'text-success' : 'text-error'} />
          <span className="min-w-0 truncate font-mono text-sm text-text-primary">{command}</span>
          {exitCode !== undefined && (
            <span className={`ml-auto shrink-0 text-xs ${success ? 'text-success' : 'text-error'}`}>
              exit {exitCode}
            </span>
          )}
        </button>
        {command && (
          <button
            onClick={copyCommand}
            className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title={copied ? 'Copied command' : 'Copy command'}
            aria-label={copied ? 'Copied command' : 'Copy command'}
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          </button>
        )}
        {output && (
          <button
            onClick={copyOutput}
            className="rounded-lg px-2 py-1.5 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title={copiedOutput ? 'Copied output' : 'Copy output'}
            aria-label={copiedOutput ? 'Copied output' : 'Copy output'}
          >
            {copiedOutput ? 'Copied' : 'Output'}
          </button>
        )}
      </div>
      {expanded && output && (
        <pre className="max-h-60 overflow-auto border-t border-border-subtle p-4 text-xs font-mono text-text-secondary leading-relaxed">
          {output}
        </pre>
      )}
    </div>
  );
}

function ToolCallEvent({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput?: Record<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-tertiary/60 shadow-sm overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary/80"
        aria-label={expanded ? 'Collapse tool call details' : 'Expand tool call details'}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Wrench size={12} />
        <span>
          Tool: <span className="text-text-secondary">{toolName}</span>
        </span>
      </button>
      {expanded && toolInput && (
        <pre className="max-h-40 overflow-auto border-t border-border-subtle p-4 text-xs font-mono text-text-tertiary leading-relaxed">
          {JSON.stringify(toolInput, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function PlanUpdateEvent({ plan }: { plan: NonNullable<CodexEvent['plan']> }) {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;

  return (
    <div className="overflow-hidden rounded-xl border border-info/25 bg-info/5 shadow-sm">
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
    <div className="rounded-xl border border-success/20 bg-success/5 px-4 py-3 shadow-sm">
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
    <div className="rounded-xl border border-border-subtle bg-bg-tertiary/50 px-4 py-3 text-sm text-text-tertiary shadow-sm">
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
    <div className="flex items-start gap-2.5 rounded-xl border border-error/20 bg-error/5 px-4 py-3 shadow-sm">
      <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
      <p className="text-sm text-error leading-relaxed">{message}</p>
    </div>
  );
}

function StatusEvent({ status }: { status: string }) {
  if (status === 'complete') return null;

  const label =
    {
      thinking: 'Thinking...',
      executing: 'Executing...',
    }[status] ?? status;

  return (
    <div className="flex items-center gap-2 py-1.5 text-sm text-text-tertiary">
      <Loader2 size={12} className="animate-spin" />
      {label}
    </div>
  );
}

export function ThinkingMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="message-bubble flex justify-start">
      <div className="w-full max-w-4xl overflow-hidden rounded-xl border border-border-subtle bg-bg-tertiary/30 shadow-sm">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary/50"
          aria-label={expanded ? 'Collapse thinking' : 'Expand thinking'}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Sparkles size={12} className={content ? 'text-warning' : ''} />
          <span className="font-medium">Reasoning...</span>
        </button>
        {expanded && content && (
          <div className="border-t border-border-subtle px-4 py-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed italic text-text-tertiary">
              {content}
            </p>
          </div>
        )}
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
    <div className="message-actions flex items-center gap-0.5 rounded-lg border border-border-subtle bg-bg-secondary/90 px-1 py-0.5 shadow-sm backdrop-blur-sm">
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
    <div className="message-bubble group flex justify-start">
      <div className="relative w-full max-w-[75ch]">
        <div
          className="mb-1.5 flex items-center gap-2 px-1 text-xs font-medium text-text-tertiary"
          role={active ? 'status' : undefined}
          aria-live={active ? 'polite' : undefined}
        >
          {active ? (
            <WorkingDots compact />
          ) : (
            <span
              className="h-1.5 w-1.5 rounded-full bg-text-tertiary"
              style={colour ? { backgroundColor: colour } : undefined}
              aria-hidden="true"
            />
          )}
          <span>{label}</span>
          {active && <span className="font-normal text-text-tertiary">Responding</span>}
        </div>
        <div className="px-1 text-text-secondary [&_.markdown-body>p]:text-[15px] [&_.markdown-body>p]:leading-7">
          <MarkdownRenderer content={display} />
        </div>
        <div className="message-actions mt-1">
          <MessageActionsToolbar
            onCopy={handleCopy}
            onBranch={onBranch}
            onRegenerate={onRegenerate}
            copied={copied}
          />
        </div>
      </div>
    </div>
  );
}

export function UserMessage({
  content,
  attachments,
  onEdit,
  onBranch,
}: {
  content: string;
  attachments?: ChatAttachment[];
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
    <div className="message-bubble group flex justify-end">
      <div
        className={`relative ${
          collapsible ? 'w-full max-w-[88%] sm:max-w-[90ch]' : 'w-fit max-w-[88%] sm:max-w-[72ch]'
        }`}
      >
        <p className="mb-1.5 text-right text-xs font-medium text-text-tertiary">You</p>
        <div
          className={`overflow-hidden rounded-xl border px-4 py-3 text-sm text-text-primary transition-colors ${
            collapsible
              ? 'border-border-subtle bg-bg-secondary/45 hover:border-border'
              : 'border-accent/25 bg-accent/10 hover:border-accent/35 hover:bg-accent/15'
          }`}
        >
          <div className={collapsible && !expanded ? 'max-h-64 overflow-hidden' : undefined}>
            {attachments && attachments.length > 0 && (
              <MessageAttachmentList attachments={attachments} />
            )}
            <p className="whitespace-pre-wrap break-words leading-relaxed">{content}</p>
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
        </div>
        <div className="message-actions mt-1 flex justify-end">
          <MessageActionsToolbar
            onCopy={handleCopy}
            onEdit={onEdit}
            onBranch={onBranch}
            copied={copied}
            isUser
          />
        </div>
      </div>
    </div>
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
        <p className="text-[11px] text-text-tertiary">{formatAttachmentBytes(attachment.size)}</p>
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
    summarizeActivityCount(events, 'file_read', 'file read'),
    summarizeActivityCount(events, 'file_edit', 'file edit'),
    summarizeActivityCount(events, 'approval_request', 'approval'),
    summarizeActivityCount(events, 'input_request', 'input request'),
    summarizeActivityCount(events, 'subagent_update', 'agent update'),
    summarizeActivityCount(events, 'plan_update', 'plan update'),
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
      return event.toolName ? `Tool: ${event.toolName}` : 'Tool call';
    case 'command_exec':
      return event.command?.trim() || 'Command output';
    case 'file_read':
      return event.filePath ? `Read ${event.filePath}` : 'File read';
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
    case 'goal_update':
      return event.goal ? `Goal: ${event.goal.objective}` : 'Goal update';
    case 'goal_cleared':
      return 'Goal cleared';
    default:
      return null;
  }
}

function buildActivityEventKey(event: CodexEvent & { sessionId?: string }, index: number): string {
  return [
    event.type,
    event.toolName,
    event.command,
    event.filePath,
    event.approvalRequestId === undefined ? undefined : String(event.approvalRequestId),
    event.inputRequestId === undefined ? undefined : String(event.inputRequestId),
    event.subagent?.id,
    event.protocolThreadId,
    event.plan?.updatedAt,
    event.goal?.updatedAt,
    event.status,
    String(index),
  ]
    .filter(Boolean)
    .join(':');
}
