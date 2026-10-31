import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Code2, Laptop } from 'lucide-react';
import type { AgentProvider, CodexEvent, CodexMode } from '../../../../shared/types';
import { isAcpAgentProvider } from '../../../../shared/agent-providers';
import type { ChatEntry } from '../../../contexts/ChatContext';
import { ChatInput } from '../ChatInput';
import { ChatTranscript } from '../ChatTranscript';
import { composeChatTurns } from '../chat-turns';
import { chatAccessOptionsForProvider } from '../thread-access';
import { ChatInteractionPreview } from './ChatInteractionPreview';

const providers: AgentProvider[] = ['codex', 'openai', 'azure', 'llmgateway', 'cursor', 'devin'];
const states = [
  'live',
  'working',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'responding',
  'history',
  'starting',
  'showcase',
] as const;
type FixtureState = (typeof states)[number];
const noop = () => undefined;

type LiveStep = (tick: number) => CodexEvent;
/** A scripted run for the `live` fixture: one step lands every few seconds. */
const LIVE_STEPS: LiveStep[] = [
  () => ({
    type: 'tool_call',
    itemId: 'live-read',
    toolName: 'read_file',
    toolStatus: 'completed',
    toolInput: { path: 'src/retry.ts' },
  }),
  () => ({
    type: 'tool_call',
    itemId: 'live-search',
    toolName: 'search',
    toolStatus: 'completed',
    toolInput: { query: 'MAX_ATTEMPTS' },
  }),
  (tick) => ({
    type: 'command_exec',
    itemId: 'live-tests',
    command: 'pnpm test -- retry.test.ts',
    output: '✓ accepts attempts 0–2\n✓ rejects attempts outside the limit',
    ...(tick > 3 ? { exitCode: 0, toolStatus: 'completed' } : { toolStatus: 'running' }),
  }),
  () => ({
    type: 'file_edit',
    itemId: 'live-edit',
    filePath: 'src/retry.ts',
    diff: '@@ -1 +1 @@\n-export const MAX_ATTEMPTS = 3;\n+export const MAX_ATTEMPTS = 3 as const;',
  }),
];

const SHOWCASE_TASK =
  'Checkout retries give up too early on flaky mobile networks. Raise the limit to 5, keep the backoff, and add a test that proves the fifth attempt runs.';

/** A complete, realistic turn for screenshots: reproduce, fix, verify. */
const SHOWCASE_EVENTS: CodexEvent[] = [
  {
    type: 'tool_call',
    itemId: 'show-read',
    toolName: 'read_file',
    toolStatus: 'completed',
    toolInput: { path: 'src/lib/retry.ts' },
    toolOutput: "import { sleep } from './time';\n\nexport const MAX_ATTEMPTS = 3;",
  },
  {
    type: 'tool_call',
    itemId: 'show-search',
    toolName: 'search',
    toolStatus: 'completed',
    toolInput: { query: 'withRetry(' },
    toolOutput: 'src/checkout/submit.ts:14\nsrc/search/client.ts:9',
  },
  {
    type: 'file_edit',
    itemId: 'show-test-edit',
    filePath: 'test/retry.test.ts',
    diff: "@@ -8,3 +8,12 @@\n   });\n+\n+  it('retries five times before giving up', async () => {\n+    let calls = 0;\n+    const flaky = async () => {\n+      calls += 1;\n+      if (calls < 5) throw new Error('ECONNRESET');\n+      return 'ok';\n+    };\n+    await expect(withRetry(flaky)).resolves.toBe('ok');\n+  });",
  },
  {
    type: 'command_exec',
    itemId: 'show-red',
    command: 'pnpm test -- retry',
    output:
      ' FAIL  test/retry.test.ts > withRetry > retries five times before giving up\nError: ECONNRESET\n Tests  1 failed | 1 passed (2)',
    exitCode: 1,
    toolStatus: 'failed',
  },
  {
    type: 'file_edit',
    itemId: 'show-fix',
    filePath: 'src/lib/retry.ts',
    diff: "@@ -1,4 +1,4 @@\n import { sleep } from './time';\n \n-export const MAX_ATTEMPTS = 3;\n+export const MAX_ATTEMPTS = 5;",
  },
  {
    type: 'command_exec',
    itemId: 'show-green',
    command: 'pnpm test',
    output:
      ' ✓ test/retry.test.ts (2)\n ✓ test/cart.test.ts (7)\n ✓ test/address.test.ts (5)\n Tests  14 passed (14)',
    exitCode: 0,
    toolStatus: 'completed',
  },
];

