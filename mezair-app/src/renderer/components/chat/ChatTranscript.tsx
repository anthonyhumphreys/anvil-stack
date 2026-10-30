import { useMemo, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, ArrowDown } from 'lucide-react';
import type { AgentProvider, RepoInfo } from '../../../shared/types';
import { buildChatTurnTimeline, type ComposedChatTurn } from './chat-turns';
import { SurfaceHost } from '../surfaces/SurfaceHost';
import { QuestionIntentSurface } from './AgentUIIntentSurface';
import { AssistantMessage, TurnWorkMessage, UserMessage } from './ChatMessage';
import { ChatErrorNotice, type ChatErrorProviderOption } from './ChatErrorNotice';
import { ChatPaneState, type ChatPaneKind } from './ChatPaneState';
import { TurnChangesFooter, TurnUsageFooter } from './TurnChangesFooter';
import { collectTurnFileChanges } from './chat-turn-changes';
import { getChatTurnLiveState } from './chat-view-utils';
import { ChatRunOutcomeFooter } from './ChatRunOutcomeFooter';
import {
  getPendingQuestionTarget,
  shouldShowRunOutcomeFooter,
  summarizeChatTurnRun,
} from './chat-run-outcome';
import { stripFindingMarkers } from '../../utils/finding-parser';
import type { StarterPrompt } from '../../utils/starter-prompts';
import { ChatDelegations } from './ChatDelegations';

/**
 * Scrollable transcript column — extracted from ChatView (Phase 5 split).
 * Hosts the derived pane state (blocked/scaffold/empty/pick-item), the turn
 * list with per-turn change footers (CH2), the classified error notice
 * (CH5), and the jump-to-latest pill.
 */
