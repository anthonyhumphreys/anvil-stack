import { Profiler, useCallback, useMemo, useRef, useState } from 'react';
import type { FormEvent, ProfilerOnRenderCallback } from 'react';
import type {
  ChatArtifact,
  ChatAttachment,
  ChatFollowUpIntent,
  ChatMessage,
  CodexSession,
  RepoInfo,
} from '../../../../shared/types';
import { ArtifactAnnotationsPanel } from '../ArtifactAnnotationsPanel';
import { ArtifactPreview } from '../ArtifactPreview';
import { ChatReviewFeedbackProvider } from '../ChatReviewFeedbackContext';
import { ChatInput } from '../ChatInput';
import { ChatTranscript } from '../ChatTranscript';
import { buildExecutionTopology } from '../../../utils/execution-topology';
import { composeChatTurns } from '../chat-turns';
import {
  formatChatReviewFeedbackPrompt,
  type ChatReviewFeedbackDraft,
} from '../chat-review-feedback';
import {
  CHAT_REPLAY_PROVENANCE,
  CHAT_REPLAY_SCENARIOS,
  getChatReplayScenario,
  syntheticFollowUpMessage,
  syntheticFollowUpResult,
} from './chat-replay-fixtures';
import { deriveReplayEntries, replayChatScenario } from './chat-replay-state';
import { useChatScroll } from '../useChatScroll';

interface ReplayPerformanceState {
  inputSamples: number[];
  inputToFrameSamples: number[];
  transcriptCommitSamples: number[];
  transcriptActualDurationSamples: number[];
  lastInputLatencyMs: number | null;
  lastInputToFrameMs: number | null;
  lastComposerActualDurationMs: number | null;
  transcriptCommitMs: number | null;
  transcriptActualDurationMs: number | null;
  transcriptRenderCount: number;
}

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PROVIDERS: never[] = [];
const MAX_INPUT_SAMPLES = 200;
const timestamp = '2026-09-25T09:00:00.000Z';
const sideQuestionSuffix = ':side-question';

function initialPerformanceState(): ReplayPerformanceState {
  return {
    inputSamples: [],
    inputToFrameSamples: [],
    transcriptCommitSamples: [],
    transcriptActualDurationSamples: [],
    lastInputLatencyMs: null,
    lastInputToFrameMs: null,
    lastComposerActualDurationMs: null,
    transcriptCommitMs: null,
    transcriptActualDurationMs: null,
    transcriptRenderCount: 0,
  };
}

const SYNTHETIC_ARTIFACT: ChatArtifact = {
  id: 'fixture-artifact-retry-policy-v2',
  threadId: 'fixture-artifact-review',
  repoId: 'fixture-synthetic-repo',
  sourceMessageId: 'artifact-answer',
  title: 'Retry policy',
  kind: 'code',
  storage: 'repository',
  relativePath: 'src/retry.ts',
  filePath: '/synthetic/anvil-demo/src/retry.ts',
  content: [
    'export function retryAllowed(attempt: number) {',
    '  return Number.isInteger(attempt) && attempt >= 0 && attempt < 3;',
    '}',
    '',
    '// Artifact revision v2; all content here is synthetic.',
  ].join('\n'),
  version: 2,
  status: 'draft',
  visibility: 'local',
  source: 'assistant',
  model: 'synthetic-fixture-model',
  createdAt: timestamp,
  updatedAt: timestamp,
};

const SYNTHETIC_REPO: RepoInfo = {
  id: 'fixture-synthetic-repo',
  name: 'anvil-demo (synthetic)',
  path: '/synthetic/anvil-demo',
  defaultBranch: 'main',
  languages: [{ language: 'TypeScript', percentage: 100, fileCount: 2 }],
  status: 'connected',
  fileCount: 2,
  branchCount: 1,
};

function percentile(samples: number[], percent: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
}

