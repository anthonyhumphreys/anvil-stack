import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AssistantMessage, TurnWorkMessage, UserMessage } from './ChatMessage';
import type { ComposedChatTurn } from './chat-turns';
import { agentProviderLabel } from '../../utils/agent-display';
import type { useChatRunTarget } from './useChatRunTarget';

const STATE_LABELS: Record<string, string> = {
  provisioning: 'Starting cloud worker',
  preparing: 'Preparing workspace',
  starting: 'Starting agent',
  running: 'Working',
  'awaiting-approval': 'Needs your approval',
  'cancel-requested': 'Stopping',
  completed: 'Turn complete',
  failed: 'Could not complete this turn',
  cancelled: 'Stopped',
  paused: 'Cloud worker paused. Send a message to resume.',
  ended: 'Cloud session ended. Start a new chat to continue in the cloud.',
  suspending: 'Saving workspace',
  checkpointing: 'Saving workspace',
  resuming: 'Resuming cloud worker',
};

export function RemoteThreadTranscript({
  run,
  priorTurns,
  personaName,
  personaColour,
  onReuseMessage,
}: {
  run: ReturnType<typeof useChatRunTarget>;
  priorTurns: ComposedChatTurn[];
  personaName: string;
  personaColour: string;
  onReuseMessage: (sourceIndex: number, content: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const record = run.record;
  useEffect(() => {
    if (followLatest.current) end.current?.scrollIntoView({ block: 'nearest' });
  }, [record?.updatedAt, run.activity.length]);
  if (!record) return null;
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
      role="region"
      aria-label="Chat transcript"
      tabIndex={0}
      onScroll={(event) => {
        const node = event.currentTarget;
        followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      }}
    >
      <div className="mx-auto w-full max-w-[1040px] space-y-6 px-4 pb-8 pt-6 xl:px-6">
        {priorTurns.map((turn) => (
          <section key={`local:${turn.key}`} className="space-y-4" aria-label="Earlier chat turn">
            {turn.user && (
              <UserMessage
                content={turn.user.content}
                attachments={turn.user.attachments}
                onEdit={() => onReuseMessage(turn.user!.sourceIndex, turn.user!.content)}
              />
            )}
            {turn.work.length > 0 && <TurnWorkMessage items={turn.work} active={false} />}
            {turn.answer && (
              <AssistantMessage
                content={turn.answer.content}
                label={personaName}
                colour={personaColour}
                active={false}
              />
            )}
            {turn.trailingWork.length > 0 && (
              <TurnWorkMessage items={turn.trailingWork} active={false} />
            )}
          </section>
        ))}
        {record.turns.map((turn) => (
          <section key={turn.id} className="space-y-4" aria-label="Chat turn">
            <div>
              <p className="mb-1 text-xs font-medium text-text-secondary">You</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
                {turn.prompt}
              </p>
            </div>
            {turn.response && (
              <div>
                <p className="mb-1 text-xs font-medium text-text-secondary">
                  {agentProviderLabel(record.provider)}
                </p>
                <MarkdownRenderer content={turn.response} />
              </div>
            )}
            {turn.error && (
              <p className="text-sm text-error" role="alert">
                {turn.error}
              </p>
            )}
          </section>
        ))}
        <div className="flex items-center gap-2 text-xs text-text-secondary" role="status">
          {run.busy && (
            <Loader2
              size={14}
              className="animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          )}
          <span>
            {STATE_LABELS[record.state] ?? record.state} ·{' '}
            {run.hosted ? 'Anvil hosted cloud' : 'Remote device'}
          </span>
        </div>
        {run.hosted && !run.busy && record.state !== 'ended' && (
          <details className="text-xs text-text-secondary">
            <summary className="cursor-pointer">Cloud session</summary>
            <p className="my-2 max-w-prose">
              End this session to stop its worker and discard its resumable workspace. This chat
              history stays available. Cloudflare may retain expired filesystem snapshots for up to
              30 days.
            </p>
            <button
              type="button"
              onClick={() => void run.endSession()}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              End cloud session
            </button>
          </details>
        )}
        {run.activity.length > 0 && (
          <details open={run.busy} className="text-xs text-text-secondary">
            <summary className="cursor-pointer">Activity</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap leading-relaxed">
              {run.activity
                .map(
                  (item) =>
                    `${item.gapBefore ? '[Some earlier activity is unavailable]\n' : ''}${item.text}`,
                )
                .join('\n')}
            </pre>
          </details>
        )}
        {run.approvals.map((approval) => (
          <div key={approval.id} className="space-y-2 border-t border-border py-3">
            <p className="text-sm font-medium text-text-primary">Approval requested</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-text-secondary">
              {approval.details ??
                'Action details are unavailable. Open Mesh executions to inspect this request.'}
            </pre>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!approval.details}
                onClick={() => void run.decide(approval.id, 'approved')}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void run.decide(approval.id, 'denied')}
                className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Deny
              </button>
            </div>
          </div>
        ))}
        {record.error && (
          <p role="alert" className="text-sm text-error">
            {record.error}
          </p>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
