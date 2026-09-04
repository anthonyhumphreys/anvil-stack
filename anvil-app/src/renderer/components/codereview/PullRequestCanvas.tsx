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
  Box,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Database,
  Download,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  MessageSquareText,
  RefreshCw,
  Route,
  ServerCog,
  ShieldAlert,
  Sparkles,
  TestTube2,
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
import {
  isRenderablePullRequestEdge,
  layoutPullRequestNodes,
} from '../../utils/pull-request-layout';
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
  dimmed: boolean;
}

type CanvasNode = Node<CanvasNodeData, 'pullRequest'>;

const nodeTypes = { pullRequest: PullRequestNode };

interface CanvasErrorPresentation {
  message: string;
  retryable: boolean;
}

function presentCanvasError(error: string): CanvasErrorPresentation {
  if (/unexpected argument|unknown (?:argument|option)/i.test(error)) {
    return {
      message: 'The installed Codex CLI is not compatible with this version of Anvil.',
      retryable: false,
    };
  }

  if (/spawn codex enoent|codex: command not found/i.test(error)) {
    return {
      message: 'Anvil could not find the Codex CLI on this computer.',
      retryable: false,
    };
  }

  return {
    message: 'The request failed before the change story was ready.',
    retryable: true,
  };
}

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

  useEffect(() => {
    const visibleNodes = visualisation?.nodes.filter(
      (node) =>
        (node.changeState === 'both' || node.changeState === changeState) &&
        (!selectedChapterId || node.chapterId === selectedChapterId || !node.chapterId),
    );
    if (
      visibleNodes &&
      visibleNodes.length > 0 &&
      !visibleNodes.some((node) => node.id === selectedNodeId)
    ) {
      setSelectedNodeId(visibleNodes[0].id);
    }
  }, [changeState, selectedChapterId, selectedNodeId, visualisation]);

  const layoutPositions = useMemo(
    () => buildChapterLayoutPositions(visualisation, selectedChapterId),
    [selectedChapterId, visualisation],
  );
  const { nodes, edges } = useMemo(
    () => buildFlow(visualisation, changeState, selectedChapterId, selectedNodeId, layoutPositions),
    [changeState, layoutPositions, selectedChapterId, selectedNodeId, visualisation],
  );
  const visibleNodeCount = nodes.filter((node) => !node.hidden).length;
  const riskCount = visualisation?.risks.length ?? 0;
  const verifiedCount =
    visualisation?.evidence.filter((item) => item.status === 'verified').length ?? 0;
  const errorPresentation = error ? presentCanvasError(error) : null;

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
        <div
          className="w-full max-w-md px-6 text-center"
          role={error ? 'alert' : 'status'}
          aria-live={error ? 'assertive' : 'polite'}
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
            {error ? <AlertTriangle size={18} /> : <Sparkles size={18} className="animate-pulse" />}
          </div>
          <p className="mt-4 text-sm font-semibold text-text-primary">
            {error ? 'PR Canvas could not be generated' : 'Building the change story'}
          </p>
          <p className="mt-2 text-xs leading-5 text-text-secondary">
            {errorPresentation?.message ??
              'Tracing behaviour, evidence, risks, and before/after logic across the pull request.'}
          </p>
          {errorPresentation && (
            <details className="mt-3 text-left text-xs text-text-tertiary">
              <summary className="mx-auto w-fit cursor-pointer select-none hover:text-text-secondary">
                Technical details
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-secondary p-3 font-mono leading-5 text-text-tertiary">
                {error}
              </pre>
            </details>
          )}
          {errorPresentation?.retryable && (
            <button
              type="button"
              onClick={() => void generate(true)}
              className="mt-4 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={generating}
            >
              {generating ? 'Retrying…' : 'Try again'}
            </button>
          )}
        </div>
      </div>
    );
  }

  const pr = visualisation.pullRequest;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <header className="flex min-h-[68px] items-center gap-4 border-b border-border-subtle bg-bg-secondary/35 px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          <GitPullRequest size={18} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2" title={pr.title}>
            <span className="shrink-0 font-mono text-xs font-semibold text-accent">#{pr.id}</span>
            <h1 className="truncate text-sm font-semibold text-text-primary">{pr.title}</h1>
            {pr.isDraft && (
              <span className="shrink-0 rounded-md bg-bg-elevated px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Draft
              </span>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
            <span className="truncate font-mono">{pr.sourceBranch}</span>
            <ChevronRight size={12} className="shrink-0 text-text-muted" />
            <span className="truncate font-mono">{pr.targetBranch}</span>
            <span className="shrink-0 text-border">/</span>
            <span className="shrink-0 font-mono tabular-nums">
              {visualisation.headSha.slice(0, 8)}
            </span>
          </div>
        </div>

        <div className="hidden shrink-0 items-center gap-4 border-l border-border-subtle pl-4 lg:flex">
          <SignalCount
            icon={<ShieldAlert size={13} />}
            value={riskCount}
            label={riskCount === 1 ? 'risk' : 'risks'}
            tone={riskCount > 0 ? 'risk' : 'neutral'}
          />
          <SignalCount
            icon={<CheckCircle2 size={13} />}
            value={verifiedCount}
            label="verified"
            tone="verified"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-bg-primary p-1">
          {(['story', 'map', 'diff'] as ExperienceMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              aria-pressed={mode === item}
              className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                mode === item
                  ? 'bg-bg-elevated text-text-primary shadow-sm'
                  : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
              }`}
            >
              {item}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => askInChat()}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
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
            <aside
              className={`shrink-0 overflow-y-auto border-r border-border-subtle bg-bg-secondary/45 ${
                mode === 'story' ? 'w-[340px]' : 'w-[250px] 2xl:w-[280px]'
              }`}
            >
              <div className="border-b border-border-subtle p-4">
                <h2 className="text-sm font-semibold text-text-primary">Change story</h2>
                <p
                  className={`mt-2 text-sm text-text-secondary ${
                    mode === 'story' ? 'leading-6' : 'line-clamp-3 leading-5'
                  }`}
                >
                  {visualisation.intent || visualisation.summary}
                </p>
              </div>
              <nav className="p-2" aria-label="Pull request chapters">
                {visualisation.chapters.map((chapter, index) => {
                  const selected = selectedChapterId === chapter.id;
                  return (
                    <button
                      key={chapter.id}
                      type="button"
                      onClick={() => setSelectedChapterId(chapter.id)}
                      aria-current={selected ? 'step' : undefined}
                      className={`group mb-1 w-full rounded-lg px-3 py-3 text-left transition-colors ${
                        selected
                          ? 'bg-bg-elevated text-text-primary'
                          : 'text-text-secondary hover:bg-bg-tertiary/70'
                      }`}
                    >
                      <span className="flex items-start gap-2.5">
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-xs font-semibold tabular-nums ${
                            selected
                              ? 'bg-accent text-white'
                              : 'bg-bg-primary text-text-tertiary group-hover:text-text-secondary'
                          }`}
                        >
                          {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-semibold leading-5">
                            {chapter.title}
                          </span>
                          {mode === 'story' && (
                            <span className="mt-1 block text-xs leading-5 text-text-tertiary">
                              {chapter.summary}
                            </span>
                          )}
                          <span className="mt-2 flex items-center gap-3 text-xs text-text-tertiary">
                            <span
                              className={
                                chapter.riskCount > 0
                                  ? 'inline-flex items-center gap-1 text-error'
                                  : 'inline-flex items-center gap-1'
                              }
                            >
                              <ShieldAlert size={11} />
                              <span className="tabular-nums">{chapter.riskCount}</span>
                            </span>
                            <span className="inline-flex items-center gap-1 text-success">
                              <CheckCircle2 size={11} />
                              <span className="tabular-nums">{chapter.verifiedCount}</span>
                            </span>
                          </span>
                        </span>
                        <ChevronRight
                          size={13}
                          className={`mt-1 shrink-0 ${selected ? 'text-accent' : 'text-text-muted'}`}
                        />
                      </span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <main className="pr-canvas-stage relative min-w-0 flex-1">
              <div className="absolute left-4 top-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-bg-secondary p-1 shadow-lg shadow-black/10">
                {(['before', 'after'] as const).map((state) => (
                  <button
                    key={state}
                    type="button"
                    onClick={() => setChangeState(state)}
                    aria-pressed={changeState === state}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                      changeState === state
                        ? 'bg-accent text-white'
                        : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                    }`}
                  >
                    {state}
                  </button>
                ))}
                <ArrowLeftRight size={13} className="mx-1 text-text-muted" />
              </div>
              <div className="absolute bottom-4 left-4 z-10 flex items-center gap-3 rounded-md bg-bg-primary/90 px-2.5 py-1.5 text-xs text-text-tertiary">
                <span className="font-mono tabular-nums">{visibleNodeCount} changes</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" /> selected path
                </span>
              </div>
              <ReactFlow
                key={selectedChapterId ?? 'all-chapters'}
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{
                  padding: 0.18,
                  minZoom: 0.3,
                  maxZoom: 1.05,
                  includeHiddenNodes: true,
                }}
                minZoom={0.3}
                maxZoom={1.6}
                onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
                className="pr-canvas-flow"
              >
                <Background color="var(--color-border-subtle)" gap={28} size={1} />
                <Controls position="top-right" showInteractive={false} />
                {visibleNodeCount > 6 && (
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(node) => toneColor(node.data.item.tone)}
                    maskColor="color-mix(in srgb, var(--color-bg-primary) 78%, transparent)"
                  />
                )}
              </ReactFlow>
            </main>

            <aside className="w-[310px] shrink-0 overflow-y-auto border-l border-border-subtle bg-bg-secondary/55 2xl:w-[360px]">
              <div className="border-b border-border-subtle p-4">
                <div className="flex items-center gap-2 text-xs text-text-tertiary">
                  {selectedNode && <NodeKindIcon kind={selectedNode.kind} size={13} />}
                  <span className="capitalize">{selectedNode?.kind ?? 'Selected change'}</span>
                  {selectedNode && (
                    <span className="ml-auto rounded-md bg-bg-primary px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide text-text-tertiary">
                      {selectedNode.changeState}
                    </span>
                  )}
                </div>
                <h2 className="mt-2 text-base font-semibold leading-6 text-text-primary">
                  {selectedNode?.label ?? 'Select a node'}
                </h2>
                {selectedNode?.detail && (
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {selectedNode.detail}
                  </p>
                )}
                {selectedNode && (
                  <div className="mt-4 flex gap-2">
                    {selectedNode.filePath && (
                      <button
                        type="button"
                        onClick={() => openNode(selectedNode)}
                        className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/85"
                      >
                        <FileCode2 size={13} className="shrink-0" />
                        <span>Open source</span>
                        <ExternalLink size={11} className="shrink-0" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => askInChat()}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      <MessageSquareText size={13} /> Ask
                    </button>
                  </div>
                )}
                {selectedNode?.filePath && (
                  <p
                    className="mt-3 truncate font-mono text-xs text-text-tertiary"
                    title={selectedNode.filePath}
                  >
                    {selectedNode.filePath}
                    {selectedNode.line ? `:${selectedNode.line}` : ''}
                  </p>
                )}
              </div>

              {selectedRisk && (
                <section className="border-b border-border-subtle p-4">
                  <div className="flex items-start gap-2 text-error">
                    <ShieldAlert size={14} />
                    <h3 className="min-w-0 flex-1 text-xs font-semibold leading-5">
                      {selectedRisk.title}
                    </h3>
                    <span className="rounded-md bg-error/10 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
                      {selectedRisk.severity}
                    </span>
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
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-text-secondary">Linked evidence</h3>
                  {(selectedEvidence?.length ?? 0) > 0 && (
                    <span className="ml-auto font-mono text-xs tabular-nums text-text-tertiary">
                      {selectedEvidence?.length}
                    </span>
                  )}
                </div>
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
      className={`pr-canvas-node flex h-[92px] w-64 flex-col justify-center rounded-xl bg-bg-secondary px-4 py-3 transition-[border-color,background-color,box-shadow,opacity,transform] duration-200 ${
        selected ? 'is-selected bg-bg-elevated' : ''
      } ${data.dimmed ? 'opacity-35' : 'opacity-100'}`}
      style={{ '--pr-node-color': color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
        >
          <NodeKindIcon kind={item.kind} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text-primary">
            {item.label}
          </span>
          <span className="mt-0.5 block truncate font-mono text-xs text-text-tertiary">
            {item.filePath ?? item.kind}
          </span>
        </span>
        {item.changeState !== 'both' && (
          <span className="self-start rounded-md bg-bg-primary px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide text-text-tertiary">
            {item.changeState}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function NodeKindIcon({
  kind,
  size,
}: {
  kind: PullRequestVisualisationNode['kind'];
  size: number;
}) {
  if (kind === 'entry') return <CircleDot size={size} />;
  if (kind === 'service') return <ServerCog size={size} />;
  if (kind === 'data') return <Database size={size} />;
  if (kind === 'file') return <FileCode2 size={size} />;
  if (kind === 'test') return <TestTube2 size={size} />;
  if (kind === 'risk') return <ShieldAlert size={size} />;
  return <Box size={size} />;
}

function SignalCount({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone: 'risk' | 'verified' | 'neutral';
}) {
  const color =
    tone === 'risk' ? 'text-error' : tone === 'verified' ? 'text-success' : 'text-text-tertiary';
  return (
    <div className={`flex items-center gap-1.5 text-xs ${color}`}>
      {icon}
      <span className="font-mono font-semibold tabular-nums">{value}</span>
      <span className="text-text-tertiary">{label}</span>
    </div>
  );
}

function buildFlow(
  visualisation: PullRequestVisualisation | null,
  changeState: PullRequestVisualisationChangeState,
  chapterId: string | null,
  selectedNodeId: string | null,
  positions: Map<string, { x: number; y: number }>,
): { nodes: CanvasNode[]; edges: Edge[] } {
  if (!visualisation) return { nodes: [], edges: [] };
  const chapterNodes = visualisation.nodes.filter(
    (node) => !chapterId || node.chapterId === chapterId || !node.chapterId,
  );
  const chapterNodeIds = new Set(chapterNodes.map((node) => node.id));
  const chapterEdges = visualisation.edges.filter((edge) =>
    isRenderablePullRequestEdge(edge, chapterNodeIds),
  );
  const visibleIds = new Set(
    chapterNodes
      .filter((node) => node.changeState === 'both' || node.changeState === changeState)
      .map((node) => node.id),
  );
  const visibleEdges = chapterEdges.filter(
    (edge) =>
      visibleIds.has(edge.source) &&
      visibleIds.has(edge.target) &&
      (edge.changeState === 'both' || edge.changeState === changeState),
  );
  const activeSelectedNodeId =
    selectedNodeId && visibleIds.has(selectedNodeId) ? selectedNodeId : null;
  const selectedRoute = getSelectedRoute(activeSelectedNodeId, visibleEdges);
  const hasSelectedRoute = activeSelectedNodeId !== null && selectedRoute.nodeIds.size > 0;
  const nodes = chapterNodes.map<CanvasNode>((item) => ({
    id: item.id,
    type: 'pullRequest',
    position: positions.get(item.id) ?? { x: 0, y: 0 },
    hidden: !visibleIds.has(item.id),
    selected: item.id === activeSelectedNodeId,
    data: {
      item,
      dimmed: hasSelectedRoute && !selectedRoute.nodeIds.has(item.id),
    },
  }));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const edges = visibleEdges.map<Edge>((edge) => {
    const onSelectedRoute = !hasSelectedRoute || selectedRoute.edgeIds.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: onSelectedRoute && edge.changed && edge.tone === 'action' && !reduceMotion,
      label: onSelectedRoute ? edge.label : undefined,
      zIndex: onSelectedRoute ? 2 : 0,
      style: {
        stroke: toneColor(edge.tone),
        strokeWidth: onSelectedRoute ? (edge.changed ? 2.4 : 1.8) : 1,
        opacity: onSelectedRoute ? 1 : 0.24,
      },
      labelStyle: { fill: 'var(--color-text-secondary)', fontSize: 12 },
      labelBgStyle: { fill: 'var(--color-bg-secondary)', fillOpacity: 0.92 },
      labelBgPadding: [8, 4],
      labelBgBorderRadius: 6,
    };
  });
  return { nodes, edges };
}

function buildChapterLayoutPositions(
  visualisation: PullRequestVisualisation | null,
  chapterId: string | null,
): Map<string, { x: number; y: number }> {
  if (!visualisation) return new Map();
  const chapterNodes = visualisation.nodes.filter(
    (node) => !chapterId || node.chapterId === chapterId || !node.chapterId,
  );
  const nodeIds = new Set(chapterNodes.map((node) => node.id));
  const chapterEdges = visualisation.edges.filter((edge) =>
    isRenderablePullRequestEdge(edge, nodeIds),
  );
  return layoutPullRequestNodes(chapterNodes, chapterEdges);
}

function getSelectedRoute(
  selectedNodeId: string | null,
  edges: PullRequestVisualisation['edges'],
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!selectedNodeId) return { nodeIds, edgeIds };
  nodeIds.add(selectedNodeId);

  const visit = (nodeId: string, direction: 'incoming' | 'outgoing'): void => {
    for (const edge of edges) {
      const connects = direction === 'incoming' ? edge.target === nodeId : edge.source === nodeId;
      if (!connects || edgeIds.has(edge.id)) continue;
      edgeIds.add(edge.id);
      const nextId = direction === 'incoming' ? edge.source : edge.target;
      nodeIds.add(nextId);
      visit(nextId, direction);
    }
  };

  visit(selectedNodeId, 'incoming');
  visit(selectedNodeId, 'outgoing');
  return { nodeIds, edgeIds };
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
