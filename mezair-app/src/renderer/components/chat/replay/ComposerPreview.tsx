import { useEffect, useState } from 'react';
import type { CodexMode, ReasoningEffort } from '../../../../shared/types';
import type { ChatModelOption } from '../../../utils/chat-model-options';
import type { ExecutionStrategy } from '../../../utils/execution-strategy';
import { ChatInput } from '../ChatInput';

const MODELS: ChatModelOption[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    provider: 'codex',
    description: 'Synthetic preview model. No provider request is made.',
    supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    serviceTiers: [],
  },
  {
    id: 'preview-long-model',
    label: 'A model with a deliberately long display name',
    provider: 'codex',
    description: 'Synthetic long label for narrow-window verification.',
    supportedReasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [],
  },
];
const SAMPLE =
  'Take a look at the current changes and help me ship the next improvement. Keep the implementation focused and check it before applying.';
const selectClass =
  'h-9 rounded-lg border border-border-subtle bg-bg-secondary px-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** A local interaction fixture. It never starts an agent or changes repository files. */
export function ComposerPreview() {
  const [theme, setTheme] = useState('dark');
  const [width, setWidth] = useState('wide');
  const [state, setState] = useState('idle');
  const [model, setModel] = useState('gpt-6.1-sol');
  const [reasoning, setReasoning] = useState<ReasoningEffort>('high');
  const [access, setAccess] = useState<CodexMode>('on-request');
  const [mode, setMode] = useState<'default' | 'plan'>('default');
  const [strategy, setStrategy] = useState<ExecutionStrategy>('auto');
  const [fast, setFast] = useState(false);
  const [remote, setRemote] = useState(false);
  const [extraRepo, setExtraRepo] = useState(false);
  const [lastMessage, setLastMessage] = useState('');
  const [prefill, setPrefill] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <main className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Chat composer</h1>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Synthetic preview. No files change and no provider requests run.
          </p>
        </div>
        <select
          aria-label="Theme"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          className={selectClass}
        >
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="agent-after-hours">Agent After Hours</option>
        </select>
        <select
          aria-label="Composer width"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          className={selectClass}
        >
          <option value="wide">Full width</option>
          <option value="medium">560 px</option>
          <option value="narrow">390 px</option>
        </select>
        <select
          aria-label="Composer state"
          value={state}
          onChange={(e) => setState(e.target.value)}
          className={selectClass}
        >
          <option value="idle">Ready</option>
          <option value="working">Agent working</option>
          <option value="disabled">Unavailable</option>
        </select>
        <button
          type="button"
          onClick={() => setPrefill({ id: crypto.randomUUID(), text: SAMPLE })}
          className={`${selectClass} hover:bg-bg-tertiary`}
        >
          Sample draft
        </button>
      </header>

      <div
        className={`mx-auto flex min-h-0 w-full flex-1 flex-col justify-end ${width === 'narrow' ? 'max-w-[390px]' : width === 'medium' ? 'max-w-[560px]' : 'max-w-[1080px]'}`}
      >
        <div className="min-h-0 overflow-y-auto px-6 py-10">
          {lastMessage ? (
            <>
              <p className="ml-auto max-w-[75%] rounded-2xl bg-bg-tertiary px-4 py-3 text-base leading-7">
                {lastMessage}
              </p>
              <p role="status" className="mt-6 text-sm leading-6 text-text-secondary">
                Message received locally. This preview keeps your model, access and run controls
                interactive.
              </p>
            </>
          ) : (
            <p className="max-w-[65ch] text-base leading-7 text-text-secondary">
              Tell me what you want to build, change or investigate.
            </p>
          )}
        </div>
        <ChatInput
          onSend={(message) => {
            setLastMessage(message);
            setState('working');
            return true;
          }}
          onStop={() => setState('idle')}
          busy={state === 'working'}
          disabled={state === 'disabled'}
          prefill={prefill}
          personaColour="var(--color-accent)"
          model={model}
          modelProvider="codex"
          modelOptions={MODELS}
          onModelChange={(nextModel, _provider, nextReasoning) => {
            setModel(nextModel);
            if (nextReasoning) setReasoning(nextReasoning);
          }}
          reasoningLevel={reasoning}
          reasoningOptions={['medium', 'high', 'xhigh']}
          onReasoningChange={setReasoning}
          codexMode={access}
          onCodexModeChange={setAccess}
          collaborationMode={mode}
          onCollaborationModeChange={setMode}
          executionStrategy={strategy}
          onExecutionStrategyChange={setStrategy}
          fastMode={fast}
          fastModeAvailable
          onFastModeChange={setFast}
          sideQuestionAvailable
          onSideQuestion={async (message) => {
            setLastMessage(message);
            return true;
          }}
          followUpCapabilities={{ guide: true, queue: true }}
          onFollowUp={async (intent, message, _attachments, requestId) => {
            setLastMessage(message);
            return {
              requestId,
              intent,
              status: intent === 'guide' ? 'delivered' : 'queued',
              queueDepth: intent === 'queue' ? 1 : 0,
            };
          }}
          setupSummary={`Code · ${remote ? 'Build machine' : 'Local'}`}
          leadingControls={
            <button type="button" onClick={() => setRemote(!remote)} className={selectClass}>
              {remote ? 'Build machine' : 'Local'}
            </button>
          }
          contextControls={
            <button type="button" onClick={() => setExtraRepo(!extraRepo)} className={selectClass}>
              {extraRepo ? 'mezair-app + design-system' : 'mezair-app'}
            </button>
          }
        />
        <p className="px-5 pb-5 text-center text-xs text-text-tertiary">
          Interactive component preview
        </p>
      </div>
    </main>
  );
}
