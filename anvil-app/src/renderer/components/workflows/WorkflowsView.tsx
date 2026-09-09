import { WorkflowLaunchpad } from './WorkflowLaunchpad';
import {
  OrchestrationPanel,
  TeamSettings,
  RunInspector,
  RuntimeSummary,
} from './OrchestrationPanel';
import {
  createOrchestrationPreset,
  isContextualWorkflowPreset,
  type WorkflowPreset,
  layoutWorkflowGraph,
  orchestrationConfig,
} from '../../../shared/workflow-orchestration';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  addEdge,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Activity,
  ArrowRight,
  Bot,
  Check,
  CircleStop,
  MessageSquare,
  Play,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
  Zap,
  Settings2,
  Pause,
  UserCheck,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type {
  AgentProvider,
  AppSettings,
  CodexCliStatus,
  CursorCliStatus,
  Persona,
  WorkflowNode,
  WorkflowNodeRun,
  WorkflowRun,
  WorkflowTemplate,
} from '../../../shared/types';
import { DEFAULT_CODEX_MODEL, getCodexModelReasoningOptions } from '../../../shared/codex-models';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildProviderModelOptions } from '../../utils/chat-model-options';

type WorkflowCanvasData = {
  node: WorkflowNode;
  state?: WorkflowNodeRun;
} & Record<string, unknown>;

const EMPTY_TEMPLATE: WorkflowTemplate = {
  id: '',
  name: 'Untitled workflow',
  description: '',
  nodes: [],
  edges: [],
  createdAt: '',
  updatedAt: '',
};

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  codex: 'Codex',
  cursor: 'Cursor',
  openai: 'OpenAI',
  azure: 'Azure',
};

