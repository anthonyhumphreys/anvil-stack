import { useEffect, useRef, useState } from 'react';
import type { AgentUIPlanIntent, AgentUIQuestionIntent } from '../../../../shared/agent-ui-intents';
import type { CodexMode } from '../../../../shared/types';
import type { ChatEntry } from '../../../contexts/ChatContext';
import { ChatInput } from '../ChatInput';
import { ChatTranscript } from '../ChatTranscript';
import { PendingQuestionPrompt, PlanChip } from '../ChatPromptOverlays';
import { composeChatTurns } from '../chat-turns';

const createdAt = new Date().toISOString();
const INTERACTION_QUESTION: AgentUIQuestionIntent = {
  protocolVersion: 1,
  id: 'fixture-interaction-question',
  kind: 'question',
  revision: 1,
  scope: { threadId: 'fixture-interactions' },
  lifecycle: 'presented',
  presentation: { hidden: false, collapsed: false },
  createdAt,
  updatedAt: createdAt,
  payload: {
    title: 'A couple of choices before I continue',
    questions: [
      {
        id: 'layout',
        kind: 'single_choice',
        required: true,
        allowCancel: true,
        allowOther: true,
        question: 'How should account settings be organised?',
        options: [
          {
            id: 'one',
            value: 'one',
            label: 'One focused page',
            description: 'Keep the common settings together, with advanced options on demand.',
            recommended: true,
          },
          {
            id: 'sections',
            value: 'sections',
            label: 'Separate sections',
            description: 'Give profile, security and notifications their own space.',
          },
        ],
      },
      {
        id: 'preview',
        kind: 'yes_no',
        required: true,
        allowCancel: true,
        question: 'Show a preview before applying the changes?',
      },
      {
        id: 'notes',
        kind: 'free_text',
        required: false,
        allowCancel: true,
        question: 'Anything else I should keep in mind?',
      },
    ],
  },
};

const plan: AgentUIPlanIntent = {
  protocolVersion: 1,
  id: 'fixture-interaction-plan',
  kind: 'plan',
  revision: 1,
  scope: { threadId: 'fixture-interactions' },
  lifecycle: 'presented',
  presentation: { hidden: false, collapsed: false },
  createdAt,
  updatedAt: createdAt,
  payload: {
    planId: 'fixture-plan',
    title: 'Simplify account settings',
    lifecycle: 'active',
    phases: [],
    steps: [
      { id: 'inspect', title: 'Review the existing settings flow', status: 'done' },
      { id: 'design', title: 'Simplify the layout and interactions', status: 'in_progress' },
      { id: 'verify', title: 'Check keyboard access and narrow windows', status: 'todo' },
    ],
  },
};

const states = [
  'compose',
  'working',
  'questions',
  'approval',
  'provider questions',
  'plan approval',
  'tool request',
  'error',
  'stopped',
  'complete',
] as const;
type PreviewState = (typeof states)[number];

