import { useState } from 'react';
import { ArrowRight, Bot, GitFork, Plus, Trash2, UserCheck } from 'lucide-react';
import type {
  AgentProvider,
  CodexCliStatus,
  CursorCliStatus,
  Persona,
  WorkflowAgentProfile,
  WorkflowNode,
  WorkflowOrchestration,
  WorkflowRun,
} from '../../../shared/types';
import { DEFAULT_CODEX_MODEL, getCodexModelReasoningOptions } from '../../../shared/codex-models';
import { orchestrationConfig, TEAM_STRATEGIES } from '../../../shared/workflow-orchestration';
import { buildProviderModelOptions } from '../../utils/chat-model-options';

const fieldClass = 'workflow-input';

export function OrchestrationPanel({
  value,
  onChange,
  providers,
  personas,
  codexStatus,
  cursorStatus,
}: {
  value?: WorkflowOrchestration;
  onChange: (value: WorkflowOrchestration) => void;
  providers: AgentProvider[];
  personas: Persona[];
  codexStatus: CodexCliStatus | null;
  cursorStatus: CursorCliStatus | null;
}) {
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const config = orchestrationConfig(value);
  const update = (patch: Partial<WorkflowOrchestration>) => onChange({ ...config, ...patch });
  const updateProfile = (id: string, patch: Partial<WorkflowAgentProfile>) =>
    update({
      profiles: config.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <h3 className="text-base font-semibold text-text-primary">Team & limits</h3>
      <p className="mt-2 text-sm text-text-secondary">
        Each specialist can use its own provider, model, and reasoning level.
      </p>
      <div className="mb-3 mt-6 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text-primary">Specialist pool</h4>
        <button
          className="inline-flex items-center gap-1 text-xs text-accent"
          onClick={() => {
            const id = crypto.randomUUID();
            const provider = providers[0] ?? 'codex';
            const model = buildProviderModelOptions(provider, null, codexStatus, cursorStatus)[0];
            update({
              profiles: [
                ...config.profiles,
                {
                  id,
                  name: `Specialist ${config.profiles.length + 1}`,
                  personaId: 'coder',
                  provider,
                  model: model?.id ?? DEFAULT_CODEX_MODEL,
                  reasoningEffort: model?.defaultReasoningEffort ?? 'medium',
                  capabilities: [],
                },
              ],
            });
            setExpandedProfile(id);
          }}
        >
          <Plus size={14} /> Add specialist
        </button>
      </div>
      {!config.profiles.length && (
        <p className="text-sm text-text-tertiary">
          Add a specialist to enable teams and autonomous delegation. Profiles can use different
          providers and models.
        </p>
      )}
      <div className="divide-y divide-border">
        {config.profiles.map((profile) => {
          const modelOptions = buildProviderModelOptions(
            profile.provider,
            profile.model,
            codexStatus,
            cursorStatus,
          );
          const selectedModel = modelOptions.find((model) => model.id === profile.model);
          return (
            <div key={profile.id} className="py-1">
              <button
                type="button"
                aria-expanded={expandedProfile === profile.id}
                aria-controls={`specialist-${profile.id}`}
                onClick={() =>
                  setExpandedProfile(expandedProfile === profile.id ? null : profile.id)
                }
                className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left transition hover:bg-bg-tertiary focus-visible:outline focus-visible:outline-accent"
              >
                <Bot size={17} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {profile.name}
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-tertiary">
                    {profile.provider} · {profile.model}
                    {profile.provider !== 'cursor' ? ` · ${profile.reasoningEffort}` : ''}
                  </span>
                </span>
                <span className="text-xs text-accent">
                  {expandedProfile === profile.id ? 'Done' : 'Edit'}
                </span>
              </button>
              {expandedProfile === profile.id && (
                <div id={`specialist-${profile.id}`} className="space-y-3 px-2 pb-5 pt-2">
                  <div className="flex items-center gap-2">
                    <Bot size={16} className="shrink-0 text-accent" />
                    <input
                      aria-label="Specialist name"
                      value={profile.name}
                      onChange={(event) => updateProfile(profile.id, { name: event.target.value })}
                      className={fieldClass}
                    />
                    <button
                      aria-label={`Remove ${profile.name}`}
                      className="p-2 text-text-tertiary hover:text-error"
                      onClick={() =>
                        update({
                          profiles: config.profiles.filter((item) => item.id !== profile.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <label className="block text-xs text-text-secondary">
                    Persona
                    <select
                      className={`${fieldClass} mt-1`}
                      value={profile.personaId}
                      onChange={(event) =>
                        updateProfile(profile.id, { personaId: event.target.value })
                      }
                    >
                      {personas.map((persona) => (
                        <option key={persona.id} value={persona.id}>
                          {persona.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-text-secondary">
                    Provider
                    <select
                      className={`${fieldClass} mt-1`}
                      value={profile.provider}
                      onChange={(event) => {
                        const provider = event.target.value as AgentProvider;
                        const model = buildProviderModelOptions(
                          provider,
                          null,
                          codexStatus,
                          cursorStatus,
                        )[0];
                        updateProfile(profile.id, {
                          provider,
                          model: model?.id ?? DEFAULT_CODEX_MODEL,
                          reasoningEffort: model?.defaultReasoningEffort ?? 'medium',
                        });
                      }}
                    >
                      {[...new Set([...providers, profile.provider])].map((provider) => (
                        <option key={provider} value={provider}>
                          {provider}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs text-text-secondary">
                    Model
                    <select
                      className={`${fieldClass} mt-1`}
                      value={profile.model}
                      onChange={(event) => {
                        const model = modelOptions.find(
                          (option) => option.id === event.target.value,
                        );
                        updateProfile(profile.id, {
                          model: event.target.value,
                          reasoningEffort:
                            (model?.supportedReasoningEfforts.includes(profile.reasoningEffort) ??
                            false)
                              ? profile.reasoningEffort
                              : (model?.defaultReasoningEffort ?? profile.reasoningEffort),
                        });
                      }}
                    >
                      {modelOptions.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label} · {model.id}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-text-tertiary">
                      {profile.provider === 'cursor'
                        ? cursorStatus?.models.length
                          ? `${cursorStatus.models.length} models detected from Cursor CLI.`
                          : "Cursor's model catalog is unavailable. Auto uses Cursor's default."
                        : codexStatus?.models?.length
                          ? `${codexStatus.models.filter((model) => !model.hidden).length} models detected from Codex CLI.`
                          : 'Using the built-in model catalog.'}
                    </p>
                  </label>
                  {profile.provider !== 'cursor' ? (
                    <label className="block text-xs text-text-secondary">
                      Reasoning
                      <select
                        className={`${fieldClass} mt-1`}
                        value={profile.reasoningEffort}
                        onChange={(event) =>
                          updateProfile(profile.id, {
                            reasoningEffort: event.target
                              .value as WorkflowAgentProfile['reasoningEffort'],
                          })
                        }
                      >
                        {(
                          selectedModel?.supportedReasoningEfforts ??
                          getCodexModelReasoningOptions(profile.model).supportedReasoningEfforts
                        ).map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="text-xs text-text-tertiary">
                      Cursor reasoning is selected through its model ID.
                    </p>
                  )}
                  <label className="block text-xs text-text-secondary">
                    Capabilities, separated by commas
                    <input
                      className={`${fieldClass} mt-1`}
                      placeholder="typescript, security, testing"
                      value={profile.capabilities.join(', ')}
                      onChange={(event) =>
                        updateProfile(profile.id, {
                          capabilities: event.target.value
                            .split(',')
                            .map((value) => value.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <details className="mt-6 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium text-text-secondary">
          Run limits
          <span className="mt-1 block text-xs font-normal text-text-tertiary">
            {config.maxConcurrency} at a time · {config.timeoutMinutes} minutes · {config.maxNodes}{' '}
            nodes maximum
          </span>
        </summary>
        <div className="grid grid-cols-2 gap-3 border-y border-border py-4">
          {(
            [
              ['maxConcurrency', 'Concurrent agents', 1, 16],
              ['maxNodes', 'Total nodes', 1, 256],
              ['maxDepth', 'Delegation depth', 0, 6],
              ['maxAttempts', 'Attempts per agent', 1, 10],
              ['timeoutMinutes', 'Run budget, minutes', 1, 1440],
              ['handoffChars', 'Handoff characters', 1000, 100000],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key} className="text-xs text-text-secondary">
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={config[key]}
                onChange={(event) => update({ [key]: Number(event.target.value) })}
                className={`${fieldClass} mt-1`}
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-text-tertiary">
          Agents share this run's workspace. Use concurrency above one only for work with separate
          edit scopes. Limits cover Anvil-managed agents. Provider-native delegation is disabled by
          instruction, not sandbox enforcement. The wall-clock budget includes pauses.
        </p>
      </details>
    </div>
  );
}

export function TeamSettings({
  node,
  profiles,
  onChange,
}: {
  node: WorkflowNode;
  profiles: WorkflowAgentProfile[];
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  return (
    <div className="space-y-3 border-t border-border pt-4">
      <label className="block text-xs font-semibold text-text-secondary">
        Step type
        <select
          className={`${fieldClass} mt-2`}
          value={node.kind ?? 'agent'}
          onChange={(event) => onChange({ kind: event.target.value as 'agent' | 'human' })}
        >
          <option value="agent">Agent</option>
          <option value="human">Human decision</option>
        </select>
      </label>
      {node.kind === 'human' ? (
        <p className="text-xs text-text-secondary">
          Wait for an explicit acceptance or rejection. The decision and note stay in this run's
          history.
        </p>
      ) : (
        <>
          <label className="block text-xs font-semibold text-text-secondary">
            Anvil team strategy
            <select
              className={`${fieldClass} mt-2`}
              value={node.teamStrategy ?? 'manual'}
              onChange={(event) =>
                onChange({ teamStrategy: event.target.value as WorkflowNode['teamStrategy'] })
              }
            >
              {TEAM_STRATEGIES.map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  {strategy.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-text-secondary">
            {
              TEAM_STRATEGIES.find((strategy) => strategy.id === (node.teamStrategy ?? 'manual'))
                ?.description
            }
          </p>
          {node.teamStrategy && node.teamStrategy !== 'manual' && (
            <div className="space-y-2">
              <p className="text-xs text-text-tertiary">
                {node.teamStrategy === 'autonomous'
                  ? 'Allowed specialists. No selection allows the entire pool.'
                  : 'Specialists assigned to this team.'}
              </p>
              {profiles.length ? (
                profiles.map((profile) => (
                  <label
                    key={profile.id}
                    className="flex items-start gap-2 text-xs text-text-secondary"
                  >
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={node.teamProfileIds?.includes(profile.id) ?? false}
                      onChange={(event) =>
                        onChange({
                          teamProfileIds: event.target.checked
                            ? [...(node.teamProfileIds ?? []), profile.id]
                            : node.teamProfileIds?.filter((id) => id !== profile.id),
                        })
                      }
                    />
                    <span>
                      {profile.name}
                      <span className="block text-text-tertiary">
                        {profile.provider} · {profile.model}
                        {profile.provider !== 'cursor' ? ` · ${profile.reasoningEffort}` : ''}
                      </span>
                    </span>
                  </label>
                ))
              ) : (
                <p className="text-xs text-warning">Add specialists in Orchestration first.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RunInspector({
  busy = false,
  run,
  nodeId,
  onCommand,
  onOpenThread,
}: {
  busy?: boolean;
  run: WorkflowRun;
  nodeId: string | null;
  onCommand: (command: () => Promise<WorkflowRun>) => void;
  onOpenThread: (threadId: string, personaId: string) => void;
}) {
  const [note, setNote] = useState('');
  const node = run.nodes.find((item) => item.id === nodeId);
  const state = run.nodeRuns.find((item) => item.nodeId === nodeId);
  return (
    <div className="border-b border-border p-4">
      {node && state ? (
        <>
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            {node.kind === 'human' ? <UserCheck size={16} /> : <Bot size={16} />}
            {node.name}
          </div>
          <p className="mt-2 text-xs text-text-secondary">
            {state.status} · depth {node.depth ?? 0} · {state.attempts?.length ?? 0} attempts
          </p>
          {state.status === 'waiting' && (
            <div className="mt-3 space-y-2">
              <p className="text-xs leading-relaxed text-text-secondary">{node.prompt}</p>
              <textarea
                aria-label="Decision note"
                className={fieldClass}
                rows={3}
                placeholder="Record your decision and any conditions"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  className="rounded-lg bg-accent px-3 py-2 text-xs text-bg-primary disabled:opacity-40"
                  onClick={() =>
                    onCommand(() => window.anvil.workflow.decideNode(run.id, node.id, true, note))
                  }
                >
                  Accept
                </button>
                <button
                  disabled={busy}
                  className="rounded-lg border border-border px-3 py-2 text-xs text-text-primary disabled:opacity-40"
                  onClick={() =>
                    onCommand(() => window.anvil.workflow.decideNode(run.id, node.id, false, note))
                  }
                >
                  Reject
                </button>
              </div>
              <p className="text-xs text-text-tertiary">
                Resume the run after resolving its decisions.
              </p>
            </div>
          )}
          {['failed', 'interrupted'].includes(state.status) && node.kind !== 'human' && (
            <button
              className="mt-3 text-xs text-accent"
              onClick={() => onCommand(() => window.anvil.workflow.retryNode(run.id, node.id))}
            >
              Queue retry after inspection
            </button>
          )}
          {state.error && <p className="mt-2 text-xs text-error">{state.error}</p>}
          {state.output && (
            <details className="mt-3 text-xs text-text-secondary">
              <summary className="cursor-pointer">
                {node.kind === 'human' ? 'Decision record' : 'Agent handoff'}
              </summary>
              {node.kind !== 'human' && (
                <p className="mt-2 text-text-tertiary">
                  Agent analysis is not observed verification evidence.
                </p>
              )}
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap font-sans">
                {state.output}
              </pre>
            </details>
          )}
          {!!state.attempts?.length && (
            <details className="mt-3 text-xs text-text-secondary">
              <summary className="cursor-pointer">Attempt history</summary>
              <div className="mt-2 space-y-3">
                {state.attempts.map((attempt, index) => (
                  <div key={attempt.id}>
                    <div>
                      Attempt {index + 1} · {attempt.status}
                    </div>
                    <div className="break-words text-text-tertiary">
                      {attempt.provider} · {attempt.model} · {attempt.reasoningEffort}
                    </div>
                    {attempt.error && <p className="text-error">{attempt.error}</p>}
                    {attempt.threadId && (
                      <button
                        className="mt-1 text-accent"
                        onClick={() => onOpenThread(attempt.threadId!, node.personaId)}
                      >
                        Open attempt thread <ArrowRight size={12} className="inline" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      ) : (
        <p className="text-xs text-text-secondary">
          Select a graph node to inspect its attempts, handoff, or human decision.
        </p>
      )}
      <details className="mt-4 text-xs text-text-secondary">
        <summary className="cursor-pointer">
          Execution timeline · {run.events?.length ?? 0} events
        </summary>
        <ol className="mt-3 max-h-72 space-y-3 overflow-auto">
          {[...(run.events ?? [])].reverse().map((event) => (
            <li key={event.id}>
              <time className="text-text-tertiary">{new Date(event.at).toLocaleTimeString()}</time>
              <p className="mt-0.5">{event.message}</p>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

export function RuntimeSummary({ run }: { run: WorkflowRun }) {
  const config = orchestrationConfig(run.orchestration);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-border bg-bg-secondary px-5 py-2 text-xs text-text-secondary">
      <span className="inline-flex items-center gap-1.5">
        <GitFork size={13} />
        {run.nodes.filter((node) => node.parentNodeId).length} delegated
      </span>
      <span>
        {run.nodeRuns.filter((state) => state.status === 'running').length}/{config.maxConcurrency}{' '}
        running
      </span>
      <span>
        {run.nodes.length}/{config.maxNodes} nodes
      </span>
      <span>
        {
          new Set(
            run.nodes
              .filter((node) => node.kind !== 'human')
              .map((node) => node.provider ?? 'codex'),
          ).size
        }{' '}
        providers
      </span>
      <span>
        {run.nodeRuns.filter((state) => state.status === 'waiting').length} decisions pending
      </span>
      {run.error && <span className="text-error">{run.error}</span>}
    </div>
  );
}