function WorkflowStepNode({ data, selected }: NodeProps<Node<WorkflowCanvasData>>) {
  const state = data.state;
  const status = state?.status ?? 'draft';
  const statusClass =
    status === 'completed'
      ? 'border-success/55 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-success)_20%,transparent)]'
      : status === 'running'
        ? 'border-accent/70 shadow-[0_0_24px_var(--color-accent-glow)]'
        : status === 'failed'
          ? 'border-error/60'
          : selected
            ? 'border-accent/60 shadow-[0_0_0_1px_var(--color-accent-glow)]'
            : 'border-border';

  return (
    <div
      className={`workflow-step-node w-[260px] rounded-xl border bg-bg-elevated ${statusClass}`}
      aria-label={`${data.node.name}, ${status}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-bg-primary !bg-info"
      />
      <div className="flex items-start gap-3 p-4">
        <div
          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            status === 'running' ? 'bg-accent/18 text-accent' : 'bg-bg-tertiary text-text-secondary'
          }`}
        >
          {status === 'completed' ? (
            <Check size={17} />
          ) : status === 'running' ? (
            <Activity className="workflow-running-icon" size={17} />
          ) : data.node.kind === 'human' ? (
            <UserCheck size={17} />
          ) : (
            <Bot size={17} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-primary">{data.node.name}</div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
            <span>{data.node.kind === 'human' ? 'Your decision' : data.node.personaId}</span>
            {data.node.kind !== 'human' && (
              <>
                <span aria-hidden="true">·</span>
                <span>{PROVIDER_LABELS[data.node.provider ?? 'codex']}</span>
                {(data.node.provider ?? 'codex') !== 'cursor' && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{data.node.reasoningEffort}</span>
                  </>
                )}
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {data.node.kind === 'human' ? 'human decision' : (data.node.teamStrategy ?? 'manual')}
            </span>
            {state && <span>{state.status}</span>}
          </div>
        </div>
        <StatusDot status={status} />
      </div>
      <div className="border-t border-border-subtle px-4 py-2.5 text-xs text-text-tertiary">
        <span className="block truncate">
          {data.node.kind === 'human' ? 'Accept or reject with a recorded note' : data.node.model}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-bg-primary !bg-accent"
      />
    </div>
  );
}

const NODE_TYPES = { workflowStep: WorkflowStepNode };

export function WorkflowsView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [contextualPreset, setContextualPreset] = useState<WorkflowPreset>('delivery');
  const { activeWorkspace } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [libraryExpanded, setLibraryExpanded] = useState(
    () => window.matchMedia('(min-width: 1280px)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1280px)');
    const changed = () => setLibraryExpanded(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [draft, setDraft] = useState<WorkflowTemplate>(EMPTY_TEMPLATE);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [agentSettings, setAgentSettings] = useState<AppSettings | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [cursorStatus, setCursorStatus] = useState<CursorCliStatus | null>(null);
  const [kickoff, setKickoff] = useState('');
  const [workItemRef, setWorkItemRef] = useState<WorkflowRun['workItemRef']>();
  const [supervisorQuestion, setSupervisorQuestion] = useState('');
  const [supervisorReplies, setSupervisorReplies] = useState<
    Array<{ question: string; answer: string }>
  >([]);
  const [showOrchestration, setShowOrchestration] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRun =
    runs.find((run) => run.id === selectedRunId && run.workspaceId === activeWorkspace?.id) ?? null;
  const selectedNode = draft.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const runTemplate = selectedRun
    ? {
        id: selectedRun.templateId,
        name: selectedRun.templateName,
        description: '',
        nodes: selectedRun.nodes,
        edges: selectedRun.edges,
        createdAt: selectedRun.createdAt,
        updatedAt: selectedRun.createdAt,
      }
    : null;
  const inspectedRunNodeId =
    selectedNodeId ??
    selectedRun?.nodeRuns.find((state) => state.status === 'waiting')?.nodeId ??
    null;
  const canvasTemplate = runTemplate ?? draft;
  const isLaunching = !selectedRun && draft.nodes.length === 0;

  const refresh = useCallback(async () => {
    const [nextTemplates, nextPersonas, nextRuns, nextSettings] = await Promise.all([
      window.anvil.workflow.listTemplates(),
      window.anvil.chat.getPersonas(),
      activeWorkspace ? window.anvil.workflow.listRuns(activeWorkspace.id) : Promise.resolve([]),
      window.anvil.settings.get(),
    ]);
    setTemplates(nextTemplates);
    setPersonas(nextPersonas);
    setRuns(nextRuns);
    setAgentSettings(nextSettings);
  }, [activeWorkspace]);

  useEffect(() => {
    void refresh()
      .catch((caught) => setError(messageFrom(caught)))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    void Promise.all([
      window.anvil.settings.getCodexStatus().catch(() => null),
      window.anvil.settings.getCursorStatus().catch(() => null),
    ]).then(([nextCodexStatus, nextCursorStatus]) => {
      setCodexStatus(nextCodexStatus);
      setCursorStatus(nextCursorStatus);
    });
  }, []);

  useEffect(() => {
    const runId = searchParams.get('run');
    const draftRequest = searchParams.get('draft');
    const kickoffMessage = searchParams.get('kickoff');
    const preset = searchParams.get('preset');
    if (!runId && !draftRequest && !kickoffMessage && !preset) return;
    const itemId = searchParams.get('workItemId');
    const itemProvider = searchParams.get('workItemProvider');
    const itemConnection = searchParams.get('workItemConnection');
    if (preset || draftRequest || kickoffMessage) {
      setWorkItemRef(
        itemId &&
          itemConnection &&
          (itemProvider === 'ado' || itemProvider === 'linear' || itemProvider === 'jira')
          ? { id: itemId, connectionId: itemConnection, provider: itemProvider }
          : undefined,
      );
    }
    if (isContextualWorkflowPreset(preset)) {
      setContextualPreset(preset);
      setSelectedRunId(null);
      setDraft(EMPTY_TEMPLATE);
      setSelectedNodeId(null);
    }

    if (runId) {
      setSelectedNodeId(null);
      setSelectedRunId(runId);
      void window.anvil.workflow
        .getRun(runId)
        .then((run) => {
          if (!run) throw new Error('Workflow run not found.');
          setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
        })
        .catch((caught) => setError(messageFrom(caught)));
    }
    if (kickoffMessage) setKickoff(kickoffMessage);
    const next = new URLSearchParams(searchParams);
    next.delete('run');
    next.delete('draft');
    next.delete('kickoff');
    next.delete('preset');
    next.delete('workItemId');
    next.delete('workItemProvider');
    next.delete('workItemConnection');
    setSearchParams(next, { replace: true });

    if (draftRequest) {
      setDrafting(true);
      setSelectedRunId(null);
      window.anvil.workflow
        .draftTemplate(draftRequest)
        .then((generated) => {
          setDraft({
            ...generated,
            description: generated.description ?? '',
            id: '',
            createdAt: '',
            updatedAt: '',
          });
          setSelectedNodeId(generated.nodes[0]?.id ?? null);
        })
        .catch((caught) => setError(messageFrom(caught)))
        .finally(() => setDrafting(false));
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (
      !activeWorkspace ||
      !runs.some((run) => ['queued', 'running', 'paused'].includes(run.status))
    )
      return;
    const interval = window.setInterval(() => {
      window.anvil.workflow
        .listRuns(activeWorkspace.id)
        .then(setRuns)
        .catch(() => undefined);
    }, 900);
    return () => window.clearInterval(interval);
  }, [activeWorkspace, runs]);

  const runtimeLayout = useMemo(
    () => (selectedRun ? layoutWorkflowGraph(selectedRun.nodes, selectedRun.edges) : null),
    [selectedRun],
  );

  const flowNodes = useMemo<Node<WorkflowCanvasData>[]>(
    () =>
      canvasTemplate.nodes.map((node) => ({
        id: node.id,
        type: 'workflowStep',
        position: runtimeLayout?.get(node.id) ?? node.position,
        data: {
          node,
          state: selectedRun?.nodeRuns.find((candidate) => candidate.nodeId === node.id),
        },
        selected: node.id === selectedNodeId,
      })),
    [canvasTemplate.nodes, selectedNodeId, selectedRun, runtimeLayout],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      canvasTemplate.edges.map((edge) => {
        const sourceState = selectedRun?.nodeRuns.find(
          (node) => node.nodeId === edge.source,
        )?.status;
        return {
          ...edge,
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: sourceState === 'running',
          style: {
            stroke:
              sourceState === 'completed'
                ? 'var(--color-success)'
                : sourceState === 'running'
                  ? 'var(--color-accent)'
                  : 'var(--color-border)',
            strokeWidth: 2,
          },
        };
      }),
    [canvasTemplate.edges, selectedRun],
  );

  const updateNode = (updates: Partial<WorkflowNode>) => {
    if (!selectedNodeId || selectedRun) return;
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === selectedNodeId ? { ...node, ...updates } : node,
      ),
    }));
  };

  const addStep = () => {
    const id = crypto.randomUUID();
    const count = draft.nodes.length;
    const provider = agentSettings?.llmProvider ?? 'codex';
    const node: WorkflowNode = {
      id,
      name: `Step ${count + 1}`,
      prompt: 'Describe what this step should accomplish and what it should hand off.',
      personaId: 'coder',
      provider,
      model: provider === 'cursor' ? 'auto' : (agentSettings?.openaiModel ?? DEFAULT_CODEX_MODEL),
      reasoningEffort: 'medium',
      executionStrategy: 'focused',
      teamStrategy: 'manual',
      position: { x: 120 + (count % 3) * 330, y: 100 + Math.floor(count / 3) * 210 },
    };
    setSelectedRunId(null);
    setDraft((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(id);
  };

  const connect = (connection: Connection) => {
    if (selectedRun || !connection.source || !connection.target) return;
    const next = addEdge(connection, flowEdges);
    setDraft((current) => ({
      ...current,
      edges: next.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await window.anvil.workflow.saveTemplate(
        {
          name: draft.name,
          description: draft.description,
          nodes: draft.nodes,
          edges: draft.edges,
          orchestration: draft.orchestration,
        },
        draft.id || undefined,
      );
      setDraft(saved);
      setTemplates((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    if (!activeWorkspace || !draft.nodes.length || !kickoff.trim() || starting || saving) return;
    setStarting(true);
    setError(null);
    try {
      const saved = await window.anvil.workflow.saveTemplate(
        {
          name: draft.name,
          description: draft.description,
          nodes: draft.nodes,
          edges: draft.edges,
          orchestration: draft.orchestration,
        },
        draft.id || undefined,
      );
      setDraft(saved);
      setTemplates((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      const run = await window.anvil.workflow.startRun({
        templateId: saved.id,
        workspaceId: activeWorkspace.id,
        repoIds: activeWorkspace.repos.map((repo) => repo.id),
        kickoff,
        workItemRef,
      });
      setRuns((current) => [run, ...current]);
      setSelectedRunId(run.id);
      setKickoff('');
      setSupervisorReplies([]);
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setStarting(false);
    }
  };

  const askSupervisor = async () => {
    if (!selectedRun || !supervisorQuestion.trim()) return;
    const question = supervisorQuestion.trim();
    setAsking(true);
    setSupervisorQuestion('');
    setError(null);
    try {
      const answer = await window.anvil.workflow.askSupervisor(selectedRun.id, question);
      setSupervisorReplies((current) => [...current, { question, answer }]);
    } catch (caught) {
      setError(messageFrom(caught));
      setSupervisorQuestion(question);
    } finally {
      setAsking(false);
    }
  };

  const runCommand = async (command: () => Promise<WorkflowRun>) => {
    if (commandBusy) return;
    setCommandBusy(true);
    setError(null);
    try {
      const run = await command();
      setRuns((current) => current.map((item) => (item.id === run.id ? run : item)));
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setCommandBusy(false);
    }
  };

  const loadPreset = (kind: WorkflowPreset) => {
    const provider = agentSettings?.llmProvider ?? 'codex';
    const profiles = orchestrationConfig(draft.orchestration).profiles;
    const generated = createOrchestrationPreset(
      kind,
      profiles.length
        ? profiles
        : [
            {
              id: 'implementer',
              name: 'Implementation',
              personaId: 'coder',
              capabilities: ['implementation', 'typescript'],
            },
            {
              id: 'reviewer',
              name: 'Code review',
              personaId: personas.some((persona) => persona.id === 'reviewer')
                ? 'reviewer'
                : 'coder',
              capabilities: ['review', 'security'],
            },
            {
              id: 'verifier',
              name: 'Verification',
              personaId: 'coder',
              capabilities: ['testing', 'regression'],
            },
          ].map((profile, index) => {
            const available = agentSettings?.enabledLlmProviders?.length
              ? agentSettings.enabledLlmProviders
              : [provider];
            const selectedProvider = available[index % available.length];
            return {
              ...profile,
              provider: selectedProvider,
              model:
                selectedProvider === 'cursor'
                  ? 'auto'
                  : (agentSettings?.openaiModel ?? DEFAULT_CODEX_MODEL),
              reasoningEffort: 'high' as const,
            };
          }),
    );
    if (kind === 'delivery') {
      const positions = [
        { x: 0, y: 0 },
        { x: 330, y: 0 },
        { x: 330, y: 220 },
        { x: 660, y: 220 },
      ];
      generated.nodes = generated.nodes.map((node, index) => ({
        ...node,
        position: positions[index],
      }));
    }
    setDraft({
      ...generated,
      description: generated.description ?? '',
      id: '',
      createdAt: '',
      updatedAt: '',
    });
    setSelectedRunId(null);
    setSelectedNodeId(null);
    setShowOrchestration(false);
  };

  const openThread = (threadId: string, personaId: string) => {
    navigate(
      `/chat?persona=${encodeURIComponent(personaId)}&thread=${encodeURIComponent(threadId)}`,
    );
  };

  return (
    <div className="flex h-full min-h-0 bg-bg-primary">
      <aside
        className={`flex shrink-0 flex-col border-r border-border bg-bg-secondary ${libraryExpanded ? 'w-56' : 'w-14'}`}
      >
        <div className={`border-b border-border-subtle py-3 ${libraryExpanded ? 'px-4' : 'px-2'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {libraryExpanded && (
              <div>
                <h1 className="text-lg font-semibold text-text-primary">Workflows</h1>
              </div>
            )}
            <button
              aria-label={libraryExpanded ? 'Collapse workflow library' : 'Expand workflow library'}
              aria-expanded={libraryExpanded}
              onClick={() => setLibraryExpanded(!libraryExpanded)}
              className="rounded-lg p-2 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
            >
              {libraryExpanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <button
              onClick={() => {
                setDraft({ ...EMPTY_TEMPLATE });
                setSelectedRunId(null);
                setSelectedNodeId(null);
                setShowOrchestration(false);
                setKickoff('');
              }}
              className="rounded-lg border border-border p-2 text-text-secondary transition hover:border-accent/45 hover:bg-bg-tertiary hover:text-text-primary active:scale-95"
              aria-label="Create workflow template"
              title="New workflow"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        <div className={`min-h-0 flex-1 overflow-y-auto p-3 ${libraryExpanded ? '' : 'hidden'}`}>
          <SectionLabel>Saved workflows</SectionLabel>
          <div className="space-y-1.5">
            {templates.length === 0 ? (
              <EmptyRail
                label="Your flows will appear here"
                detail="Start with an outcome, then save or run."
              />
            ) : (
              templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => {
                    setDraft(template);
                    setSelectedRunId(null);
                    setSelectedNodeId(null);
                  }}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                    !selectedRun && draft.id === template.id
                      ? 'border-accent/40 bg-accent/10'
                      : 'border-transparent hover:border-border hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="truncate text-sm font-medium text-text-primary">
                    {template.name}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-text-tertiary">
                    <span>
                      {template.nodes.length} {template.nodes.length === 1 ? 'step' : 'steps'}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>

          <SectionLabel className="mt-6">Recent runs</SectionLabel>
          <div className="space-y-1.5">
            {runs
              .filter((run) => run.workspaceId === activeWorkspace?.id)
              .map((run) => (
                <button
                  key={run.id}
                  onClick={() => {
                    setSelectedRunId(run.id);
                    setSelectedNodeId(null);
                    setSupervisorReplies([]);
                  }}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                    selectedRunId === run.id
                      ? 'border-accent/40 bg-accent/10'
                      : 'border-transparent hover:border-border hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={run.status} />
                    <span className="truncate text-sm font-medium text-text-primary">
                      {run.templateName}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-text-tertiary">{run.kickoff}</div>
                </button>
              ))}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {!isLaunching && (
          <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0 flex-1 basis-48">
              {selectedRun ? (
                <>
                  <div className="flex items-center gap-2">
                    <StatusDot status={selectedRun.status} />
                    <h2 className="truncate text-base font-semibold text-text-primary">
                      {selectedRun.templateName}
                    </h2>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-text-tertiary">
                    {selectedRun.kickoff}
                  </p>
                </>
              ) : (
                <div>
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    className="w-full border-none bg-transparent text-base font-semibold text-text-primary outline-none placeholder:text-text-muted"
                    aria-label="Workflow name"
                  />
                  <input
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, description: event.target.value }))
                    }
                    className="mt-0.5 block w-full border-none bg-transparent text-xs text-text-tertiary outline-none placeholder:text-text-muted"
                    placeholder="What this workflow is for"
                    aria-label="Workflow description"
                  />
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 whitespace-nowrap">
              {selectedRun ? (
                <>
                  <button
                    onClick={() => openThread(selectedRun.supervisorThreadId, 'coder')}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    <MessageSquare size={15} /> Supervisor
                  </button>
                  {selectedRun.executionPaths
                    ?.filter((entry) => selectedRun.repoIds.includes(entry.id))
                    .map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() =>
                          navigate(
                            `/review?${new URLSearchParams({ repo: entry.id, workflowRun: selectedRun.id, executionPath: entry.path, ...(selectedRun.workItemRef ? { workItemId: selectedRun.workItemRef.id, workItemProvider: selectedRun.workItemRef.provider, workItemConnection: selectedRun.workItemRef.connectionId } : {}) })}`,
                          )
                        }
                        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline focus-visible:outline-accent"
                      >
                        Review candidate
                        {selectedRun.executionPaths!.length > 1
                          ? ` · ${activeWorkspace?.repos.find((repo) => repo.id === entry.id)?.name ?? entry.id}`
                          : ''}
                      </button>
                    ))}
                  {selectedRun.status === 'running' && (
                    <button
                      disabled={commandBusy}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary"
                      onClick={() =>
                        runCommand(() => window.anvil.workflow.pauseRun(selectedRun.id))
                      }
                    >
                      <Pause size={14} /> Pause
                    </button>
                  )}
                  {selectedRun.status === 'paused' && (
                    <button
                      disabled={commandBusy}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary"
                      onClick={() =>
                        runCommand(() => window.anvil.workflow.resumeRun(selectedRun.id))
                      }
                    >
                      <Play size={14} /> Resume
                    </button>
                  )}
                  {['running', 'queued', 'paused'].includes(selectedRun.status) && (
                    <button
                      onClick={() =>
                        runCommand(
                          async () => (await window.anvil.workflow.cancelRun(selectedRun.id))!,
                        )
                      }
                      className="inline-flex items-center gap-2 rounded-lg border border-error/35 px-3 py-2 text-sm text-error transition hover:bg-error/10"
                    >
                      <CircleStop size={15} /> Stop
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    aria-pressed={showOrchestration}
                    onClick={() => {
                      setShowOrchestration(!showOrchestration);
                      setSelectedNodeId(null);
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary"
                  >
                    <Settings2 size={15} /> Team & limits
                  </button>
                  {draft.id && (
                    <button
                      onClick={() => {
                        if (!deleteArmed) {
                          setDeleteArmed(true);
                          return;
                        }
                        window.anvil.workflow
                          .deleteTemplate(draft.id)
                          .then(() => {
                            const remaining = templates.filter((item) => item.id !== draft.id);
                            setTemplates(remaining);
                            setDraft(remaining[0] ?? { ...EMPTY_TEMPLATE });
                            setSelectedNodeId(null);
                            setDeleteArmed(false);
                          })
                          .catch((caught) => setError(messageFrom(caught)));
                      }}
                      onBlur={() => setDeleteArmed(false)}
                      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                        deleteArmed
                          ? 'border-error/45 bg-error/10 text-error'
                          : 'border-border text-text-tertiary hover:border-error/35 hover:text-error'
                      }`}
                    >
                      <Trash2 size={15} /> {deleteArmed ? 'Delete?' : 'Delete'}
                    </button>
                  )}
                  <button
                    onClick={addStep}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary active:scale-[0.98]"
                  >
                    <Plus size={15} /> Add step
                  </button>
                  <button
                    onClick={save}
                    disabled={saving || starting}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition hover:bg-bg-tertiary disabled:opacity-50"
                  >
                    {saving ? (
                      <Activity className="workflow-running-icon" size={15} />
                    ) : (
                      <Save size={15} />
                    )}
                    {draft.id ? 'Save' : 'Save template'}
                  </button>
                </>
              )}
            </div>
          </header>
        )}

        {selectedRun && <RuntimeSummary run={selectedRun} />}
        {!selectedRun && !isLaunching && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-2.5 text-xs text-text-tertiary">
            <span>
              Preview · {draft.nodes.length} steps ·{' '}
              {orchestrationConfig(draft.orchestration).profiles.length} specialists
              <span className="ml-3 text-text-secondary">Select a step to adjust it</span>
            </span>
            {!draft.id && (
              <button
                onClick={() => {
                  setDraft({ ...EMPTY_TEMPLATE });
                  setSelectedNodeId(null);
                  setShowOrchestration(false);
                }}
                className="text-text-secondary underline decoration-border underline-offset-4 hover:text-text-primary"
              >
                Change flow
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between border-b border-error/30 bg-error/10 px-5 py-2.5 text-sm text-error">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          {drafting && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-bg-primary/80">
              <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated px-5 py-4 text-sm text-text-secondary shadow-xl">
                <Activity className="workflow-running-icon text-accent" size={18} />
                Drafting the graph from your chat
              </div>
            </div>
          )}
          {isLaunching ? (
            <WorkflowLaunchpad
              key={contextualPreset}
              initialStarter={contextualPreset}
              objective={kickoff}
              onObjectiveChange={setKickoff}
              onPrepare={loadPreset}
              onCustom={addStep}
              ready={!loading && !!agentSettings}
              loading={loading}
              onRetry={() => {
                setError(null);
                setLoading(true);
                void refresh()
                  .catch((caught) => setError(messageFrom(caught)))
                  .finally(() => setLoading(false));
              }}
              profileCount={orchestrationConfig(draft.orchestration).profiles.length || 3}
              providerSummary={(agentSettings?.enabledLlmProviders?.length
                ? agentSettings.enabledLlmProviders
                : [agentSettings?.llmProvider ?? 'codex']
              )
                .map((provider) => PROVIDER_LABELS[provider])
                .join(' / ')}
              workspaceName={activeWorkspace?.name}
            />
          ) : (
            <ReactFlow
              key={
                selectedRun
                  ? `${selectedRun.id}:${selectedRun.nodes.length}:${libraryExpanded}`
                  : `template:${draft.id}:${libraryExpanded}:${showOrchestration || !!selectedNodeId}`
              }
              minZoom={0.1}
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={{ padding: 0.28 }}
              nodesDraggable={!selectedRun}
              nodesConnectable={!selectedRun}
              elementsSelectable
              onNodeClick={(_event, node) => {
                setSelectedNodeId(node.id);
                setShowOrchestration(false);
              }}
              onNodeDragStop={(_event, node) => {
                if (selectedRun) return;
                setDraft((current) => ({
                  ...current,
                  nodes: current.nodes.map((item) =>
                    item.id === node.id ? { ...item, position: node.position } : item,
                  ),
                }));
              }}
              onConnect={connect}
              onEdgesDelete={(deleted) => {
                if (selectedRun) return;
                const ids = new Set(deleted.map((edge) => edge.id));
                setDraft((current) => ({
                  ...current,
                  edges: current.edges.filter((edge) => !ids.has(edge.id)),
                }));
              }}
              onPaneClick={() => setSelectedNodeId(null)}
              colorMode="dark"
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="var(--color-border-subtle)" />
              <MiniMap
                pannable
                zoomable
                nodeColor="var(--color-bg-elevated)"
                maskColor="color-mix(in srgb, var(--color-bg-primary) 72%, transparent)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>
        {!selectedRun && draft.nodes.length > 0 && (
          <KickoffPanel
            kickoff={kickoff}
            setKickoff={setKickoff}
            starting={starting}
            canStart={!!activeWorkspace && !!kickoff.trim() && draft.nodes.length > 0 && !saving}
            onStart={start}
          />
        )}
      </main>

      {!isLaunching && (selectedNode || selectedRun || showOrchestration) && (
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-bg-secondary">
          {!selectedRun && (
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
              <span className="text-xs text-text-secondary">
                {showOrchestration ? 'Team configuration' : 'Step configuration'}
              </span>
              <button
                aria-label="Close configuration"
                onClick={() => {
                  setShowOrchestration(false);
                  setSelectedNodeId(null);
                }}
                className="rounded p-1 text-text-tertiary hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {selectedRun ? (
            <>
              <div className="max-h-[50%] overflow-y-auto">
                <RunInspector
                  key={`${selectedRun.id}:${inspectedRunNodeId}`}
                  run={selectedRun}
                  nodeId={inspectedRunNodeId}
                  busy={commandBusy}
                  onCommand={runCommand}
                  onOpenThread={openThread}
                />
              </div>
              <SupervisorPanel
                run={selectedRun}
                template={runTemplate}
                replies={supervisorReplies}
                question={supervisorQuestion}
                setQuestion={setSupervisorQuestion}
                asking={asking}
                onAsk={askSupervisor}
                onOpenThread={openThread}
              />
            </>
          ) : showOrchestration ? (
            <OrchestrationPanel
              value={draft.orchestration}
              onChange={(orchestration) =>
                setDraft((current) => ({
                  ...current,
                  orchestration,
                  nodes: current.nodes.map((node) => ({
                    ...node,
                    teamProfileIds: node.teamProfileIds?.filter((id) =>
                      orchestration.profiles.some((profile) => profile.id === id),
                    ),
                  })),
                }))
              }
              providers={
                agentSettings?.enabledLlmProviders?.length
                  ? agentSettings.enabledLlmProviders
                  : [agentSettings?.llmProvider ?? 'codex']
              }
              personas={personas}
            />
          ) : selectedNode ? (
            <Inspector
              node={selectedNode}
              profiles={orchestrationConfig(draft.orchestration).profiles}
              personas={personas}
              enabledProviders={
                agentSettings?.enabledLlmProviders?.length
                  ? agentSettings.enabledLlmProviders
                  : [agentSettings?.llmProvider ?? 'codex']
              }
              codexStatus={codexStatus}
              cursorStatus={cursorStatus}
              onChange={updateNode}
              onDelete={() => {
                setDraft((current) => ({
                  ...current,
                  nodes: current.nodes.filter((node) => node.id !== selectedNode.id),
                  edges: current.edges.filter(
                    (edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id,
                  ),
                }));
                setSelectedNodeId(null);
              }}
            />
          ) : null}
        </aside>
      )}
    </div>
  );
}

function Inspector({
  node,
  profiles,
  personas,
  enabledProviders,
  codexStatus,
  cursorStatus,
  onChange,
  onDelete,
}: {
  node: WorkflowNode;
  profiles: import('../../../shared/types').WorkflowAgentProfile[];
  personas: Persona[];
  enabledProviders: AgentProvider[];
  codexStatus: CodexCliStatus | null;
  cursorStatus: CursorCliStatus | null;
  onChange: (updates: Partial<WorkflowNode>) => void;
  onDelete: () => void;
}) {
  const provider = node.provider ?? 'codex';
  const modelOptions = buildProviderModelOptions(provider, node.model, codexStatus, cursorStatus);
  const selectedModel = modelOptions.find((model) => model.id === node.model);
  const reasoning = selectedModel?.supportedReasoningEfforts ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">
            Step inspector
          </div>
          <h3 className="mt-1 text-lg font-semibold text-text-primary">Configure the handoff</h3>
        </div>
        <button
          onClick={onDelete}
          className="rounded-lg p-2 text-text-tertiary transition hover:bg-error/10 hover:text-error"
          aria-label="Delete step"
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div className="mt-6 space-y-5">
        <Field label="Name">
          <input
            value={node.name}
            onChange={(event) => onChange({ name: event.target.value })}
            className="workflow-input"
          />
        </Field>
        <Field label="Instruction">
          <textarea
            value={node.prompt}
            onChange={(event) => onChange({ prompt: event.target.value })}
            rows={7}
            className="workflow-input resize-y"
          />
        </Field>
        <TeamSettings node={node} profiles={profiles} onChange={onChange} />
        {node.kind !== 'human' && (
          <>
            <Field label="Persona">
              <select
                value={node.personaId}
                onChange={(event) => onChange({ personaId: event.target.value })}
                className="workflow-input"
              >
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Provider">
              <select
                value={provider}
                onChange={(event) => {
                  const nextProvider = event.target.value as AgentProvider;
                  onChange({
                    provider: nextProvider,
                    model: nextProvider === 'cursor' ? 'auto' : DEFAULT_CODEX_MODEL,
                    reasoningEffort: 'medium',
                  });
                }}
                className="workflow-input"
              >
                {enabledProviders.map((providerId) => (
                  <option key={providerId} value={providerId}>
                    {PROVIDER_LABELS[providerId]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-text-tertiary">
                Only providers activated in Settings are available here.
              </p>
            </Field>
            <Field label="Model">
              <input
                list={`workflow-models-${node.id}`}
                value={node.model}
                onChange={(event) => {
                  const model = event.target.value;
                  if (provider === 'cursor') {
                    onChange({ model });
                  } else {
                    const options = modelOptions.find((option) => option.id === model);
                    const supportedReasoningEfforts =
                      options?.supportedReasoningEfforts ??
                      getCodexModelReasoningOptions(model).supportedReasoningEfforts;
                    const defaultReasoningEffort =
                      options?.defaultReasoningEffort ??
                      getCodexModelReasoningOptions(model).defaultReasoningEffort;
                    onChange({
                      model,
                      reasoningEffort: supportedReasoningEfforts.includes(node.reasoningEffort)
                        ? node.reasoningEffort
                        : defaultReasoningEffort,
                    });
                  }
                }}
                className="workflow-input"
              />
              <datalist id={`workflow-models-${node.id}`}>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </datalist>
              {provider === 'cursor' && (
                <p className="mt-1 text-xs text-text-tertiary">
                  {cursorStatus?.models.length
                    ? `${cursorStatus.models.length} models detected from Cursor CLI.`
                    : 'Enter a Cursor model id, or use auto.'}
                </p>
              )}
            </Field>
            {provider === 'cursor' ? (
              <p className="text-xs text-text-tertiary">
                Cursor model ids carry their own reasoning level, such as <code>-high</code> or{' '}
                <code>-xhigh</code>.
              </p>
            ) : (
              <Field label="Reasoning">
                <div className="grid grid-cols-4 gap-1.5">
                  {reasoning.map((effort) => (
                    <ChoiceButton
                      key={effort}
                      active={node.reasoningEffort === effort}
                      onClick={() => onChange({ reasoningEffort: effort })}
                    >
                      {effort}
                    </ChoiceButton>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function KickoffPanel({
  kickoff,
  setKickoff,
  starting,
  canStart,
  onStart,
}: {
  kickoff: string;
  setKickoff: (value: string) => void;
  starting: boolean;
  canStart: boolean;
  onStart: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-border bg-bg-secondary px-5 py-4">
      <div className="mb-2 flex items-center justify-between text-xs text-text-tertiary">
        <span className="font-medium text-text-secondary">Run objective</span>
        <span>Changes save when you run</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <Sparkles size={18} />
        </div>
        <textarea
          value={kickoff}
          onChange={(event) => setKickoff(event.target.value)}
          rows={2}
          placeholder="Describe the outcome for this run…"
          className="min-h-10 min-w-[180px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted"
          aria-label="Workflow kickoff"
        />
        <button
          onClick={onStart}
          disabled={!canStart || starting}
          className="ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-bg-primary transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? <Activity className="workflow-running-icon" size={16} /> : <Play size={16} />}{' '}
          {starting ? 'Starting…' : 'Run workflow'}
        </button>
      </div>
    </div>
  );
}

function SupervisorPanel({
  run,
  template,
  replies,
  question,
  setQuestion,
  asking,
  onAsk,
  onOpenThread,
}: {
  run: WorkflowRun;
  template: WorkflowTemplate | null;
  replies: Array<{ question: string; answer: string }>;
  question: string;
  setQuestion: (value: string) => void;
  asking: boolean;
  onAsk: () => void;
  onOpenThread: (threadId: string, personaId: string) => void;
}) {
  const completed = run.nodeRuns.filter((node) => node.status === 'completed').length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-accent">
          <Zap size={14} /> Supervisor
        </div>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-2xl font-semibold text-text-primary">
            {completed}/{run.nodeRuns.length}
          </span>
          <span className="text-xs uppercase tracking-wide text-text-tertiary">steps complete</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{
              width: `${run.nodeRuns.length ? (completed / run.nodeRuns.length) * 100 : 0}%`,
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-2">
          {run.nodeRuns.map((nodeRun) => {
            const node = template?.nodes.find((item) => item.id === nodeRun.nodeId);
            return (
              <button
                key={nodeRun.nodeId}
                disabled={!nodeRun.threadId}
                onClick={() =>
                  nodeRun.threadId && onOpenThread(nodeRun.threadId, node?.personaId ?? 'coder')
                }
                className="group flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left transition hover:bg-bg-tertiary disabled:cursor-default"
              >
                <StatusDot status={nodeRun.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">
                    {node?.name ?? nodeRun.nodeId}
                  </div>
                  <div className="mt-0.5 text-xs text-text-tertiary">
                    {nodeRun.status}
                    {nodeRun.error ? `: ${nodeRun.error}` : ''}
                  </div>
                </div>
                {nodeRun.threadId && (
                  <ArrowRight
                    className="text-text-muted transition group-hover:translate-x-0.5 group-hover:text-accent"
                    size={15}
                  />
                )}
              </button>
            );
          })}
        </div>
        {replies.length > 0 && (
          <div className="mt-5 space-y-3 border-t border-border-subtle pt-5">
            {replies.map((reply, index) => (
              <div key={`${reply.question}-${index}`}>
                <div className="ml-6 rounded-xl bg-accent/10 px-3 py-2 text-sm text-text-primary">
                  {reply.question}
                </div>
                <div className="mt-2 whitespace-pre-wrap rounded-xl bg-bg-tertiary px-3 py-2.5 text-sm leading-relaxed text-text-secondary">
                  {reply.answer}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border p-3">
        <div className="rounded-xl border border-border bg-bg-elevated p-2 focus-within:border-accent/50">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onAsk();
              }
            }}
            rows={2}
            placeholder="Ask what is happening…"
            className="w-full resize-none bg-transparent px-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-text-muted">Enter to ask</span>
            <button
              onClick={onAsk}
              disabled={asking || !question.trim()}
              className="rounded-lg bg-accent p-2 text-bg-primary transition active:scale-95 disabled:opacity-40"
              aria-label="Ask supervisor"
            >
              {asking ? (
                <Activity className="workflow-running-icon" size={15} />
              ) : (
                <ArrowRight size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colour =
    status === 'completed'
      ? 'bg-success'
      : status === 'running' || status === 'queued'
        ? 'bg-accent'
        : status === 'failed' || status === 'interrupted'
          ? 'bg-error'
          : status === 'waiting' || status === 'paused'
            ? 'bg-warning'
            : status === 'cancelled' || status === 'skipped'
              ? 'bg-text-muted'
              : 'bg-border';
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${colour}`}
      aria-label={status}
    />
  );
}

function SectionLabel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted ${className}`}
    >
      {children}
    </div>
  );
}
function EmptyRail({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-3">
      <div className="text-sm text-text-secondary">{label}</div>
      <div className="mt-1 text-xs text-text-muted">{detail}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold text-text-secondary">{label}</span>
      {children}
    </label>
  );
}
function ChoiceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-2 py-2 text-xs capitalize transition ${active ? 'border-accent/50 bg-accent/12 text-text-primary' : 'border-border text-text-tertiary hover:bg-bg-tertiary'}`}
    >
      {children}
    </button>
  );
}
function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