function formatMilliseconds(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} ms`;
}

export function ChatReplayPreview() {
  const [scenarioId, setScenarioId] = useState(CHAT_REPLAY_SCENARIOS[0].id);
  const [cursor, setCursor] = useState(-1);
  const [selectedThreadId, setSelectedThreadId] = useState(
    CHAT_REPLAY_SCENARIOS[0].initialThreadId,
  );
  const [localMessagesByThread, setLocalMessagesByThread] = useState<Record<string, ChatMessage[]>>(
    {},
  );
  const [reviewPrefill, setReviewPrefill] = useState<{ id: string; text: string } | null>(null);
  const [retryDismissedAt, setRetryDismissedAt] = useState<string | null>(null);
  const [performanceState, setPerformanceState] =
    useState<ReplayPerformanceState>(initialPerformanceState);
  const [machineInfo, setMachineInfo] = useState(
    'Capture local machine details with the benchmark script.',
  );

  const scenario = getChatReplayScenario(scenarioId);
  const snapshot = useMemo(() => replayChatScenario(scenario, cursor), [scenario, cursor]);
  const scenarioMessages = snapshot.messagesByThread[selectedThreadId] ?? EMPTY_MESSAGES;
  const localMessages = localMessagesByThread[selectedThreadId] ?? EMPTY_MESSAGES;
  const messages = useMemo(
    () => [...scenarioMessages, ...localMessages],
    [localMessages, scenarioMessages],
  );
  const entries = useMemo(() => deriveReplayEntries(messages), [messages]);
  const turns = useMemo(() => composeChatTurns(entries), [entries]);
  const isSelectedThreadBusy =
    (scenario.id === 'streaming-rich-content' || scenario.id === 'parallel-agents-status') &&
    selectedThreadId === scenario.initialThreadId &&
    cursor >= 1 &&
    cursor < scenario.steps.length - 1;
  const sideThreadId = `${scenario.initialThreadId}${sideQuestionSuffix}`;
  const hasSideQuestion = (localMessagesByThread[sideThreadId]?.length ?? 0) > 0;
  const replayThreads = hasSideQuestion
    ? [...scenario.threads, { id: sideThreadId, title: 'Side question' }]
    : scenario.threads;
  const transport = snapshot.transportByThread[selectedThreadId] ?? { state: 'connected' as const };
  const retryKey = `${scenario.id}:${selectedThreadId}:${cursor}`;
  const retryDismissed = retryDismissedAt === retryKey;
  const transportError =
    transport.state === 'reconnecting' && !retryDismissed
      ? (transport.detail ?? 'Synthetic connection interruption')
      : null;
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const localMessageSequence = useRef(0);
  const nextInputSequence = useRef(0);
  const pendingInputStartRef = useRef<number | null>(null);
  const pendingInputMarkRef = useRef<string | null>(null);
  const pendingTranscriptStartRef = useRef<number | null>(null);
  const pendingTranscriptMarkRef = useRef<string | null>(null);
  const pendingTranscriptScenarioRef = useRef<string | null>(null);
  const transcriptCommitRef = useRef(0);
  const followUpSequenceRef = useRef(0);
  const followUpResultsRef = useRef(new Map<string, ReturnType<typeof syntheticFollowUpResult>>());

  const { showJumpToLatest, jumpToLatest } = useChatScroll({
    containerRef: messagesContainerRef,
    scopeKey: `chat-replay:${scenario.id}:${selectedThreadId}`,
    contentVersion: entries,
    // Every frame is already present in local fixture memory. No IPC hydration occurs.
    contentReady: true,
  });

  const topologySessions = useMemo<CodexSession[]>(
    () =>
      scenario.id === 'parallel-agents-status'
        ? [
            {
              id: 'fixture-main-session',
              personaId: 'coder',
              status: cursor < scenario.steps.length - 1 ? 'busy' : 'ready',
              startedAt: '2026-09-25T08:59:00.000Z',
              appThreadId: selectedThreadId,
              providerThreadId: 'fixture-main-protocol',
            },
          ]
        : [],
    [cursor, scenario.id, scenario.steps.length, selectedThreadId],
  );
  const topology = useMemo(
    () =>
      buildExecutionTopology({
        entries,
        sessions: topologySessions,
        threadId: selectedThreadId,
        rootLabel: 'Synthetic main agent',
      }),
    [entries, selectedThreadId, topologySessions],
  );

  const markTranscriptStart = useCallback(
    (label: string) => {
      const start = performance.now();
      const mark = `chat-replay:${scenario.id}:${label}:${performance.now().toFixed(3)}`;
      pendingTranscriptStartRef.current = start;
      pendingTranscriptMarkRef.current = mark;
      pendingTranscriptScenarioRef.current = scenario.id;
      performance.mark(`${mark}:start`);
    },
    [scenario.id],
  );

  const onProfileRender: ProfilerOnRenderCallback = useCallback(
    (id, _phase, actualDuration, _baseDuration, _startTime, commitTime) => {
      if (id === 'transcript') {
        const start = pendingTranscriptStartRef.current;
        const mark = pendingTranscriptMarkRef.current;
        const measuredScenarioId = pendingTranscriptScenarioRef.current;
        if (start === null || mark === null || measuredScenarioId === null) return;

        pendingTranscriptStartRef.current = null;
        pendingTranscriptMarkRef.current = null;
        pendingTranscriptScenarioRef.current = null;
        transcriptCommitRef.current += 1;
        const elapsed = Math.max(0, commitTime - start);
        performance.mark(`${mark}:commit`);
        performance.measure(`${mark}:transcript-to-commit`, {
          start,
          end: commitTime,
          detail: { synthetic: true, scenarioId: measuredScenarioId },
        });
        setPerformanceState((current) => ({
          ...current,
          transcriptCommitMs: elapsed,
          transcriptCommitSamples: [...current.transcriptCommitSamples, elapsed].slice(
            -MAX_INPUT_SAMPLES,
          ),
          transcriptActualDurationMs: actualDuration,
          transcriptActualDurationSamples: [
            ...current.transcriptActualDurationSamples,
            actualDuration,
          ].slice(-MAX_INPUT_SAMPLES),
          transcriptRenderCount: transcriptCommitRef.current,
        }));
        return;
      }

      if (id !== 'composer') return;
      const inputStart = pendingInputStartRef.current;
      const inputMark = pendingInputMarkRef.current;
      if (inputStart === null || inputMark === null) return;

      pendingInputStartRef.current = null;
      pendingInputMarkRef.current = null;
      const latency = Math.max(0, commitTime - inputStart);
      performance.mark(`${inputMark}:commit`);
      performance.measure(`${inputMark}:input-to-react-commit`, {
        start: inputStart,
        end: commitTime,
        detail: { synthetic: true, scenarioId: scenario.id },
      });
      setPerformanceState((current) => ({
        ...current,
        inputSamples: [...current.inputSamples, latency].slice(-MAX_INPUT_SAMPLES),
        lastInputLatencyMs: latency,
        lastComposerActualDurationMs: actualDuration,
      }));
    },
    [scenario.id],
  );

  const onComposerInputCapture = useCallback(
    (event: FormEvent<HTMLElement>) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      const inputStart = performance.now();
      const mark = `chat-replay:${scenario.id}:composer-input:${++nextInputSequence.current}`;
      pendingInputStartRef.current = inputStart;
      pendingInputMarkRef.current = mark;
      performance.mark(`${mark}:start`);
      requestAnimationFrame((frameTime) => {
        const latency = Math.max(0, frameTime - inputStart);
        performance.mark(`${mark}:next-frame`);
        performance.measure(`${mark}:input-to-next-frame`, {
          start: inputStart,
          end: frameTime,
          detail: { synthetic: true, scenarioId: scenario.id },
        });
        setPerformanceState((current) => ({
          ...current,
          inputToFrameSamples: [...current.inputToFrameSamples, latency].slice(-MAX_INPUT_SAMPLES),
          lastInputToFrameMs: latency,
        }));
      });
    },
    [scenario.id],
  );

  const selectScenario = useCallback(
    (nextScenarioId: string) => {
      const nextScenario = getChatReplayScenario(nextScenarioId);
      markTranscriptStart('scenario-load');
      setScenarioId(nextScenario.id);
      setCursor(-1);
      setSelectedThreadId(nextScenario.initialThreadId);
      setLocalMessagesByThread({});
      setReviewPrefill(null);
      setRetryDismissedAt(null);
    },
    [markTranscriptStart],
  );

  const stepForward = useCallback(() => {
    const nextCursor = Math.min(cursor + 1, scenario.steps.length - 1);
    if (nextCursor === cursor) return;
    const nextSnapshot = replayChatScenario(scenario, nextCursor);
    markTranscriptStart('step');
    setCursor(nextCursor);
    setSelectedThreadId(nextSnapshot.activeThreadId);
    setRetryDismissedAt(null);
  }, [cursor, markTranscriptStart, scenario]);

  const showCompleteScenario = useCallback(() => {
    if (cursor === scenario.steps.length - 1) return;
    markTranscriptStart('complete-scenario');
    setCursor(scenario.steps.length - 1);
    setSelectedThreadId(replayChatScenario(scenario).activeThreadId);
    setRetryDismissedAt(null);
  }, [cursor, markTranscriptStart, scenario]);

  const retryLocally = useCallback(() => {
    setRetryDismissedAt(retryKey);
  }, [retryKey]);

  const appendLocalMessage = useCallback(
    (content: string, _attachments?: ChatAttachment[]) => {
      if (!content.trim()) return;
      localMessageSequence.current += 1;
      const localMessage: ChatMessage = {
        id: `local-preview-message-${localMessageSequence.current}`,
        role: 'user',
        content,
        timestamp,
        threadId: selectedThreadId,
        personaId: 'coder',
      };
      setLocalMessagesByThread((current) => ({
        ...current,
        [selectedThreadId]: [...(current[selectedThreadId] ?? []), localMessage],
      }));
      return true;
    },
    [selectedThreadId],
  );

  const switchThread = useCallback(
    (threadId: string) => {
      if (threadId === selectedThreadId) return;
      markTranscriptStart('thread-switch');
      setSelectedThreadId(threadId);
      setRetryDismissedAt(null);
    },
    [markTranscriptStart, selectedThreadId],
  );

  const captureMachineInfo = useCallback(() => {
    setMachineInfo(
      'Run `node scripts/chat-replay-machine.mjs` in a terminal to capture exact host details.',
    );
  }, []);

  const clearMeasurements = useCallback(() => {
    for (const entry of performance.getEntriesByType('measure')) {
      if (entry.name.startsWith('chat-replay:')) performance.clearMeasures(entry.name);
    }
    for (const entry of performance.getEntriesByType('mark')) {
      if (entry.name.startsWith('chat-replay:')) performance.clearMarks(entry.name);
    }
    pendingInputStartRef.current = null;
    pendingInputMarkRef.current = null;
    pendingTranscriptStartRef.current = null;
    pendingTranscriptMarkRef.current = null;
    pendingTranscriptScenarioRef.current = null;
    transcriptCommitRef.current = 0;
    setPerformanceState(initialPerformanceState());
  }, []);

  const deliverSyntheticFollowUp = useCallback(
    async (
      intent: ChatFollowUpIntent,
      content: string,
      _attachments: ChatAttachment[] | undefined,
      requestId: string,
    ) => {
      const priorResult = followUpResultsRef.current.get(requestId);
      if (priorResult) return priorResult;
      followUpSequenceRef.current += 1;
      const result = syntheticFollowUpResult(intent, requestId, followUpSequenceRef.current);
      followUpResultsRef.current.set(requestId, result);
      const entry = syntheticFollowUpMessage(selectedThreadId, content, _attachments, result);
      setLocalMessagesByThread((current) => ({
        ...current,
        [selectedThreadId]: [...(current[selectedThreadId] ?? []), entry],
      }));
      return result;
    },
    [selectedThreadId],
  );

  const askSyntheticSideQuestion = useCallback(
    async (content: string, _attachments?: ChatAttachment[]) => {
      if (!content.trim() || !isSelectedThreadBusy) return false;
      const now = Date.now();
      const userMessage: ChatMessage = {
        id: `side-question-user-${now}`,
        role: 'user',
        content,
        timestamp,
        threadId: sideThreadId,
        personaId: 'coder',
      };
      const answer: ChatMessage = {
        id: `side-question-answer-${now}`,
        role: 'assistant',
        content:
          'Synthetic side-thread answer: this stays separate from the active task and does not steer it.',
        timestamp,
        threadId: sideThreadId,
        personaId: 'coder',
      };
      setLocalMessagesByThread((current) => ({
        ...current,
        [sideThreadId]: [...(current[sideThreadId] ?? []), userMessage, answer],
      }));
      setSelectedThreadId(sideThreadId);
      setRetryDismissedAt(null);
      return true;
    },
    [isSelectedThreadBusy, sideThreadId],
  );

  const composeReviewFeedback = useCallback(
    (draft: ChatReviewFeedbackDraft) => {
      switchThread(draft.threadId);
      setReviewPrefill({
        id: `synthetic-review-feedback-${Date.now()}`,
        text: formatChatReviewFeedbackPrompt(draft),
      });
    },
    [switchThread],
  );

  const medianInputMs = percentile(performanceState.inputSamples, 50);
  const p95InputMs = percentile(performanceState.inputSamples, 95);
  const medianInputToFrameMs = percentile(performanceState.inputToFrameSamples, 50);
  const p95InputToFrameMs = percentile(performanceState.inputToFrameSamples, 95);
  const p95TranscriptCommitMs = percentile(performanceState.transcriptCommitSamples, 95);
  const p95TranscriptRenderMs = percentile(performanceState.transcriptActualDurationSamples, 95);
  const transportLabel = retryDismissed ? 'Connected · local retry' : transport.state;
  const messagesLoaded = messages.length;
  const activeStep = cursor + 1;
  const scenarioProgress = `${Math.min(activeStep, scenario.steps.length)} / ${scenario.steps.length}`;

  return (
    <main className="flex h-screen min-h-[640px] flex-col bg-bg-primary text-text-primary">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-bg-secondary px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-eyebrow font-semibold uppercase tracking-wide text-warning">
              Synthetic replay · local only
            </span>
            <span className="truncate text-xs text-text-tertiary">
              No provider or IPC connection
            </span>
          </div>
          <p className="mt-1 truncate text-sm font-medium">{scenario.title}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCursor(-1);
              setSelectedThreadId(scenario.initialThreadId);
              setLocalMessagesByThread({});
              setReviewPrefill(null);
              setRetryDismissedAt(null);
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
          >
            Replay
          </button>
          <button
            type="button"
            onClick={stepForward}
            disabled={cursor >= scenario.steps.length - 1}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Step {scenarioProgress}
          </button>
          <button
            type="button"
            onClick={showCompleteScenario}
            disabled={cursor >= scenario.steps.length - 1}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            Show complete
          </button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex min-h-0 min-w-0 flex-col border-r border-border">
          {replayThreads.length > 1 && (
            <nav
              aria-label="Synthetic replay threads"
              className="flex shrink-0 gap-2 border-b border-border-subtle px-5 py-2"
            >
              {replayThreads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  aria-current={thread.id === selectedThreadId ? 'page' : undefined}
                  onClick={() => switchThread(thread.id)}
                  className={`max-w-[260px] truncate rounded-lg px-3 py-1.5 text-xs transition-colors ${
                    thread.id === selectedThreadId
                      ? 'bg-bg-elevated text-text-primary'
                      : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'
                  }`}
                >
                  {thread.title}
                </button>
              ))}
            </nav>
          )}

          <div className="min-h-0 flex-1">
            <ChatReviewFeedbackProvider
              threadId={selectedThreadId}
              onComposeFeedback={composeReviewFeedback}
            >
              <Profiler id="transcript" onRender={onProfileRender}>
                <ChatTranscript
                  paneKind="transcript"
                  personaId="coder"
                  hasRepos
                  hasGovernanceDocs={false}
                  isDbExpertPersona={false}
                  onSuggestionClick={() => undefined}
                  turns={turns}
                  activeThreadId={selectedThreadId}
                  busy={isSelectedThreadBusy}
                  isBaPersona={false}
                  personaName="Coder"
                  personaColour="#48d597"
                  changesRepos={scenario.id === 'artifact-diff-feedback' ? [SYNTHETIC_REPO] : []}
                  error={transportError}
                  errorProviders={EMPTY_PROVIDERS}
                  onErrorRetry={retryLocally}
                  messagesContainerRef={messagesContainerRef}
                  messagesEndRef={messagesEndRef}
                  showJumpToLatest={showJumpToLatest}
                  onJumpToLatest={jumpToLatest}
                  onReuseMessage={() => undefined}
                />
              </Profiler>
            </ChatReviewFeedbackProvider>
          </div>

          <div
            onInputCapture={onComposerInputCapture}
            className="shrink-0 border-t border-border bg-bg-secondary px-4 pb-4 pt-3"
          >
            <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-text-tertiary">
              <span>Composer input is local to this replay page.</span>
              <span>Enter sends a local fixture message · Shift+Enter adds a line</span>
            </div>
            <Profiler id="composer" onRender={onProfileRender}>
              <ChatInput
                onSend={appendLocalMessage}
                disabled={false}
                busy={isSelectedThreadBusy}
                followUpCapabilities={
                  isSelectedThreadBusy
                    ? { guide: true, queue: scenario.id === 'parallel-agents-status' }
                    : undefined
                }
                onFollowUp={deliverSyntheticFollowUp}
                sideQuestionAvailable={
                  isSelectedThreadBusy && scenario.id === 'parallel-agents-status'
                }
                onSideQuestion={askSyntheticSideQuestion}
                personaColour="#48d597"
                model="synthetic-fixture-model"
                modelProvider="codex"
                draftKey={`anvil:chat-replay:${scenario.id}:${selectedThreadId}`}
                prefill={reviewPrefill}
                showSyntaxHint={false}
              />
            </Profiler>
          </div>
        </section>

        <aside className="flex min-h-0 flex-col gap-5 overflow-y-auto bg-bg-secondary/40 p-4">
          <section>
            <p className="text-eyebrow uppercase tracking-wide text-text-tertiary">Scenario</p>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{scenario.description}</p>
            <label
              className="mt-3 block text-xs font-medium text-text-tertiary"
              htmlFor="chat-replay-scenario"
            >
              Select fixture
            </label>
            <select
              id="chat-replay-scenario"
              value={scenario.id}
              onChange={(event) => selectScenario(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-bg-primary px-2.5 py-2 text-xs text-text-primary"
            >
              {CHAT_REPLAY_SCENARIOS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Metric label="Replay step" value={scenarioProgress} />
              <Metric label="Messages loaded" value={String(messagesLoaded)} />
              <Metric label="Connection" value={transportLabel} />
              <Metric label="Thread" value={selectedThreadId} />
            </div>
            <p className="mt-3 rounded-lg border border-border-subtle bg-bg-primary/60 p-2.5 text-xs leading-5 text-text-tertiary">
              {CHAT_REPLAY_PROVENANCE}
            </p>
          </section>

          {scenario.id === 'artifact-diff-feedback' && (
            <section
              className="border-t border-border-subtle pt-4"
              aria-label="Synthetic artifact revision"
            >
              <div className="mb-2">
                <p className="text-eyebrow uppercase tracking-wide text-text-tertiary">
                  Artifact revision
                </p>
                <p className="mt-1 text-xs leading-5 text-text-tertiary">
                  Select source text, add feedback, then compose it back into this thread.
                </p>
              </div>
              <div className="max-h-56 overflow-auto rounded-lg border border-border bg-bg-primary">
                <div data-artifact-review-source data-artifact-exact-lines="true">
                  <ArtifactPreview artifact={SYNTHETIC_ARTIFACT} mode="source" />
                </div>
              </div>
              <ArtifactAnnotationsPanel
                artifact={SYNTHETIC_ARTIFACT}
                mode="source"
                onComposeFeedback={composeReviewFeedback}
              />
              {reviewPrefill && selectedThreadId === SYNTHETIC_ARTIFACT.threadId && (
                <p className="mt-2 rounded-lg border border-info/25 bg-info/5 p-2 text-xs leading-5 text-info">
                  Local composer prefilled with the exact revision, selected quote, and line range.
                </p>
              )}
            </section>
          )}

          <section className="border-t border-border-subtle pt-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-eyebrow uppercase tracking-wide text-text-tertiary">
                  Local performance
                </p>
                <p className="mt-1 text-xs leading-5 text-text-tertiary">
                  User Timing and React Profiler · synthetic scenario
                </p>
              </div>
              <button
                type="button"
                onClick={captureMachineInfo}
                className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover"
              >
                Machine details
              </button>
              <button
                type="button"
                onClick={clearMeasurements}
                className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover"
              >
                Reset measurements
              </button>
            </div>
            <div className="mt-3 space-y-2 text-xs">
              <Metric
                label="Input → React commit · latest"
                value={formatMilliseconds(performanceState.lastInputLatencyMs)}
              />
              <Metric
                label="Input → React commit · p50"
                value={formatMilliseconds(medianInputMs)}
              />
              <Metric label="Input → React commit · p95" value={formatMilliseconds(p95InputMs)} />
              <Metric
                label="Input → next frame · latest"
                value={formatMilliseconds(performanceState.lastInputToFrameMs)}
              />
              <Metric
                label="Input → next frame · p50"
                value={formatMilliseconds(medianInputToFrameMs)}
              />
              <Metric
                label="Input → next frame · p95"
                value={formatMilliseconds(p95InputToFrameMs)}
              />
              <Metric
                label="Composer React actualDuration"
                value={formatMilliseconds(performanceState.lastComposerActualDurationMs)}
              />
              <Metric
                label="Transcript change → commit"
                value={formatMilliseconds(performanceState.transcriptCommitMs)}
              />
              <Metric
                label="Transcript change → commit · p95"
                value={formatMilliseconds(p95TranscriptCommitMs)}
              />
              <Metric
                label="Transcript React actualDuration"
                value={formatMilliseconds(performanceState.transcriptActualDurationMs)}
              />
              <Metric
                label="Transcript React actualDuration · p95"
                value={formatMilliseconds(p95TranscriptRenderMs)}
              />
              <Metric
                label="Measured transcript updates"
                value={String(performanceState.transcriptRenderCount)}
              />
              <Metric label="Input samples" value={String(performanceState.inputSamples.length)} />
            </div>
            <p className="mt-3 break-words rounded-lg border border-border-subtle bg-bg-primary/60 p-2.5 text-xs leading-5 text-text-tertiary">
              {machineInfo}
            </p>
          </section>

          <section className="border-t border-border-subtle pt-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-eyebrow uppercase tracking-wide text-text-tertiary">
                  Execution status
                </p>
                <p className="mt-1 text-xs leading-5 text-text-tertiary">
                  Derived through Anvil execution topology
                </p>
              </div>
              <span className="rounded-full bg-bg-elevated px-2 py-1 text-xs text-text-secondary">
                {topology.runningCount} running
              </span>
            </div>
            <ul className="mt-3 space-y-2">
              {topology.nodes.map((node) => (
                <li
                  key={node.id}
                  className="rounded-lg border border-border-subtle bg-bg-primary/60 px-2.5 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-text-secondary">
                      {node.label}
                    </span>
                    <span className="shrink-0 text-xs text-text-tertiary">{node.status}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-text-tertiary">
                    {node.latestMessage ?? node.detail}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border-subtle bg-bg-primary/50 px-2.5 py-2">
      <p className="text-xs leading-5 text-text-tertiary">{label}</p>
      <p className="mt-0.5 break-all text-xs font-medium text-text-secondary">{value}</p>
    </div>
  );
}