/** Development-only fixtures rendered with the real Electron shell and preload. */
export default function ProcessingPreview() {
  const [interactions, setInteractions] = useState(false);
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [state, setState] = useState<FixtureState>(() =>
    window.location.hash.includes('showcase') ? 'showcase' : 'working',
  );
  const [width, setWidth] = useState<'wide' | 'narrow'>('wide');
  const [accessMode, setAccessMode] = useState<CodexMode>('on-request');
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const startedAt = useRef(new Date(Date.now() - 12_000).toISOString());
  const [tick, setTick] = useState(0);
  const liveFinished = state === 'live' && tick >= LIVE_STEPS.length + 2;
  const busy =
    (state === 'live' && !liveFinished) ||
    state === 'working' ||
    state === 'starting' ||
    state === 'waiting' ||
    state === 'responding';

  useEffect(() => {
    setTick(0);
    if (state !== 'live') return;
    startedAt.current = new Date().toISOString();
    const timer = window.setInterval(
      () => setTick((value) => (value > LIVE_STEPS.length + 1 ? value : value + 1)),
      2400,
    );
    return () => window.clearInterval(timer);
  }, [state]);
  const turns = useMemo(() => {
    const event = (value: CodexEvent): ChatEntry => ({
      kind: 'event',
      event: { ...value, sessionId: 'native-fixture', agentLabel: provider },
    });
    const entries: ChatEntry[] = [
      {
        kind: 'user',
        content: state === 'showcase' ? SHOWCASE_TASK : 'Check the retry policy and run its tests.',
        timestamp: startedAt.current,
      },
    ];
    if (state === 'showcase') {
      entries.push(
        {
          kind: 'thinking',
          content:
            'I’ll reproduce the early give-up with a failing test first, then raise the limit and run the whole suite.',
        },
        ...SHOWCASE_EVENTS.map(event),
        {
          kind: 'assistant',
          phase: 'final',
          content:
            'Raised `MAX_ATTEMPTS` from 3 to 5 in `src/lib/retry.ts`. The backoff still doubles from 100 ms, so the fifth attempt waits 1.6 s.\n\nAdded **retries five times before giving up** to `test/retry.test.ts`. It failed before the change and passes now. Full suite: 14 passed.',
        },
        {
          ...event({ type: 'turn_outcome', turnOutcome: 'completed' }),
          timestamp: new Date(Date.parse(startedAt.current) + 41_000).toISOString(),
        },
      );
      return composeChatTurns(entries, { active: false });
    }
    if (state === 'live') {
      for (const step of LIVE_STEPS.slice(0, tick)) entries.push(event(step(tick)));
      if (tick > LIVE_STEPS.length) {
        entries.push({
          kind: 'assistant',
          content: 'The retry policy rejects attempts outside 0–2. Both focused tests pass.',
        });
      }
      if (liveFinished) {
        entries.push({
          ...event({ type: 'turn_outcome', turnOutcome: 'completed' }),
          timestamp: new Date().toISOString(),
        });
      }
      return composeChatTurns(entries, { active: busy });
    }
    if (state !== 'starting') {
      entries.push(
        {
          kind: 'thinking',
          content: 'I’ll inspect the retry policy, then check the boundary cases.',
        },
        event({
          type: 'tool_call',
          itemId: 'read',
          toolName: 'read_file',
          toolStatus: 'completed',
          toolInput: { path: 'src/retry.ts' },
          toolOutput: 'export const MAX_ATTEMPTS = 3;',
        }),
        event({
          type: 'plan_update',
          plan: {
            updatedAt: startedAt.current,
            steps: [
              { step: 'Inspect retry policy', status: 'completed' },
              { step: 'Run focused tests', status: busy ? 'in_progress' : 'completed' },
            ],
          },
        }),
        event({
          type: 'command_exec',
          itemId: 'tests',
          command: 'pnpm test -- retry.test.ts',
          ...(state === 'responding' ? { exitCode: 0 } : {}),
          output:
            state === 'failed'
              ? 'FAIL retry.test.ts\nExpected attempt 3 to be rejected.'
              : 'RUN retry.test.ts\n✓ accepts attempts 0–2\n✓ rejects attempts outside the limit',
          toolStatus: busy ? 'running' : state === 'failed' ? 'failed' : 'completed',
          exitCode: busy ? undefined : state === 'failed' ? 1 : 0,
        }),
      );
    }
    if (state === 'waiting') {
      entries.push(
        event({
          type: 'approval_request',
          approvalRequestId: 'fixture-approval',
          approvalKind: 'command',
          approvalCommand: 'pnpm test',
          approvalReason: 'Run the full test suite?',
          approvalCwd: '/synthetic/project',
        }),
      );
    }
    if (state === 'completed' || state === 'responding') {
      entries.push({
        kind: 'assistant',
        phase: 'final',
        content:
          state === 'responding'
            ? 'The retry policy accepts attempts 0–2 and rejects'
            : 'The retry policy accepts attempts 0–2 and rejects values outside that range. Both tests passed.',
      });
    }
    if (state === 'completed' || state === 'failed' || state === 'stopped') {
      entries.push({
        ...event({
          type: 'turn_outcome',
          turnOutcome: state === 'stopped' ? 'interrupted' : state,
        }),
        timestamp: new Date(Date.parse(startedAt.current) + 12_000).toISOString(),
      });
    }
    return composeChatTurns(entries, { active: busy });
  }, [provider, state, busy, tick, liveFinished]);

  if (interactions) return <ChatInteractionPreview embedded />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        data-fixture-toolbar
        className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3 text-xs text-text-secondary"
      >
        <span className="mr-auto">Processing fixtures · isolated desktop preview</span>
        <button
          type="button"
          onClick={() => setInteractions(true)}
          className="rounded-md border border-border px-2.5 py-1.5 hover:bg-bg-tertiary"
        >
          Chat interactions
        </button>
        <label className="flex items-center gap-2">
          Provider
          <select
            aria-label="Fixture provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as AgentProvider)}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
          >
            {providers.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Width
          <select
            aria-label="Fixture width"
            value={width}
            onChange={(e) => setWidth(e.target.value as 'wide' | 'narrow')}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
          >
            <option>wide</option>
            <option>narrow</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          State
          <select
            aria-label="Fixture state"
            value={state}
            onChange={(e) => setState(e.target.value as FixtureState)}
            className="rounded border border-border bg-bg-secondary px-2 py-1 text-text-primary"
          >
            {states.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      </div>
      <div
        className={`flex min-h-0 flex-1 flex-col ${width === 'narrow' ? 'mx-auto w-full max-w-[680px]' : ''}`}
      >
        <ChatTranscript
          paneKind="transcript"
          personaId="developer"
          hasRepos={false}
          hasGovernanceDocs={false}
          isDbExpertPersona={false}
          onSuggestionClick={noop}
          turns={turns}
          activeThreadId="native-fixture"
          busy={busy}
          isBaPersona={false}
          personaName="Developer"
          personaColour="var(--color-accent)"
          onReuseMessage={noop}
          changesRepos={[]}
          error={null}
          errorProviders={[]}
          messagesContainerRef={containerRef}
          messagesEndRef={endRef}
          showJumpToLatest={false}
          onJumpToLatest={noop}
        />
        <ChatInput
          onSend={noop}
          onStop={noop}
          disabled={false}
          busy={busy}
          followUpCapabilities={{ guide: !isAcpAgentProvider(provider), queue: true }}
          onFollowUp={async (intent, _message, _attachments, requestId) => ({
            requestId,
            intent,
            status: intent === 'queue' ? 'queued' : 'delivered',
            queueDepth: intent === 'queue' ? 1 : 0,
          })}
          sideQuestionAvailable={!isAcpAgentProvider(provider)}
          onSideQuestion={async () => true}
          personaColour="var(--color-accent)"
          modelProvider={provider}
          model={isAcpAgentProvider(provider) ? 'auto' : 'gpt-6.1-sol'}
          onModelChange={noop}
          reasoningLevel="xhigh"
          reasoningOptions={['medium', 'high', 'xhigh']}
          onReasoningChange={noop}
          codexMode={accessMode}
          accessOptions={chatAccessOptionsForProvider(provider).filter(
            (option) => option.level !== null,
          )}
          onCodexModeChange={setAccessMode}
          setupSummary="Coder · This device"
          leadingControls={
            <>
              <FixtureChip icon={<Code2 size={13} />} label="Coder" />
              <FixtureChip icon={<Laptop size={13} />} label="Run on This device" />
            </>
          }
          contextControls={<span className="px-2 text-xs text-text-tertiary">Fixture context</span>}
          draftKey="native-fixture"
        />
      </div>
    </div>
  );
}

/** Inert stand-ins for the persona and run-target pickers, which need live data. */
function FixtureChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-text-secondary">
      {icon}
      {label}
      <ChevronDown size={11} aria-hidden="true" />
    </span>
  );
}