/** Synthetic interaction lab using the production transcript, prompts and composer. */
export function ChatInteractionPreview({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<PreviewState>('working');
  const [theme, setTheme] = useState('dark');
  const [compact, setCompact] = useState(false);
  const [model, setModel] = useState('gpt-5.4');
  const [access, setAccess] = useState<CodexMode>('on-request');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = !['compose', 'error', 'stopped', 'complete'].includes(state);
  const entries: ChatEntry[] =
    state === 'compose'
      ? []
      : [
          {
            kind: 'user',
            content: 'Make account settings simpler and easier to use.',
            timestamp: createdAt,
          },
          {
            kind: 'assistant',
            phase: 'progress',
            content: 'I’ll review the current flow and simplify the decisions along the way.',
          },
        ];
  const event = (value: Extract<ChatEntry, { kind: 'event' }>['event']) =>
    entries.push({ kind: 'event', event: { sessionId: 'fixture-interactions', ...value } });
  if (state === 'approval')
    event({
      type: 'approval_request',
      approvalRequestId: 'fixture-approval',
      approvalKind: 'command',
      approvalCommand:
        'pnpm exec playwright test tests/account-settings.spec.ts --project=chromium --reporter=list',
      approvalReason:
        'Check that profile edits, keyboard navigation and save feedback work together.',
      approvalCwd: '/synthetic/mezair-demo',
    });
  if (state === 'provider questions')
    event({
      type: 'input_request',
      inputRequestId: 'fixture-provider-question',
      agentLabel: 'Cursor',
      inputRequest: {
        kind: 'cursor_ask_question',
        title: 'Choose the settings layout',
        questions: [
          {
            id: 'layout',
            prompt: 'How should account settings be organised?',
            options: [
              { id: 'one', label: 'One focused page' },
              { id: 'sections', label: 'Separate sections' },
            ],
          },
        ],
      },
    });
  if (state === 'plan approval')
    event({
      type: 'input_request',
      inputRequestId: 'fixture-plan-approval',
      agentLabel: 'Cursor',
      inputRequest: {
        kind: 'cursor_create_plan',
        title: 'Simplify account settings',
        plan: '1. Review the existing flow.\n2. Keep common settings on one page.\n3. Check keyboard access and save feedback.',
      },
    });
  if (state === 'tool request')
    event({
      type: 'input_request',
      inputRequestId: 'fixture-tool-request',
      inputRequest: {
        kind: 'mcp_elicitation',
        mode: 'url',
        serverName: 'Design library',
        message: 'Connect your library to use the saved account components.',
        url: 'https://example.com/connect/design-library?session=synthetic-local-preview',
      },
    });
  if (state === 'working')
    event({
      type: 'tool_call',
      itemId: 'fixture-read',
      toolName: 'read_file',
      toolStatus: 'running',
      toolInput: { path: 'src/settings/AccountSettings.tsx' },
    });
  if (state === 'complete') {
    entries.push({
      kind: 'assistant',
      content:
        'Account settings now uses one focused page. Advanced options stay out of the way until you need them.\n\nSave feedback appears beside the action, and every control works with the keyboard.',
    });
    event({ type: 'turn_outcome', turnOutcome: 'completed' });
  }
  if (state === 'stopped') event({ type: 'turn_outcome', turnOutcome: 'interrupted' });
  const turns = composeChatTurns([...entries, ...messages], { active: busy });

  return (
    <main
      data-theme={theme}
      className={`mx-auto flex w-full ${compact ? 'max-w-[740px]' : ''} ${embedded ? 'h-full min-h-0' : 'h-screen'} min-w-0 flex-col bg-bg-primary text-text-primary`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-bg-secondary px-5 py-3 text-xs text-text-secondary">
        <span className="mr-auto">Chat interactions · synthetic local preview</span>
        <button
          type="button"
          aria-pressed={compact}
          onClick={() => setCompact((value) => !value)}
          className="rounded-md border border-border px-2 py-1.5"
        >
          Compact pane
        </button>
        <label className="flex items-center gap-2">
          State
          <select
            aria-label="Interaction state"
            value={state}
            onChange={(e) => {
              setState(e.target.value as PreviewState);
              setMessages([]);
            }}
            className="rounded-md border border-border bg-bg-primary px-2 py-1.5"
          >
            {states.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Theme
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            className="rounded-md border border-border bg-bg-primary px-2 py-1.5"
          >
            <option>dark</option>
            <option>light</option>
          </select>
        </label>
        {!embedded && (
          <a href="/" className="rounded px-2 py-1.5 hover:bg-bg-tertiary">
            Surface replay
          </a>
        )}
      </header>
      <ChatTranscript
        key={`transcript:${state}`}
        paneKind="transcript"
        personaId="coder"
        hasRepos={false}
        hasGovernanceDocs={false}
        isDbExpertPersona={false}
        onSuggestionClick={() => undefined}
        turns={turns}
        activeThreadId="fixture-interactions"
        busy={busy}
        isBaPersona={false}
        personaName="Coder"
        personaColour="#48d597"
        changesRepos={[]}
        error={
          state === 'error'
            ? '503 Service Unavailable: the provider connection closed before the request completed.\nRequest: synthetic-local-preview\nNo remote request was made.'
            : null
        }
        errorProviders={[]}
        onErrorRetry={() => setState('compose')}
        onReuseMessage={() => undefined}
        messagesContainerRef={containerRef}
        messagesEndRef={endRef}
        showJumpToLatest={false}
        onJumpToLatest={() => undefined}
      />
      {state === 'questions' ? (
        <PendingQuestionPrompt
          key={`question:${state}`}
          intent={INTERACTION_QUESTION}
          additionalCount={0}
        />
      ) : (
        busy && (
          <PlanChip
            snapshot={{
              updatedAt: createdAt,
              steps: plan.payload.steps.map((step) => ({
                step: step.title,
                status:
                  step.status === 'done'
                    ? 'completed'
                    : step.status === 'in_progress'
                      ? 'in_progress'
                      : 'pending',
              })),
            }}
          />
        )
      )}
      <ChatInput
        key={`composer:${state}`}
        onSend={(content) => {
          setMessages((current) => [...current, { kind: 'user', content }]);
          setState('working');
          return true;
        }}
        onStop={() => setState('stopped')}
        busy={busy}
        disabled={false}
        followUpCapabilities={busy ? { guide: true, queue: true } : undefined}
        onFollowUp={async (intent, content, _attachments, requestId) => {
          await new Promise((resolve) => setTimeout(resolve, 800));
          setMessages((current) => [...current, { kind: 'user', content }]);
          return {
            requestId,
            intent,
            status: intent === 'guide' ? 'delivered' : 'queued',
            queueDepth: intent === 'queue' ? 1 : 0,
          };
        }}
        model={model}
        modelProvider="codex"
        onModelChange={setModel}
        modelOptions={[
          {
            id: 'gpt-5.4',
            label: 'GPT-5.4',
            provider: 'codex',
            description: 'Synthetic preview model',
            supportedReasoningEfforts: ['medium'],
            defaultReasoningEffort: 'medium',
            serviceTiers: [],
          },
        ]}
        codexMode={access}
        onCodexModeChange={setAccess}
        personaColour="#48d597"
        draftKey="mezair:chat-interaction-preview"
        showSyntaxHint={state === 'compose'}
      />
    </main>
  );
}
