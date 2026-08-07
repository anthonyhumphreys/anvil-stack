import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  MessageSquareText,
  RefreshCw,
  Route,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type {
  PullRequestDiffFile,
  PullRequestVisualisation,
  PullRequestVisualisationChangeState,
  PullRequestVisualisationNode,
  PullRequestVisualisationTone,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { PullRequestDiffView } from './PullRequestDiffView';

type ExperienceMode = 'story' | 'map' | 'diff';

interface PullRequestCanvasProps {
  repoId: string;
  pullRequestId: string;
  reviewId?: string;
  initialMode?: ExperienceMode;
  onClose?: () => void;
}

interface CanvasNodeData extends Record<string, unknown> {
  item: PullRequestVisualisationNode;
}

type CanvasNode = Node<CanvasNodeData, 'pullRequest'>;

const nodeTypes = { pullRequest: PullRequestNode };

export function PullRequestCanvas({
  repoId,
  pullRequestId,
  reviewId,
  initialMode = 'map',
  onClose,
}: PullRequestCanvasProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [visualisation, setVisualisation] = useState<PullRequestVisualisation | null>(null);
  const [mode, setMode] = useState<ExperienceMode>(initialMode);
  const [changeState, setChangeState] = useState<PullRequestVisualisationChangeState>('after');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (force = false) => {
      setGenerating(true);
      setError(null);
      try {
        const next = await window.anvil.codereview.visualisePullRequest(repoId, pullRequestId, {
          force,
          reviewId,
        });
        setVisualisation(next);
        setSelectedChapterId((current) => current ?? next.chapters[0]?.id ?? null);
        setSelectedNodeId((current) => current ?? next.nodes[0]?.id ?? null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setGenerating(false);
      }
    },
    [pullRequestId, repoId, reviewId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const request =
      initialMode === 'diff'
        ? window.anvil.codereview
            .getPullRequestVisualisation(repoId, pullRequestId)
            .then((existing) => {
              if (cancelled || existing?.status !== 'ready') return;
              setVisualisation(existing);
              setSelectedChapterId(existing.chapters[0]?.id ?? null);
              setSelectedNodeId(existing.nodes[0]?.id ?? null);
            })
        : generate(false);
    void request
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [generate, initialMode, pullRequestId, repoId]);

  const selectedNode = visualisation?.nodes.find((node) => node.id === selectedNodeId);
  const selectedRisk = visualisation?.risks.find(
    (risk) => risk.nodeId === selectedNodeId || risk.id === selectedNodeId,
  );
  const selectedEvidence = visualisation?.evidence.filter(
    (evidence) => evidence.nodeId === selectedNodeId,
  );

  const { nodes, edges } = useMemo(
    () => buildFlow(visualisation, changeState, selectedChapterId),
    [changeState, selectedChapterId, visualisation],
  );

  const openNode = useCallback(
    (node: PullRequestVisualisationNode) => {
      if (!node.filePath) return;
      navigate(
        buildEditorUrl({
          workspaceId: activeWorkspace?.id,
          repoId,
          relativePath: node.filePath,
          line: node.line,
          source: 'codereview',
          title: node.line ? `${node.filePath}:${node.line}` : node.filePath,
        }),
      );
    },
    [activeWorkspace?.id, navigate, repoId],
  );

  const askInChat = useCallback(
    (file?: PullRequestDiffFile) => {
      const pr = visualisation?.pullRequest;
      const prompt = [
        `Help me inspect PR #${pullRequestId}${pr?.title ? ` — ${pr.title}` : ''}.`,
        visualisation?.summary ? `Change story: ${visualisation.summary}` : null,
        selectedRisk
          ? `Risk to investigate: ${selectedRisk.title} — ${selectedRisk.explanation}`
          : null,
        selectedNode?.filePath
          ? `Selected source: ${selectedNode.filePath}${selectedNode.line ? `:${selectedNode.line}` : ''}`
          : null,
        file ? `Diff file: ${file.filePath}\n\n\`\`\`diff\n${file.diff}\n\`\`\`` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n\n');
      navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
    },
    [
      navigate,
      pullRequestId,
      selectedNode?.filePath,
      selectedNode?.line,
      selectedRisk,
      visualisation,
    ],
  );

  if (mode === 'diff' && !visualisation && !loading) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-primary">
        <header className="flex min-h-14 items-center gap-3 border-b border-border-subtle px-4">
          <GitPullRequest size={16} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-text-primary">
              Pull request #{pullRequestId}
            </h1>
            <p className="mt-0.5 text-xs text-text-tertiary">Traditional diff review</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setMode('map');
              void generate(false);
            }}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/85"
          >
            <Sparkles size={13} /> Visualise PR
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
              aria-label="Close pull request diff"
            >
              <X size={14} />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1">
          <PullRequestDiffView
            repoId={repoId}
            pullRequestId={pullRequestId}
            onAskInChat={askInChat}
          />
        </div>
      </div>
    );
  }

  if (loading || !visualisation) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-bg-primary">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
            {error ? <AlertTriangle size={18} /> : <Sparkles size={18} className="animate-pulse" />}
          </div>
          <p className="mt-4 text-sm font-semibold text-text-primary">
            {error ? 'PR Canvas could not be generated' : 'Building the change story'}
          </p>
          <p className="mt-2 text-xs leading-5 text-text-secondary">
            {error ??
              'Tracing behaviour, evidence, risks, and before/after logic across the pull request.'}
          </p>
          {error && (
            <button
              type="button"
              onClick={() => void generate(true)}
              className="mt-4 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const pr = visualisation.pullRequest;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <header className="flex min-h-14 items-center gap-3 border-b border-border-subtle px-4">
        <GitPullRequest size={16} className="shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2" title={pr.title}>
            <span className="shrink-0 font-mono text-xs font-semibold text-accent">#{pr.id}</span>
            <h1 className="truncate text-sm font-semibold text-text-primary">{pr.title}</h1>
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-text-tertiary">
            {pr.sourceBranch} → {pr.targetBranch} · {visualisation.headSha.slice(0, 8)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1 rounded-lg border border-border p-1">
          {(['story', 'map', 'diff'] as ExperienceMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                mode === item
                  ? 'bg-bg-elevated text-text-primary'
                  : 'text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => askInChat()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
        >
          <MessageSquareText size={13} /> <span className="hidden xl:inline">Ask in chat</span>
        </button>
        <button
          type="button"
          onClick={() =>
            void window.anvil.codereview.exportPullRequestVisualisation(repoId, pullRequestId)
          }
          className="rounded-md p-2 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Export PR change story"
          title="Export PR change story"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          onClick={() => void generate(true)}
          className="rounded-md p-2 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Refresh PR Canvas"
          title="Refresh PR Canvas"
        >
          <RefreshCw size={14} className={generating ? 'animate-spin' : undefined} />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close PR Canvas"
          >
            <X size={14} />
          </button>
        )}
      </header>

      {mode === 'diff' ? (
        <div className="min-h-0 flex-1">
          <PullRequestDiffView
            repoId={repoId}
            pullRequestId={pullRequestId}
            focusFilePath={selectedNode?.filePath}
            onAskInChat={askInChat}
          />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1">
            {mode === 'story' && (
              <aside className="w-64 shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-secondary/55 p-3 xl:w-72">
                <p className="px-2 text-xs font-semibold text-text-secondary">Change story</p>
                <p className="mt-2 px-2 text-sm leading-6 text-text-secondary">
                  {visualisation.intent}
                </p>
                <div className="mt-4 border-t border-border-subtle pt-2">
                  {visualisation.chapters.map((chapter, index) => (
                    <button
                      key={chapter.id}
                      type="button"
                      onClick={() => setSelectedChapterId(chapter.id)}
                      className={`mb-1 w-full rounded-lg px-3 py-3 text-left transition-colors ${
                        selectedChapterId === chapter.id
                          ? 'bg-accent/10 text-text-primary'
                          : 'text-text-secondary hover:bg-bg-tertiary/60'
                      }`}
                    >
                      <span className="flex items-center gap-2 text-xs font-semibold">
                        <span className="font-mono text-text-tertiary">{index + 1}</span>
                        {chapter.title}
                      </span>
                      <span className="mt-2 block text-sm leading-6 text-text-tertiary">
                        {chapter.summary}
                      </span>
                    </button>
                  ))}
                </div>
              </aside>
            )}

            <main className="relative min-w-0 flex-1">
              <div className="absolute left-4 top-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-bg-secondary p-1">
                {(['before', 'after'] as const).map((state) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setChangeState(state)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                      changeState === state
                        ? 'bg-accent text-white'
                        : 'text-text-tertiary hover:text-text-primary'
                    }`}
                  >
                    {state}
                  </button>
                ))}
                <ArrowLeftRight size={13} className="mx-1 text-text-muted" />
              </div>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.22 }}
                minZoom={0.55}
                maxZoom={1.8}
                onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
                className="pr-canvas-flow"
              >
                <Background color="var(--color-border-subtle)" gap={32} size={1} />
                <Controls position="top-right" showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => toneColor(node.data.item.tone)}
                  maskColor="color-mix(in srgb, var(--color-bg-primary) 78%, transparent)"
                />
              </ReactFlow>
            </main>

            <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-secondary/55 2xl:w-[340px]">
              <div className="border-b border-border-subtle p-4">
                <p className="text-xs font-medium text-text-tertiary">Selected change</p>
                <h2 className="mt-2 text-base font-semibold text-text-primary">
                  {selectedNode?.label ?? 'Select a node'}
                </h2>
                {selectedNode?.detail && (
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {selectedNode.detail}
                  </p>
                )}
                {selectedNode?.filePath && (
                  <button
                    type="button"
                    onClick={() => openNode(selectedNode)}
                    className="mt-3 flex max-w-full items-center gap-2 font-mono text-xs text-accent hover:underline"
                  >
                    <FileCode2 size={13} className="shrink-0" />
                    <span className="truncate">
                      {selectedNode.filePath}
                      {selectedNode.line ? `:${selectedNode.line}` : ''}
                    </span>
                    <ExternalLink size={11} className="shrink-0" />
                  </button>
                )}
              </div>

              {selectedRisk && (
                <section className="border-b border-border-subtle p-4">
                  <div className="flex items-center gap-2 text-error">
                    <ShieldAlert size={14} />
                    <h3 className="text-xs font-semibold">{selectedRisk.title}</h3>
                    <span className="ml-auto text-xs capitalize">{selectedRisk.severity}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {selectedRisk.explanation}
                  </p>
                  {selectedRisk.evidence && (
                    <p className="mt-2 text-xs leading-5 text-text-tertiary">
                      Evidence: {selectedRisk.evidence}
                    </p>
                  )}
                </section>
              )}

              <section className="p-4">
                <h3 className="text-xs font-semibold text-text-secondary">Linked evidence</h3>
                {(selectedEvidence?.length ?? 0) > 0 ? (
                  <div className="mt-3 divide-y divide-border-subtle">
                    {selectedEvidence?.map((evidence) => (
                      <div key={evidence.id} className="py-3 first:pt-0">
                        <div className="flex items-start gap-2">
                          {evidence.status === 'verified' ? (
                            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-success" />
                          ) : evidence.status === 'risk' ? (
                            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-error" />
                          ) : (
                            <Route size={13} className="mt-0.5 shrink-0 text-info" />
                          )}
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-text-primary">
                              {evidence.label}
                            </p>
                            {evidence.detail && (
                              <p className="mt-1 text-sm leading-6 text-text-tertiary">
                                {evidence.detail}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs leading-5 text-text-tertiary">
                    Select a connected node to inspect its supporting evidence.
                  </p>
                )}
              </section>
            </aside>
          </div>

          <footer className="flex min-h-20 items-center gap-3 overflow-x-auto border-t border-border-subtle bg-bg-secondary/65 px-4">
            <div className="mr-2 w-80 shrink-0">
              <p className="text-xs font-semibold text-text-secondary">Review path</p>
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-tertiary">
                {visualisation.summary}
              </p>
            </div>
            {visualisation.chapters.map((chapter, index) => (
              <button
                key={chapter.id}
                type="button"
                onClick={() => setSelectedChapterId(chapter.id)}
                className={`flex min-w-44 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                  selectedChapterId === chapter.id
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-border-subtle hover:bg-bg-tertiary/60'
                }`}
              >
                <span className="font-mono text-xs text-text-tertiary">{index + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-text-primary">
                    {chapter.title}
                  </span>
                  <span className="mt-1 block text-xs text-text-tertiary">
                    {chapter.riskCount} risk · {chapter.verifiedCount} verified
                  </span>
                </span>
              </button>
            ))}
          </footer>
        </>
      )}
    </div>
  );
}

function PullRequestNode({ data, selected }: NodeProps<CanvasNode>) {
  const item = data.item;
  const color = toneColor(item.tone);
  return (
    <div
      className={`pr-canvas-node min-w-44 rounded-lg bg-bg-secondary px-3 py-2.5 transition-[border-color,background-color,transform] duration-200 ${
        selected ? 'bg-bg-elevated' : ''
      }`}
      style={{ '--pr-node-color': color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
        <span className="text-xs font-semibold text-text-primary">{item.label}</span>
      </div>
      {item.filePath && (
        <p className="mt-1 max-w-48 truncate font-mono text-xs text-text-tertiary">
          {item.filePath}
        </p>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function buildFlow(
  visualisation: PullRequestVisualisation | null,
  changeState: PullRequestVisualisationChangeState,
  chapterId: string | null,
): { nodes: CanvasNode[]; edges: Edge[] } {
  if (!visualisation) return { nodes: [], edges: [] };
  const visible = visualisation.nodes.filter(
    (node) =>
      (node.changeState === 'both' || node.changeState === changeState) &&
      (!chapterId || node.chapterId === chapterId || !node.chapterId),
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const columns = Math.max(2, Math.ceil(Math.sqrt(visible.length)));
  const nodes = visible.map<CanvasNode>((item, index) => ({
    id: item.id,
    type: 'pullRequest',
    position: {
      x: (index % columns) * 260,
      y: Math.floor(index / columns) * 150 + ((index % columns) % 2) * 26,
    },
    data: { item },
  }));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const edges = visualisation.edges
    .filter(
      (edge) =>
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        (edge.changeState === 'both' || edge.changeState === changeState),
    )
    .map<Edge>((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: edge.changed && edge.tone === 'action' && !reduceMotion,
      label: edge.label,
      style: {
        stroke: toneColor(edge.tone),
        strokeWidth: edge.changed ? 2.2 : 1.2,
        opacity: edge.changed ? 1 : 0.56,
      },
      labelStyle: { fill: 'var(--color-text-secondary)', fontSize: 12 },
      labelBgStyle: { fill: 'var(--color-bg-secondary)', fillOpacity: 0.92 },
    }));
  return { nodes, edges };
}

function toneColor(tone: PullRequestVisualisationTone): string {
  if (tone === 'action') return 'var(--color-accent)';
  if (tone === 'data') return 'var(--color-info)';
  if (tone === 'verified') return 'var(--color-success)';
  if (tone === 'risk') return 'var(--color-error)';
  if (tone === 'logic') return 'var(--color-persona-docs)';
  if (tone === 'uncertainty') return 'var(--color-warning)';
  return 'var(--color-text-tertiary)';
}