export function ChatTranscript({
  paneKind,
  scaffoldRootPath,
  blockedReason,
  onOpenWorkspace,
  personaId,
  hasRepos,
  hasGovernanceDocs,
  isDbExpertPersona,
  starterPrompts,
  onSuggestionClick,
  scaffoldBusyMessage,
  turns,
  activeThreadId,
  changeReviewThreadId,
  busy,
  isBaPersona,
  personaName,
  personaColour,
  onBranch,
  onReuseMessage,
  changesRepos,
  changesPreferredRepoId,
  error,
  errorRetryLabel,
  errorProviders,
  onErrorRetry,
  onSwitchProvider,
  messagesContainerRef,
  messagesEndRef,
  showJumpToLatest,
  onJumpToLatest,
}: {
  paneKind: ChatPaneKind;
  scaffoldRootPath?: string;
  blockedReason?: string;
  onOpenWorkspace?: () => void;
  personaId: string;
  hasRepos: boolean;
  hasGovernanceDocs: boolean;
  isDbExpertPersona: boolean;
  /** C2 — repo-grounded prompts; the empty state falls back to persona sets. */
  starterPrompts?: StarterPrompt[];
  onSuggestionClick: (prompt: string) => void;
  scaffoldBusyMessage?: string;
  turns: ComposedChatTurn[];
  activeThreadId: string | null;
  changeReviewThreadId?: string;
  busy: boolean;
  isBaPersona: boolean;
  personaName: string;
  personaColour: string;
  onBranch?: (sourceIndex: number) => void;
  onReuseMessage: (sourceIndex: number, content: string) => void;
  changesRepos: RepoInfo[];
  changesPreferredRepoId?: string | null;
  error: string | null;
  errorRetryLabel?: string;
  errorProviders: ChatErrorProviderOption[];
  onErrorRetry?: () => void;
  onSwitchProvider?: (provider: AgentProvider) => void;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  showJumpToLatest: boolean;
  onJumpToLatest: () => void;
}) {
  const [reviewRequest, setReviewRequest] = useState<{
    threadId: string | null;
    turnKey: string;
    filePath: string;
    requestId: number;
  } | null>(null);
  const reviewRequestSequence = useRef(0);
  const pendingQuestionTarget = getPendingQuestionTarget(turns);
  const centered = paneKind !== 'transcript';
  const liveTurnIndex = turns.length - 1;
  const laterEditedPathsByTurn = useMemo(() => {
    const result = new Map<string, string[]>();
    const seen = new Set<string>();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      result.set(turn.key, [...seen]);
      for (const change of collectTurnFileChanges([...turn.work, ...turn.trailingWork])) {
        seen.add(change.filePath);
      }
    }
    return result;
  }, [turns]);

  const requestFileReview = (turnKey: string, filePath: string) => {
    reviewRequestSequence.current += 1;
    setReviewRequest({
      threadId: activeThreadId,
      turnKey,
      filePath,
      requestId: reviewRequestSequence.current,
    });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={messagesContainerRef}
        role="region"
        aria-label="Chat transcript"
        tabIndex={0}
        className={`h-full overflow-y-auto [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${centered ? 'flex' : ''}`}
      >
        <div
          data-chat-transcript-content
          className={`mx-auto w-full max-w-[1040px] px-4 xl:px-6 ${
            centered
              ? 'flex min-h-full flex-1 items-center justify-center py-6'
              : 'flex flex-col pb-8 pt-6'
          }`}
        >
          <ChatPaneState
            kind={paneKind}
            scaffoldRootPath={scaffoldRootPath}
            blockedReason={blockedReason}
            onOpenWorkspace={onOpenWorkspace}
            personaId={personaId}
            hasRepos={hasRepos}
            hasGovernanceDocs={hasGovernanceDocs}
            isDbExpertPersona={isDbExpertPersona}
            starterPrompts={starterPrompts}
            onSuggestionClick={onSuggestionClick}
          />

          {scaffoldBusyMessage && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-info/20 bg-info/5 px-4 py-3">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-info" />
              <p className="text-sm text-text-primary leading-relaxed">{scaffoldBusyMessage}</p>
            </div>
          )}

          {turns.length > 0 && (
            <div className="w-full space-y-6">
              {turns.map((turn, turnIndex) => {
                const liveState = getChatTurnLiveState({
                  busy,
                  isLatest: turnIndex === liveTurnIndex,
                  hasWork: turn.work.length > 0,
                  hasAnswer: Boolean(turn.answer),
                  hasTrailingWork: turn.trailingWork.length > 0,
                });
                const turnComplete = liveState === null;
                const timeline = buildChatTurnTimeline(turn);
                const lastWorkIndex = timeline.findLastIndex((item) => item.kind === 'work');
                const runSummary = summarizeChatTurnRun(turn, {
                  busy: busy && turnIndex === liveTurnIndex,
                  pendingTarget: pendingQuestionTarget,
                });

                return (
                  <section
                    key={`${activeThreadId ?? 'new'}:${turn.key}`}
                    data-chat-turn-key={turn.key}
                    className="w-full space-y-4"
                    aria-label={`Turn ${turnIndex + 1}`}
                  >
                    {turn.user && (
                      <UserMessage
                        content={turn.user.content}
                        attachments={turn.user.attachments}
                        delivery={turn.user.delivery}
                        deliveryError={turn.user.deliveryError}
                        deliveryIntent={turn.user.deliveryIntent}
                        onEdit={() => onReuseMessage(turn.user!.sourceIndex, turn.user!.content)}
                        onBranch={onBranch ? () => onBranch(turn.user!.sourceIndex) : undefined}
                      />
                    )}
                    {timeline.map((item, index) => {
                      if (item.kind === 'work') {
                        const currentWork = index === lastWorkIndex;
                        return (
                          <TurnWorkMessage
                            key={item.key}
                            items={item.items}
                            active={currentWork && liveState !== null}
                            outcome={turnComplete ? turn.runOutcome : undefined}
                            waiting={currentWork && runSummary?.state === 'awaiting-user'}
                            answering={liveState === 'responding'}
                            startedAt={turn.startedAt}
                            endedAt={turn.endedAt}
                          />
                        );
                      }
                      if (item.kind === 'pending-message')
                        return (
                          <UserMessage
                            key={item.key}
                            content={item.entry.content}
                            attachments={item.entry.attachments}
                            delivery={item.entry.delivery}
                            deliveryError={item.entry.deliveryError}
                            deliveryIntent={item.entry.deliveryIntent}
                            onEdit={() =>
                              onReuseMessage(item.entry.sourceIndex, item.entry.content)
                            }
                          />
                        );
                      if (item.kind === 'surface')
                        return <SurfaceHost key={item.key} intent={item.intent} />;
                      if (item.kind === 'receipt')
                        return (
                          <div key={item.key} className="max-w-[72ch]">
                            <QuestionIntentSurface intent={item.intent} />
                          </div>
                        );
                      return (
                        <AssistantMessage
                          key={item.key}
                          content={item.entry.content}
                          transformContent={isBaPersona ? stripFindingMarkers : undefined}
                          label={personaName}
                          colour={personaColour}
                          active={liveState === 'responding'}
                          onBranch={onBranch ? () => onBranch(item.entry.sourceIndex) : undefined}
                        />
                      );
                    })}
                    {lastWorkIndex < 0 && !turn.answer && liveState && (
                      <TurnWorkMessage items={[]} active startedAt={turn.startedAt} />
                    )}
                    {/* H5 — usage/context/cost rollup for the turn. */}
                    {turn.usage && <TurnUsageFooter usage={turn.usage} />}
                    {runSummary && shouldShowRunOutcomeFooter(runSummary) && (
                      <ChatRunOutcomeFooter
                        summary={runSummary}
                        repos={changesRepos}
                        preferredRepoId={changesPreferredRepoId}
                        onReviewFile={
                          turnComplete
                            ? (filePath) => requestFileReview(turn.key, filePath)
                            : undefined
                        }
                      />
                    )}
                    {/* CH2 — settled turns surface their file changes. */}
                    {turnComplete && (turn.answer || turn.runOutcome || runSummary?.changes) && (
                      <TurnChangesFooter
                        workItems={[...turn.work, ...turn.trailingWork]}
                        repos={changesRepos}
                        preferredRepoId={changesPreferredRepoId}
                        threadId={changeReviewThreadId}
                        turnId={turn.key}
                        laterTurnEditedPaths={laterEditedPathsByTurn.get(turn.key)}
                        reviewRequest={
                          reviewRequest?.threadId === activeThreadId &&
                          reviewRequest.turnKey === turn.key
                            ? reviewRequest
                            : undefined
                        }
                      />
                    )}
                  </section>
                );
              })}
            </div>
          )}

          {activeThreadId && paneKind === 'transcript' && (
            <ChatDelegations key={activeThreadId} threadId={activeThreadId} />
          )}
          {error && (
            <ChatErrorNotice
              error={error}
              retryLabel={errorRetryLabel}
              providers={errorProviders}
              onRetry={onErrorRetry}
              onSwitchProvider={onSwitchProvider}
            />
          )}
        </div>
        <div ref={messagesEndRef} />
      </div>
      {showJumpToLatest && turns.length > 0 && (
        <button
          type="button"
          onClick={onJumpToLatest}
          className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-elevated px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg transition-colors hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <ArrowDown size={13} />
          {busy ? 'Jump to live work' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
