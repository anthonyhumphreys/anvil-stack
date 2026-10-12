import { useMemo, useRef, useState } from 'react';
import type { AgentProvider, CodexEvent } from '../../../../shared/types';
import type { ChatEntry } from '../../../contexts/ChatContext';
import { ChatTranscript } from '../ChatTranscript';
import { composeChatTurns } from '../chat-turns';

const providers: AgentProvider[] = ['codex', 'openai', 'azure', 'llmgateway', 'cursor', 'devin'];
const states = [
  'working',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'history',
  'starting',
] as const;
type FixtureState = (typeof states)[number];
const noop = () => undefined;

/** Development-only fixtures rendered with the real Electron shell and preload. */
export default function ProcessingPreview() {
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [state, setState] = useState<FixtureState>('working');
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const startedAt = useRef(new Date(Date.now() - 12_000).toISOString());
  const busy = state === 'working' || state === 'starting' || state === 'waiting';
  const turns = useMemo(() => {
    const event = (value: CodexEvent): ChatEntry => ({
      kind: 'event',
      event: { ...value, sessionId: 'native-fixture', agentLabel: provider },
    });
    const entries: ChatEntry[] = [
      {
        kind: 'user',
        content: 'Check the retry policy and run its tests.',
        timestamp: startedAt.current,
      },
    ];
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
    if (state === 'completed') {
      entries.push({
        kind: 'assistant',
        content:
          'The retry policy accepts attempts 0–2 and rejects values outside that range. Both tests passed.',
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
  }, [provider, state, busy]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3 text-xs text-text-secondary">
        <span className="mr-auto">Processing fixtures · isolated desktop preview</span>
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
    </div>
  );
}
