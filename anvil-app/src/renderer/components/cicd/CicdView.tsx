import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitFork,
  Layers3,
  Loader2,
  MessageSquareText,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Workflow,
  XCircle,
} from 'lucide-react';
import type {
  CicdCreatePipelineInput,
  CicdFlowEdge,
  CicdFlowNode,
  CicdPipelineAnalysis,
  CicdPipelineFile,
  CicdProvider,
  CicdValidationFinding,
  RepoInfo,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

const TEMPLATES = [
  {
    id: 'node-ci',
    name: 'Node CI',
    provider: 'github-actions' as CicdProvider,
    subtitle: 'Install, lint, test, build',
    stages: ['checkout', 'setup node', 'pnpm install', 'lint', 'test', 'build'],
  },
  {
    id: 'dotnet-azure',
    name: '.NET Azure Pipeline',
    provider: 'azure-pipelines' as CicdProvider,
    subtitle: 'Restore, test, publish artifact',
    stages: ['restore', 'build', 'test', 'publish'],
  },
  {
    id: 'gated-release',
    name: 'Gated Release',
    provider: 'github-actions' as CicdProvider,
    subtitle: 'Build, promote, environment approval',
    stages: ['build', 'security scan', 'staging', 'approval', 'production'],
  },
] as const;

type ViewMode = 'atlas' | 'files' | 'templates';

interface PipelineLane {
  workflow: CicdFlowNode;
  phases: CicdFlowNode[];
}

interface DrilldownNode {
  node: CicdFlowNode;
  depth: number;
}

export function CicdView() {
  const navigate = useNavigate();
  const { activeWorkspace, repos } = useWorkspace();
  const [selectedRepoId, setSelectedRepoId] = useState(repos[0]?.id ?? '');
  const [analysis, setAnalysis] = useState<CicdPipelineAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>('atlas');
  const [chatInput, setChatInput] = useState('');
  const [assistantNote, setAssistantNote] = useState(
    'Ask for gates, validation, templates, or a job name and I will focus the atlas.',
  );
  const [createError, setCreateError] = useState<string | null>(null);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? repos[0],
    [repos, selectedRepoId],
  );

  useEffect(() => {
    if (!selectedRepoId && repos[0]?.id) setSelectedRepoId(repos[0].id);
  }, [repos, selectedRepoId]);

  useEffect(() => {
    if (!selectedRepo?.id) return;
    void loadAnalysis(selectedRepo);
  }, [selectedRepo?.id]);

  const selectedNode = useMemo(
    () => analysis?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [analysis, selectedNodeId],
  );

  async function loadAnalysis(repo: RepoInfo) {
    setLoading(true);
    setError(null);
    try {
      const result = await window.anvil.cicd.analyze(repo.id);
      setAnalysis(result);
      setSelectedNodeId(preferredInitialNode(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAnalysis(null);
    } finally {
      setLoading(false);
    }
  }

  async function createPipeline(template: (typeof TEMPLATES)[number]) {
    if (!selectedRepo) return;
    setCreateError(null);
    const input: CicdCreatePipelineInput = {
      provider: template.provider,
      template: template.id,
      name: template.name,
    };
    try {
      const created = await window.anvil.cicd.createPipeline(selectedRepo.id, input);
      setAssistantNote(`Created ${created.filePath}. The atlas has been refreshed.`);
      setMode('atlas');
      await loadAnalysis(selectedRepo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCreateError(message);
      setAssistantNote(message);
    }
  }

  function openPipelineFile(filePath: string) {
    if (!selectedRepo) return;
    navigate(
      buildEditorUrl({
        workspaceId: activeWorkspace?.id,
        repoId: selectedRepo.id,
        repoName: selectedRepo.name,
        relativePath: filePath,
        source: 'cicd',
        title: filePath,
      }),
    );
  }

  function handleChatSubmit(event: React.FormEvent) {
    event.preventDefault();
    const command = chatInput.trim().toLowerCase();
    if (!command || !analysis) return;

    if (command.includes('gate') || command.includes('approval') || command.includes('prod')) {
      const gate = analysis.nodes.find((node) => node.type === 'gate');
      if (gate) {
        setMode('atlas');
        setSelectedNodeId(gate.id);
        setAssistantNote(`Focused ${gate.label}. Environment protection is now in the inspector.`);
      } else {
        setAssistantNote('No gates found. Production is currently trusting vibes, which is brave.');
      }
    } else if (command.includes('template') || command.includes('new pipeline')) {
      setMode('templates');
      setAssistantNote('Opened templates. Pick a starter file and then tune the generated YAML.');
    } else if (command.includes('error') || command.includes('warning') || command.includes('validate')) {
      const finding = analysis.findings.find((item) => item.severity === 'error') ?? analysis.findings[0];
      setMode('atlas');
      if (finding?.nodeId) setSelectedNodeId(finding.nodeId);
      setAssistantNote(
        finding
          ? `${finding.severity.toUpperCase()}: ${finding.message}`
          : 'No validation findings. Suspiciously tidy.',
      );
    } else {
      const match = analysis.nodes.find((node) => node.label.toLowerCase().includes(command));
      if (match) {
        setMode('atlas');
        setSelectedNodeId(match.id);
        setAssistantNote(`Focused ${match.label} in ${match.filePath}.`);
      } else {
        setAssistantNote('No matching node. Try a workflow, stage, job, "gate", "template", or "validate".');
      }
    }
    setChatInput('');
  }

  if (repos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-bg-primary p-8 text-text-secondary">
        Connect a repository before designing pipelines. The canvas needs something to judge.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <header className="shrink-0 border-b border-border bg-bg-secondary/70 px-7 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Workflow size={22} />
            </span>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">CI/CD Atlas</h2>
              <p className="text-sm text-text-secondary">
                Map, inspect, validate, and open Actions or Azure Pipelines from one workspace view
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedRepo?.id ?? ''}
              onChange={(event) => setSelectedRepoId(event.target.value)}
              className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => selectedRepo && loadAnalysis(selectedRepo)}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-medium text-text-primary hover:border-accent/50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-0 overflow-hidden">
        <section className="flex min-h-0 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-border-subtle px-7 py-4">
            <PipelineStats analysis={analysis} loading={loading} />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2">
                {(['atlas', 'files', 'templates'] as ViewMode[]).map((item) => (
                  <button
                    key={item}
                    onClick={() => setMode(item)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium capitalize ${
                      mode === item
                        ? 'border-accent/40 bg-accent/15 text-text-primary'
                        : 'border-border-subtle text-text-secondary hover:bg-bg-secondary'
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {analysis && (
                <PipelineHealthStrip analysis={analysis} onSelectNode={setSelectedNodeId} />
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-7">
            {error && (
              <div className="rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-error">
                {error}
              </div>
            )}
            {!error && loading && (
              <div className="flex h-full items-center justify-center text-text-secondary">
                <Loader2 className="mr-2 animate-spin" size={18} />
                Reading workflow files
              </div>
            )}
            {!error && !loading && analysis && mode === 'atlas' && (
              <PipelineAtlas
                analysis={analysis}
                selectedNodeId={selectedNodeId}
                onOpenFile={openPipelineFile}
                onSelectNode={setSelectedNodeId}
              />
            )}
            {!error && !loading && analysis && mode === 'files' && (
              <PipelineFiles analysis={analysis} onOpenFile={openPipelineFile} />
            )}
            {!error && !loading && mode === 'templates' && (
              <TemplateGallery
                error={createError}
                onCreate={createPipeline}
                onPreview={(name) =>
                  setAssistantNote(`Previewing ${name}. Create the starter file when the shape is right.`)
                }
              />
            )}
            {!error && !loading && analysis && analysis.files.length === 0 && mode !== 'templates' && (
              <EmptyPipelineState onCreate={() => setMode('templates')} />
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-l border-border bg-bg-secondary/80">
          <NodeInspector
            node={selectedNode}
            findings={analysis?.findings ?? []}
            onOpenFile={openPipelineFile}
          />
          <form onSubmit={handleChatSubmit} className="border-t border-border p-4">
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-primary p-3 text-sm text-text-secondary">
              <Bot size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{assistantNote}</span>
            </div>
            <div className="flex gap-2">
              <input
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                placeholder="Ask: show gates, validate, create Node CI..."
                className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary"
              />
              <button className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg-primary">
                <MessageSquareText size={16} />
              </button>
            </div>
          </form>
        </aside>
      </main>
    </div>
  );
}

function PipelineStats({
  analysis,
  loading,
}: {
  analysis: CicdPipelineAnalysis | null;
  loading: boolean;
}) {
  const stats = [
    { label: 'Workflows', value: analysis?.summary.workflowCount ?? 0, icon: <Workflow size={16} /> },
    { label: 'Stages', value: analysis?.summary.stageCount ?? 0, icon: <GitFork size={16} /> },
    { label: 'Jobs', value: analysis?.summary.jobCount ?? 0, icon: <Boxes size={16} /> },
    { label: 'Gates', value: analysis?.summary.gateCount ?? 0, icon: <ShieldCheck size={16} /> },
    { label: 'Findings', value: analysis?.findings.length ?? 0, icon: <AlertTriangle size={16} /> },
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-3">
          <div className="flex items-center justify-between text-text-tertiary">
            {stat.icon}
            {loading && stat.label === 'Workflows' ? <Loader2 size={14} className="animate-spin" /> : null}
          </div>
          <div className="mt-2 text-2xl font-semibold">{stat.value}</div>
          <div className="text-xs uppercase tracking-wide text-text-tertiary">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}

function PipelineHealthStrip({
  analysis,
  onSelectNode,
}: {
  analysis: CicdPipelineAnalysis;
  onSelectNode: (nodeId: string) => void;
}) {
  const errorCount = analysis.findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = analysis.findings.filter((finding) => finding.severity === 'warning').length;
  const firstFindingWithNode = analysis.findings.find((finding) => finding.nodeId);

  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-secondary px-3 py-1.5">
        <CircleDot size={13} className={analysis.findings.length ? 'text-warning' : 'text-success'} />
        {analysis.findings.length ? `${analysis.findings.length} findings` : 'clean validation'}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-secondary px-3 py-1.5">
        <XCircle size={13} className={errorCount ? 'text-error' : 'text-text-tertiary'} />
        {errorCount} errors
      </span>
      <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-bg-secondary px-3 py-1.5">
        <AlertTriangle size={13} className={warningCount ? 'text-warning' : 'text-text-tertiary'} />
        {warningCount} warnings
      </span>
      {firstFindingWithNode?.nodeId && (
        <button
          onClick={() => onSelectNode(firstFindingWithNode.nodeId!)}
          className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1.5 text-accent hover:bg-accent/15"
        >
          Focus first finding
        </button>
      )}
    </div>
  );
}

function PipelineAtlas({
  analysis,
  selectedNodeId,
  onOpenFile,
  onSelectNode,
}: {
  analysis: CicdPipelineAnalysis;
  selectedNodeId: string | null;
  onOpenFile: (filePath: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  const lanes = useMemo(() => buildPipelineLanes(analysis), [analysis]);
  const selectedNode = analysis.nodes.find((node) => node.id === selectedNodeId) ?? lanes[0]?.workflow ?? null;
  const drilldown = useMemo(
    () => (selectedNode ? buildDrilldown(selectedNode.id, analysis.nodes, analysis.edges) : []),
    [analysis.edges, analysis.nodes, selectedNode],
  );

  if (analysis.nodes.length === 0) return <EmptyPipelineState />;

  return (
    <div className="min-w-[1040px] space-y-6">
      <section className="rounded-lg border border-border-subtle bg-bg-secondary p-5">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Layers3 size={16} className="text-accent" />
              Pipeline map
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              High-level workflow lanes first; select a phase to drill into its jobs, gates, and steps.
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-xs text-text-tertiary">
            {analysis.files.length} files scanned
          </div>
        </div>

        <div className="space-y-5">
          {lanes.map((lane) => (
            <WorkflowLane
              key={lane.workflow.id}
              lane={lane}
              selectedNodeId={selectedNodeId}
              findings={analysis.findings}
              onOpenFile={onOpenFile}
              onSelectNode={onSelectNode}
            />
          ))}
        </div>
      </section>

      <section className="grid grid-cols-[minmax(0,1fr)_320px] gap-4">
        <PhaseDrilldown
          selectedNode={selectedNode}
          drilldown={drilldown}
          edges={analysis.edges}
          findings={analysis.findings}
          onSelectNode={onSelectNode}
        />
        <PipelineRunbook analysis={analysis} onSelectNode={onSelectNode} />
      </section>
    </div>
  );
}

function WorkflowLane({
  lane,
  selectedNodeId,
  findings,
  onOpenFile,
  onSelectNode,
}: {
  lane: PipelineLane;
  selectedNodeId: string | null;
  findings: CicdValidationFinding[];
  onOpenFile: (filePath: string) => void;
  onSelectNode: (nodeId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-primary">
      <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3">
        <button
          onClick={() => onSelectNode(lane.workflow.id)}
          className="flex min-w-0 items-center gap-3 text-left"
        >
          <NodeBadge node={lane.workflow} findings={findings} selected={selectedNodeId === lane.workflow.id} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{lane.workflow.label}</div>
            <div className="truncate text-xs text-text-tertiary">
              {providerLabel(lane.workflow.provider)} / {lane.workflow.subtitle ?? lane.workflow.filePath}
            </div>
          </div>
        </button>
        <button
          onClick={() => onOpenFile(lane.workflow.filePath)}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-text-primary"
        >
          <ExternalLink size={14} />
          Open YAML
        </button>
      </div>

      <div className="overflow-x-auto px-4 py-4">
        <div className="flex min-w-max items-stretch gap-3">
          {lane.phases.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-subtle px-4 py-5 text-sm text-text-secondary">
              No stages or jobs were discovered.
            </div>
          ) : (
            lane.phases.map((phase, index) => (
              <div key={phase.id} className="flex items-center gap-3">
                <PhaseCard
                  node={phase}
                  selected={selectedNodeId === phase.id}
                  findings={findings}
                  onSelect={() => onSelectNode(phase.id)}
                />
                {index < lane.phases.length - 1 && <FlowConnector />}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PhaseCard({
  node,
  selected,
  findings,
  onSelect,
}: {
  node: CicdFlowNode;
  selected: boolean;
  findings: CicdValidationFinding[];
  onSelect: () => void;
}) {
  const findingCount = findings.filter((finding) => finding.nodeId === node.id).length;

  return (
    <button
      onClick={onSelect}
      className={`min-h-[118px] w-[210px] rounded-lg border p-4 text-left transition ${
        selected
          ? 'border-accent bg-accent/12 shadow-[0_0_0_1px_var(--color-accent-glow)]'
          : 'border-border-subtle bg-bg-secondary hover:border-accent/50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <NodeIcon node={node} />
        <span className="rounded-full border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] uppercase tracking-wide text-text-tertiary">
          {node.type}
        </span>
      </div>
      <div className="mt-3 line-clamp-2 text-sm font-semibold">{node.label}</div>
      <div className="mt-1 truncate text-xs text-text-tertiary">{node.subtitle ?? node.filePath}</div>
      <div className="mt-3 flex items-center justify-between text-xs text-text-tertiary">
        <span>{statusLabel(node.status)}</span>
        {findingCount > 0 && <span className="text-warning">{findingCount} finding</span>}
      </div>
    </button>
  );
}

function FlowConnector() {
  return (
    <div className="flex w-12 items-center text-border">
      <div className="h-px flex-1 bg-border-subtle" />
      <ChevronRight size={18} />
    </div>
  );
}

function PhaseDrilldown({
  selectedNode,
  drilldown,
  edges,
  findings,
  onSelectNode,
}: {
  selectedNode: CicdFlowNode | null;
  drilldown: DrilldownNode[];
  edges: CicdFlowEdge[];
  findings: CicdValidationFinding[];
  onSelectNode: (nodeId: string) => void;
}) {
  if (!selectedNode) {
    return (
      <div className="rounded-lg border border-border-subtle bg-bg-secondary p-5 text-sm text-text-secondary">
        Select a workflow, stage, or job to inspect the execution flow.
      </div>
    );
  }

  const relatedFindings = findings.filter(
    (finding) =>
      finding.nodeId === selectedNode.id ||
      drilldown.some((item) => item.node.id === finding.nodeId),
  );

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <PanelRightOpen size={16} className="text-accent" />
            Focus flow
          </div>
          <h3 className="mt-2 text-xl font-semibold">{selectedNode.label}</h3>
          <p className="mt-1 text-sm text-text-secondary">
            {selectedNode.subtitle ?? `${providerLabel(selectedNode.provider)} ${selectedNode.type}`}
          </p>
        </div>
        <NodeBadge node={selectedNode} findings={findings} selected />
      </div>

      <div className="mt-5 grid gap-3">
        {drilldown.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-subtle bg-bg-primary p-5 text-sm text-text-secondary">
            This phase has no discovered child steps. That may be valid, or the pipeline is hiding work in a template.
          </div>
        ) : (
          drilldown.map((item, index) => {
            const incoming = edges.find((edge) => edge.to === item.node.id);
            return (
              <button
                key={item.node.id}
                onClick={() => onSelectNode(item.node.id)}
                className="grid grid-cols-[44px_minmax(0,1fr)_120px] items-center gap-3 rounded-lg border border-border-subtle bg-bg-primary p-3 text-left hover:border-accent/50"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-bg-secondary text-text-tertiary">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <NodeIcon node={item.node} />
                    <span className="truncate text-sm font-semibold">{item.node.label}</span>
                  </span>
                  <span className="mt-1 block truncate text-xs text-text-tertiary">
                    {incoming?.label ? `${incoming.label} / ` : ''}
                    {item.node.subtitle ?? item.node.filePath}
                  </span>
                </span>
                <span className="text-right text-xs uppercase tracking-wide text-text-tertiary">
                  {item.node.type}
                </span>
              </button>
            );
          })
        )}
      </div>

      {relatedFindings.length > 0 && (
        <div className="mt-5 rounded-lg border border-warning/30 bg-warning/10 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-warning">
            <AlertTriangle size={16} />
            Validation attention
          </div>
          <div className="space-y-2">
            {relatedFindings.slice(0, 3).map((finding) => (
              <div key={finding.id} className="text-sm text-text-secondary">
                {finding.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PipelineRunbook({
  analysis,
  onSelectNode,
}: {
  analysis: CicdPipelineAnalysis;
  onSelectNode: (nodeId: string) => void;
}) {
  const gates = analysis.nodes.filter((node) => node.type === 'gate');
  const templates = analysis.nodes.filter((node) => node.type === 'template');
  const warnings = analysis.findings.filter((finding) => finding.severity !== 'info');

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={16} className="text-accent" />
          Release gates
        </div>
        {gates.length === 0 ? (
          <p className="text-sm text-text-secondary">No environment gates detected.</p>
        ) : (
          <div className="space-y-2">
            {gates.map((gate) => (
              <button
                key={gate.id}
                onClick={() => onSelectNode(gate.id)}
                className="flex w-full items-center justify-between rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-left text-sm hover:border-accent/50"
              >
                <span className="truncate">{gate.label}</span>
                <ChevronRight size={14} className="text-text-tertiary" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <GitBranch size={16} className="text-accent" />
          Reuse and templates
        </div>
        <p className="text-sm text-text-secondary">
          {templates.length
            ? `${templates.length} reusable or templated nodes discovered.`
            : 'No local templates or reusable workflow calls were discovered.'}
        </p>
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle size={16} className={warnings.length ? 'text-warning' : 'text-success'} />
          Ship risk
        </div>
        {warnings.length === 0 ? (
          <p className="text-sm text-text-secondary">No errors or warnings detected.</p>
        ) : (
          <div className="space-y-2">
            {warnings.slice(0, 4).map((finding) => (
              <button
                key={finding.id}
                onClick={() => finding.nodeId && onSelectNode(finding.nodeId)}
                className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-left text-sm text-text-secondary hover:border-accent/50"
              >
                <span className="font-medium text-text-primary">{finding.severity}: </span>
                {finding.message}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PipelineFiles({
  analysis,
  onOpenFile,
}: {
  analysis: CicdPipelineAnalysis;
  onOpenFile: (filePath: string) => void;
}) {
  return (
    <div className="grid gap-4">
      {analysis.files.map((file) => (
        <PipelineFileCard key={file.path} file={file} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function PipelineFileCard({
  file,
  onOpenFile,
}: {
  file: CicdPipelineFile;
  onOpenFile: (filePath: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-secondary">
      <div className="flex items-center justify-between gap-4 border-b border-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <FileCode2 size={18} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{file.path}</div>
            <div className="text-xs text-text-tertiary">
              {providerLabel(file.provider)} / {file.role}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {file.valid ? (
            <CheckCircle2 size={18} className="text-success" />
          ) : (
            <XCircle size={18} className="text-error" />
          )}
          <button
            onClick={() => onOpenFile(file.path)}
            className="inline-flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-text-primary"
          >
            <ExternalLink size={14} />
            Open
          </button>
        </div>
      </div>
      <pre className="max-h-72 overflow-auto p-4 text-xs leading-relaxed text-text-secondary">
        {file.content}
      </pre>
    </div>
  );
}

function TemplateGallery({
  error,
  onCreate,
  onPreview,
}: {
  error: string | null;
  onCreate: (template: (typeof TEMPLATES)[number]) => void;
  onPreview: (name: string) => void;
}) {
  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg border border-error/40 bg-error/10 p-4 text-sm text-error">
          {error}
        </div>
      )}
      <div className="rounded-lg border border-border-subtle bg-bg-secondary p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <GitFork size={16} className="text-accent" />
          Component palette
        </div>
        <div className="flex flex-wrap gap-2">
          {['build job', 'test job', 'security scan', 'environment gate', 'deploy job'].map((item) => (
            <span
              key={item}
              draggable
              className="cursor-grab rounded-full border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary active:cursor-grabbing"
              title="Drag into a template preview before creating the starter file."
            >
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {TEMPLATES.map((template) => (
          <div
            key={template.id}
            className="rounded-lg border border-border-subtle bg-bg-secondary p-5 text-left hover:border-accent/50"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => onPreview(template.name)}
          >
            <button onClick={() => onPreview(template.name)} className="block w-full text-left">
              <div className="flex items-center justify-between">
                <span className="rounded-lg bg-accent/15 p-2 text-accent">
                  <Plus size={18} />
                </span>
                <span className="text-xs text-text-tertiary">{providerLabel(template.provider)}</span>
              </div>
              <div className="mt-4 text-lg font-semibold">{template.name}</div>
              <div className="mt-1 text-sm text-text-secondary">{template.subtitle}</div>
            </button>
            <div className="mt-4 flex flex-wrap gap-2">
              {template.stages.map((stage) => (
                <span
                  key={stage}
                  className="rounded-full bg-bg-tertiary px-2 py-1 text-xs text-text-secondary"
                >
                  {stage}
                </span>
              ))}
            </div>
            <button
              onClick={() => onCreate(template)}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg-primary"
            >
              <FileCode2 size={16} />
              Create file
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  findings,
  onOpenFile,
}: {
  node: CicdFlowNode | null;
  findings: CicdValidationFinding[];
  onOpenFile: (filePath: string) => void;
}) {
  const nodeFindings = node ? findings.filter((finding) => finding.nodeId === node.id) : findings;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-5 flex items-center gap-3">
        <span className="rounded-lg bg-accent/15 p-2 text-accent">
          <Sparkles size={18} />
        </span>
        <div>
          <div className="text-sm font-semibold">Inspector</div>
          <div className="text-xs text-text-tertiary">Selection-aware validation and file jump</div>
        </div>
      </div>

      {node ? (
        <div className="rounded-lg border border-border-subtle bg-bg-primary p-4">
          <div className="flex items-start gap-3">
            <NodeIcon node={node} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{node.label}</div>
              <button
                onClick={() => onOpenFile(node.filePath)}
                className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-accent hover:underline"
              >
                <span className="truncate">{node.filePath}</span>
                <ExternalLink size={12} className="shrink-0" />
              </button>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <InfoTerm label="Type" value={node.type} />
            <InfoTerm label="Provider" value={providerLabel(node.provider)} />
            <InfoTerm label="Status" value={node.status} />
            <InfoTerm label="Depth" value={String(node.depth)} />
          </dl>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-bg-primary p-4 text-sm text-text-secondary">
          Select a node to inspect its provider, file, gates, and warnings.
        </div>
      )}

      <div className="mt-5">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          Validation
        </div>
        <div className="space-y-3">
          {nodeFindings.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-bg-primary p-4 text-sm text-text-secondary">
              No findings for this selection.
            </div>
          ) : (
            nodeFindings.map((finding) => (
              <div key={finding.id} className="rounded-lg border border-border-subtle bg-bg-primary p-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <FindingIcon finding={finding} />
                  {finding.severity}
                </div>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">{finding.message}</p>
                <button
                  onClick={() => onOpenFile(finding.filePath)}
                  className="mt-2 inline-flex max-w-full items-center gap-1 text-xs text-accent hover:underline"
                >
                  <span className="truncate">{finding.filePath}</span>
                  <ExternalLink size={12} className="shrink-0" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyPipelineState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border bg-bg-secondary p-8 text-center">
      <div>
        <Rocket size={34} className="mx-auto text-accent" />
        <h3 className="mt-4 text-xl font-semibold">No pipeline files found</h3>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">
          Start from a template, then wire jobs, gates, and deployment stages without spelunking YAML by hand.
        </p>
        {onCreate && (
          <button
            onClick={onCreate}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg-primary"
          >
            <Plus size={16} />
            Create pipeline
          </button>
        )}
      </div>
    </div>
  );
}

function InfoTerm({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-tertiary">{label}</dt>
      <dd className="mt-1 truncate text-text-secondary">{value}</dd>
    </div>
  );
}

function NodeBadge({
  node,
  findings,
  selected,
}: {
  node: CicdFlowNode;
  findings: CicdValidationFinding[];
  selected?: boolean;
}) {
  const hasFinding = findings.some((finding) => finding.nodeId === node.id);
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
        selected
          ? 'border-accent bg-accent/15'
          : hasFinding
            ? 'border-warning/40 bg-warning/10'
            : 'border-border-subtle bg-bg-secondary'
      }`}
    >
      <NodeIcon node={node} />
    </span>
  );
}

function NodeIcon({ node }: { node: CicdFlowNode }) {
  const className =
    node.status === 'error' ? 'text-error' : node.status === 'warning' ? 'text-warning' : 'text-accent';
  if (node.type === 'workflow') return <Workflow size={18} className={className} />;
  if (node.type === 'gate') return <ShieldCheck size={18} className={className} />;
  if (node.type === 'stage') return <GitFork size={18} className={className} />;
  if (node.type === 'job') return <Play size={18} className={className} />;
  if (node.type === 'template') return <FileCode2 size={18} className={className} />;
  return <CircleDot size={18} className={className} />;
}

function FindingIcon({ finding }: { finding: CicdValidationFinding }) {
  if (finding.severity === 'error') return <XCircle size={16} className="text-error" />;
  if (finding.severity === 'warning') return <AlertTriangle size={16} className="text-warning" />;
  return <CircleDot size={16} className="text-accent" />;
}

function buildPipelineLanes(analysis: CicdPipelineAnalysis): PipelineLane[] {
  const childrenByParent = buildChildrenByParent(analysis.edges);
  const nodesById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const workflows = analysis.nodes.filter((node) => node.type === 'workflow');

  return workflows.map((workflow) => {
    const directChildren = (childrenByParent.get(workflow.id) ?? [])
      .map((id) => nodesById.get(id))
      .filter((node): node is CicdFlowNode => !!node);
    const depthOneNodes = analysis.nodes.filter(
      (node) => node.filePath === workflow.filePath && node.depth === 1 && node.type !== 'step',
    );
    const hasExplicitStages = directChildren.some(
      (node) => node.type === 'stage' || node.type === 'template',
    );
    const phases =
      hasExplicitStages || workflow.provider === 'azure-pipelines'
        ? directChildren
        : depthOneNodes;

    return {
      workflow,
      phases: phases.filter((node) => node.type !== 'step'),
    };
  });
}

function buildDrilldown(
  selectedNodeId: string,
  nodes: CicdFlowNode[],
  edges: CicdFlowEdge[],
): DrilldownNode[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = buildChildrenByParent(edges);
  const output: DrilldownNode[] = [];
  const queue = (childrenByParent.get(selectedNodeId) ?? []).map((id) => ({ id, depth: 0 }));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id) || next.depth > 2) continue;
    seen.add(next.id);
    const node = nodesById.get(next.id);
    if (!node) continue;
    output.push({ node, depth: next.depth });
    for (const childId of childrenByParent.get(next.id) ?? []) {
      queue.push({ id: childId, depth: next.depth + 1 });
    }
  }

  return output;
}

function buildChildrenByParent(edges: CicdFlowEdge[]): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    childrenByParent.set(edge.from, [...(childrenByParent.get(edge.from) ?? []), edge.to]);
  }
  return childrenByParent;
}

function preferredInitialNode(analysis: CicdPipelineAnalysis): string | null {
  const findingNodeId = analysis.findings.find((finding) => finding.nodeId)?.nodeId;
  if (findingNodeId) return findingNodeId;
  return (
    analysis.nodes.find((node) => node.type === 'stage')?.id ??
    analysis.nodes.find((node) => node.type === 'job')?.id ??
    analysis.nodes[0]?.id ??
    null
  );
}

function statusLabel(status: CicdFlowNode['status']): string {
  if (status === 'error') return 'needs fix';
  if (status === 'warning') return 'review';
  return 'configured';
}

function providerLabel(provider: CicdProvider): string {
  return provider === 'github-actions' ? 'GitHub Actions' : 'Azure Pipelines';
}
