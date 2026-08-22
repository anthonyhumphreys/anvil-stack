import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
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
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Braces,
  ChevronRight,
  FileCode2,
  Folder,
  GitBranch,
  MessageSquareText,
  RadioTower,
  PackageOpen,
  Search,
  ShieldCheck,
  TreePine,
  X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type {
  ModuleSummary,
  RepositoryChangedFile,
  RepositoryChangeStatus,
  RepositoryMapGraph,
  RepositoryMapGraphNode,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

interface RepositoryMapProps {
  repoId?: string;
  repositoryName: string;
  modules: ModuleSummary[];
  graph?: RepositoryMapGraph | null;
  changedFiles?: RepositoryChangedFile[];
  className?: string;
  compact?: boolean;
  changeMode?: boolean;
}

interface NodeChanges {
  files: RepositoryChangedFile[];
  counts: Record<RepositoryChangeStatus, number>;
}

interface MapNodeData extends Record<string, unknown> {
  graphNode: RepositoryMapGraphNode;
  changes?: NodeChanges;
  hasChildren: boolean;
  onOpen: (nodeId: string) => void;
}

type MapNode = Node<MapNodeData, 'repositoryMap'>;

const NODE_WIDTH = 240;
const NODE_GAP_X = 56;
const NODE_GAP_Y = 28;
const COLUMNS = 3;
const EMPTY_COUNTS: Record<RepositoryChangeStatus, number> = {
  added: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
};
const LazyRepositoryGarden = lazy(() =>
  import('./RepositoryGarden').then((module) => ({ default: module.RepositoryGarden })),
);
const LazyRepositoryTwin = lazy(() =>
  import('./RepositoryTwin').then((module) => ({ default: module.RepositoryTwin })),
);

export function RepositoryMap({
  repoId,
  repositoryName,
  modules,
  graph,
  changedFiles = [],
  className = '',
  compact = false,
  changeMode,
}: RepositoryMapProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const resolvedGraph = useMemo(
    () => graph ?? buildLegacyGraph(repositoryName, modules),
    [graph, modules, repositoryName],
  );
  const rootNode = resolvedGraph.nodes.find((node) => node.kind === 'repository');
  const [currentScopeId, setCurrentScopeId] = useState(rootNode?.id ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDependencies, setShowDependencies] = useState(true);
  const [viewMode, setViewMode] = useState<'map' | 'garden' | 'twin'>('map');

  const nodesById = useMemo(
    () => new Map(resolvedGraph.nodes.map((node) => [node.id, node])),
    [resolvedGraph.nodes],
  );
  const currentScope = nodesById.get(currentScopeId) ?? rootNode;
  const children = useMemo(
    () =>
      resolvedGraph.nodes
        .filter((node) => node.parentId === currentScope?.id)
        .toSorted(compareExplorerNodes),
    [currentScope?.id, resolvedGraph.nodes],
  );
  const childIds = useMemo(() => new Set(children.map((node) => node.id)), [children]);
  const childrenByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of resolvedGraph.nodes) {
      if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    }
    return counts;
  }, [resolvedGraph.nodes]);
  const descendantsById = useMemo(
    () => buildDescendantPaths(resolvedGraph.nodes),
    [resolvedGraph.nodes],
  );
  const searchResults = useMemo(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (normalized.length < 2) return [];
    return resolvedGraph.nodes
      .filter(
        (node) =>
          node.kind !== 'repository' &&
          (node.name.toLowerCase().includes(normalized) || node.path.toLowerCase().includes(normalized)),
      )
      .slice(0, 6);
  }, [resolvedGraph.nodes, searchQuery]);
  const hasChanges = changeMode ?? changedFiles.length > 0;

  const openScope = (nodeId: string) => {
    if (!childrenByParent.get(nodeId)) return;
    setCurrentScopeId(nodeId);
    setSelectedNodeId(null);
    setSearchQuery('');
  };

  const { flowNodes, flowEdges } = useMemo(() => {
    const columnCount = children.length <= 6 ? 2 : COLUMNS;
    const flowNodes = children.map<MapNode>((node, index) => ({
      id: node.id,
      type: 'repositoryMap',
      position: {
        x: (index % columnCount) * (NODE_WIDTH + NODE_GAP_X),
        y: Math.floor(index / columnCount) * (nodeHeight(node.kind) + NODE_GAP_Y),
      },
      data: {
        graphNode: node,
        changes: getNodeChanges(node, changedFiles, descendantsById.get(node.id)),
        hasChildren: Boolean(childrenByParent.get(node.id)),
        onOpen: openScope,
      },
    }));
    const flowEdges = showDependencies
      ? resolvedGraph.edges
          .filter(
            (edge) =>
              edge.kind === 'dependency' && childIds.has(edge.source) && childIds.has(edge.target),
          )
          .map<Edge>((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            label: edge.count && edge.count > 1 ? String(edge.count) : undefined,
            style: { stroke: 'var(--color-info)', strokeWidth: 1.5 },
            labelStyle: { fill: 'var(--color-text-secondary)', fontSize: 12 },
          }))
      : [];
    return { flowNodes, flowEdges };
  }, [
    changedFiles,
    childIds,
    children,
    childrenByParent,
    descendantsById,
    resolvedGraph.edges,
    showDependencies,
  ]);

  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) : undefined;
  const selectedChanges = selectedNode
    ? getNodeChanges(selectedNode, changedFiles, descendantsById.get(selectedNode.id))
    : undefined;
  const breadcrumbs = currentScope
    ? buildBreadcrumbs(currentScope, nodesById)
    : rootNode
      ? [rootNode]
      : [];

  const jumpToNode = (node: RepositoryMapGraphNode) => {
    setCurrentScopeId(node.parentId ?? rootNode?.id ?? '');
    setSelectedNodeId(node.id);
    setSearchQuery('');
  };

  const openInEditor = (node: RepositoryMapGraphNode) => {
    if (!repoId || (node.kind !== 'file' && node.kind !== 'symbol')) return;
    navigate(
      buildEditorUrl({
        workspaceId: activeWorkspace?.id,
        repoId,
        relativePath: node.path,
        line: node.sourceRange?.startLine,
        source: hasChanges ? 'codereview' : 'repos',
        title: node.sourceRange ? `${node.path}:${node.sourceRange.startLine}` : node.path,
      }),
    );
  };

  const askChat = (node: RepositoryMapGraphNode, question?: string) => {
    const prompt = buildRepositoryNodePrompt(repositoryName, node, selectedChanges, question);
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  };

  return (
    <div
      className={`repository-explorer overflow-hidden rounded-xl border border-border bg-bg-secondary ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <nav aria-label="Repository map breadcrumb" className="flex min-w-0 flex-1 items-center gap-1">
          {breadcrumbs.map((node, index) => (
            <span key={node.id} className="flex min-w-0 items-center gap-1">
              {index > 0 && <ChevronRight size={13} className="shrink-0 text-text-muted" />}
              <button
                type="button"
                onClick={() => {
                  setCurrentScopeId(node.id);
                  setSelectedNodeId(null);
                }}
                aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                className={`truncate rounded-md px-1.5 py-1 text-xs transition-colors ${
                  index === breadcrumbs.length - 1
                    ? 'font-medium text-text-primary'
                    : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                {node.kind === 'repository' ? repositoryName : node.name}
              </button>
            </span>
          ))}
        </nav>

        {viewMode !== 'twin' && (
          <label className="relative min-w-44 flex-1 sm:max-w-64">
            <span className="sr-only">Find a module, file, or symbol</span>
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Find code..."
              className="h-8 w-full rounded-md border border-border bg-bg-primary pl-8 pr-2 text-xs text-text-primary placeholder:text-text-muted"
            />
          </label>
        )}
        {viewMode !== 'twin' && (
          <button
            type="button"
            aria-pressed={showDependencies}
            onClick={() => setShowDependencies((visible) => !visible)}
            className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors ${
              showDependencies
                ? 'border-info/40 bg-info/10 text-info'
                : 'border-border text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
          >
            <GitBranch size={13} /> Paths
          </button>
        )}
        <div className="flex h-8 rounded-md border border-border bg-bg-primary p-0.5" role="group" aria-label="Repository view">
          <button
            type="button"
            aria-pressed={viewMode === 'map'}
            onClick={() => setViewMode('map')}
            className={`rounded px-2 text-xs transition-colors ${
              viewMode === 'map'
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            Map
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'garden'}
            onClick={() => setViewMode('garden')}
            className={`flex items-center gap-1 rounded px-2 text-xs transition-colors ${
              viewMode === 'garden'
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            <TreePine size={12} /> Garden
          </button>
          <button
            type="button"
            aria-pressed={viewMode === 'twin'}
            onClick={() => setViewMode('twin')}
            className={`flex items-center gap-1 rounded px-2 text-xs transition-colors ${
              viewMode === 'twin'
                ? 'bg-bg-elevated text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            <RadioTower size={12} /> Twin
          </button>
        </div>
      </div>

      {viewMode !== 'twin' && searchResults.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5 border-b border-border-subtle bg-bg-primary px-3 py-2"
          role="listbox"
        >
          {searchResults.map((node) => (
            <button
              key={node.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => jumpToNode(node)}
              className="flex max-w-72 items-center gap-1.5 rounded-md border border-border-subtle bg-bg-secondary px-2 py-1 text-xs text-text-secondary hover:border-border hover:text-text-primary"
            >
              <NodeKindIcon kind={node.kind} size={12} />
              <span className="truncate font-mono">{node.path}</span>
              {node.kind === 'symbol' && <span className="truncate">· {node.name}</span>}
            </button>
          ))}
        </div>
      )}

      {!graph && (
        <div className="border-b border-warning/25 bg-warning/8 px-3 py-2 text-xs text-text-secondary">
          Refresh the map once to enable folder, file, symbol, and dependency drilldown.
        </div>
      )}

      <div
        className={`repository-explorer-body grid min-h-0 ${selectedNode && viewMode !== 'twin' ? 'has-inspector' : ''}`}
      >
        {viewMode === 'twin' ? (
          <Suspense fallback={<GardenLoading compact={compact} />}>
            <LazyRepositoryTwin
              repoId={repoId}
              repositoryName={repositoryName}
              graph={resolvedGraph}
              compact={compact}
            />
          </Suspense>
        ) : viewMode === 'garden' ? (
          <RepositoryGardenBoundary
            fallback={
              <GardenUnavailable
                compact={compact}
                onReturnToMap={() => setViewMode('map')}
              />
            }
          >
            <Suspense fallback={<GardenLoading compact={compact} />}>
              <LazyRepositoryGarden
                graph={resolvedGraph}
                changedFiles={changedFiles}
                selectedNodeId={selectedNodeId}
                compact={compact}
                onSelectNode={(nodeId) => setSelectedNodeId(nodeId || null)}
              />
            </Suspense>
          </RepositoryGardenBoundary>
        ) : (
          <div className="relative min-w-0" style={{ height: compact ? 400 : 560 }}>
            {flowNodes.length > 0 ? (
              <ReactFlow
                key={currentScope?.id}
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: compact ? 0.16 : 0.24, minZoom: 0.65, maxZoom: 1 }}
                minZoom={0.55}
                maxZoom={1.4}
                nodesDraggable={false}
                nodesConnectable={false}
                edgesFocusable={false}
                elementsSelectable
                onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
                onNodeDoubleClick={(_event, node) => openScope(node.id)}
                onPaneClick={() => setSelectedNodeId(null)}
                colorMode="dark"
                proOptions={{ hideAttribution: true }}
                aria-label={`${currentScope?.name ?? repositoryName} repository map`}
              >
                <Background gap={32} size={1} color="var(--color-border-subtle)" />
                {flowNodes.length > 9 && (
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(node) =>
                      node.data.changes ? 'var(--color-warning)' : 'var(--color-bg-elevated)'
                    }
                    maskColor="color-mix(in srgb, var(--color-bg-primary) 78%, transparent)"
                  />
                )}
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="grid h-full place-items-center px-6 text-center">
                <div>
                  <Box size={28} className="mx-auto text-text-muted" />
                  <p className="mt-3 text-sm font-medium text-text-primary">No deeper layer indexed</p>
                  <p className="mt-1 max-w-sm text-xs text-text-tertiary">
                    This file may use an unsupported language, or this area contains no child nodes.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedNode && viewMode !== 'twin' && (
          <RepositoryInspector
            node={selectedNode}
            changes={selectedChanges}
            hasChildren={Boolean(childrenByParent.get(selectedNode.id))}
            repoId={repoId}
            onClose={() => setSelectedNodeId(null)}
            onOpenScope={() => openScope(selectedNode.id)}
            onOpenEditor={() => openInEditor(selectedNode)}
            onAskChat={(question) => askChat(selectedNode, question)}
            onOpenSecurity={() => repoId && navigate(`/security/${repoId}`)}
          />
        )}
      </div>

      {hasChanges && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-3 py-2 text-xs text-text-tertiary">
          <span>{changedFiles.length} changed files</span>
          <ChangeLegend />
        </div>
      )}
    </div>
  );
}

function RepositoryMapNode({ data, selected }: NodeProps<MapNode>) {
  const node = data.graphNode;
  const changes = data.changes;
  const Icon = nodeIcon(node.kind);
  return (
    <button
      type="button"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && data.hasChildren) data.onOpen(node.id);
      }}
      className={`group w-[240px] overflow-hidden rounded-xl border bg-bg-elevated text-left transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-bg-hover ${
        selected ? 'border-accent bg-bg-hover' : changes ? getChangeTone(changes.counts) : 'border-border'
      } ${node.kind === 'module' ? 'h-[108px]' : node.kind === 'symbol' ? 'h-[72px]' : 'h-[84px]'}`}
      aria-label={`${node.kind} ${node.name}${changes ? `, ${changes.files.length} changed files` : ''}${data.hasChildren ? ', press Enter to explore' : ''}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-bg-primary !bg-info"
      />
      <div className="flex items-start gap-3 p-3">
        <span
          className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
            node.kind === 'module'
              ? 'bg-accent/12 text-accent'
              : node.kind === 'directory'
                ? 'bg-warning/10 text-warning'
                : node.kind === 'symbol'
                  ? 'bg-info/10 text-info'
                  : 'bg-bg-tertiary text-text-secondary'
          }`}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-sm font-semibold text-text-primary">
              {node.name}
            </span>
            {node.exported && <ArrowUpFromLine size={12} className="shrink-0 text-info" />}
          </span>
          <span className="repository-node-purpose mt-1 block text-xs leading-4 text-text-tertiary">
            {node.purpose ?? nodeDescription(node)}
          </span>
        </span>
      </div>
      <span className="flex min-h-8 items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-xs text-text-tertiary">
        <span className="capitalize">{node.symbolKind ?? node.kind}</span>
        {data.hasChildren && <span className="ml-auto text-text-muted">Enter to explore</span>}
        {changes && <ChangeBadges changes={changes} />}
      </span>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-bg-primary !bg-info"
      />
    </button>
  );
}

function RepositoryInspector({
  node,
  changes,
  hasChildren,
  repoId,
  onClose,
  onOpenScope,
  onOpenEditor,
  onAskChat,
  onOpenSecurity,
}: {
  node: RepositoryMapGraphNode;
  changes?: NodeChanges;
  hasChildren: boolean;
  repoId?: string;
  onClose: () => void;
  onOpenScope: () => void;
  onOpenEditor: () => void;
  onAskChat: (question?: string) => void;
  onOpenSecurity: () => void;
}) {
  const canOpenSource = Boolean(repoId && (node.kind === 'file' || node.kind === 'symbol'));
  return (
    <aside className="repository-explorer-inspector min-h-0 overflow-auto border-t border-border bg-bg-primary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-text-primary">{node.name}</p>
          <p className="mt-1 break-words font-mono text-xs text-text-tertiary">{node.path}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close repository inspector"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </div>

      {node.purpose && <p className="mt-3 text-sm leading-5 text-text-secondary">{node.purpose}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-y border-border-subtle py-3 text-xs">
        <dt className="text-text-tertiary">Kind</dt>
        <dd className="text-right capitalize text-text-secondary">{node.symbolKind ?? node.kind}</dd>
        {node.language && (
          <>
            <dt className="text-text-tertiary">Language</dt>
            <dd className="text-right text-text-secondary">{node.language}</dd>
          </>
        )}
        {node.sourceRange && (
          <>
            <dt className="text-text-tertiary">Lines</dt>
            <dd className="text-right font-mono text-text-secondary">
              {node.sourceRange.startLine}–{node.sourceRange.endLine}
            </dd>
          </>
        )}
      </dl>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {hasChildren && (
          <button
            type="button"
            onClick={onOpenScope}
            className="col-span-2 flex h-9 items-center justify-center gap-2 rounded-md bg-accent text-xs font-semibold text-bg-primary hover:bg-accent/90"
          >
            <ArrowDownToLine size={14} /> Explore this layer
          </button>
        )}
        {canOpenSource && (
          <button
            type="button"
            onClick={onOpenEditor}
            className="flex h-9 items-center justify-center gap-2 rounded-md border border-border text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <FileCode2 size={14} /> Open source
          </button>
        )}
        <button
          type="button"
          onClick={() => onAskChat()}
          className={`flex h-9 items-center justify-center gap-2 rounded-md border border-border text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary ${canOpenSource ? '' : 'col-span-2'}`}
        >
          <MessageSquareText size={14} /> Ask Chat
        </button>
      </div>

      <div className="mt-4 space-y-1.5">
        {[
          'Explain how this area works.',
          'What changed here recently?',
          'Identify technical debt in this area.',
        ].map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => onAskChat(question)}
            className="w-full rounded-md bg-bg-secondary px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            {question}
          </button>
        ))}
        {repoId && (
          <button
            type="button"
            onClick={onOpenSecurity}
            className="flex w-full items-center gap-2 rounded-md bg-bg-secondary px-2.5 py-2 text-left text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <ShieldCheck size={13} className="text-error" /> Review security evidence
          </button>
        )}
      </div>

      {changes && (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-secondary">Changed files</span>
            <ChangeBadges changes={changes} />
          </div>
          <div className="space-y-1">
            {changes.files.slice(0, 12).map((file) => (
              <div
                key={`${file.status}:${file.filePath}`}
                className="flex items-start gap-2 rounded-md bg-bg-secondary px-2.5 py-2"
              >
                <ChangeStatusDot status={file.status} />
                <span className="min-w-0 [overflow-wrap:anywhere] font-mono text-xs leading-4 text-text-secondary">
                  {file.filePath}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function ChangeLegend() {
  return (
    <span className="flex flex-wrap items-center gap-3">
      {(['added', 'modified', 'renamed', 'deleted'] as const).map((status) => (
        <span key={status} className="flex items-center gap-1.5 capitalize">
          <ChangeStatusDot status={status} />
          {status}
        </span>
      ))}
    </span>
  );
}

function ChangeStatusDot({ status }: { status: RepositoryChangeStatus }) {
  const color =
    status === 'added'
      ? 'bg-success'
      : status === 'deleted'
        ? 'bg-error'
        : status === 'renamed'
          ? 'bg-warning'
          : 'bg-info';
  return <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

function ChangeBadges({ changes }: { changes: NodeChanges }) {
  const label = (Object.entries(changes.counts) as Array<[RepositoryChangeStatus, number]>)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  return (
    <span className="ml-auto flex items-center gap-1.5 font-mono text-xs" aria-label={label} title={label}>
      {changes.counts.added > 0 && <span className="text-success">+{changes.counts.added}</span>}
      {changes.counts.modified > 0 && <span className="text-info">~{changes.counts.modified}</span>}
      {changes.counts.renamed > 0 && <span className="text-warning">↪{changes.counts.renamed}</span>}
      {changes.counts.deleted > 0 && <span className="text-error">−{changes.counts.deleted}</span>}
    </span>
  );
}

function getNodeChanges(
  node: RepositoryMapGraphNode,
  changedFiles: RepositoryChangedFile[],
  descendantPaths?: Set<string>,
): NodeChanges | undefined {
  const files = changedFiles.filter((file) => {
    const filePath = normalizePath(file.filePath);
    if (node.kind === 'repository') return true;
    if (node.kind === 'module') {
      return node.path === '.' || filePath === node.path || filePath.startsWith(`${node.path}/`);
    }
    if (node.kind === 'directory') {
      return filePath === node.path || filePath.startsWith(`${node.path}/`);
    }
    if (node.kind === 'file') return filePath === node.path;
    if (node.kind === 'symbol') {
      if (filePath !== node.path || !node.sourceRange) return false;
      const currentRanges = file.ranges?.filter((range) => range.side === 'current') ?? [];
      return (
        currentRanges.length === 0 ||
        currentRanges.some(
          (range) =>
            range.startLine <= node.sourceRange!.endLine &&
            range.endLine >= node.sourceRange!.startLine,
        )
      );
    }
    return descendantPaths?.has(filePath) ?? false;
  });
  if (files.length === 0) return undefined;
  return {
    files,
    counts: files.reduce<Record<RepositoryChangeStatus, number>>(
      (counts, file) => ({ ...counts, [file.status]: counts[file.status] + 1 }),
      { ...EMPTY_COUNTS },
    ),
  };
}

function buildDescendantPaths(nodes: RepositoryMapGraphNode[]): Map<string, Set<string>> {
  const children = new Map<string, RepositoryMapGraphNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const result = new Map<string, Set<string>>();
  const collect = (nodeId: string): Set<string> => {
    const cached = result.get(nodeId);
    if (cached) return cached;
    const paths = new Set<string>();
    for (const child of children.get(nodeId) ?? []) {
      if (child.kind === 'file') paths.add(child.path);
      for (const descendant of collect(child.id)) paths.add(descendant);
    }
    result.set(nodeId, paths);
    return paths;
  };
  for (const node of nodes) collect(node.id);
  return result;
}

function buildBreadcrumbs(
  node: RepositoryMapGraphNode,
  nodesById: Map<string, RepositoryMapGraphNode>,
): RepositoryMapGraphNode[] {
  const result = [node];
  let current = node;
  while (current.parentId) {
    const parent = nodesById.get(current.parentId);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

function buildLegacyGraph(repositoryName: string, modules: ModuleSummary[]): RepositoryMapGraph {
  const rootId = 'repository:legacy';
  return {
    schemaVersion: 1,
    repoId: 'legacy',
    repositoryName,
    generatedAt: new Date(0).toISOString(),
    supportedSymbolLanguages: [],
    warnings: ['Refresh the repository map to generate source-level detail.'],
    nodes: [
      {
        id: rootId,
        kind: 'repository',
        name: repositoryName,
        path: '.',
        fileCount: modules.reduce((total, module) => total + module.fileCount, 0),
      },
      ...modules.map<RepositoryMapGraphNode>((module) => ({
        id: `module:${module.path}`,
        kind: 'module',
        parentId: rootId,
        name: module.path === '.' ? 'Repository root' : module.path,
        path: module.path,
        modulePath: module.path,
        purpose: module.purpose,
        fileCount: module.fileCount,
      })),
    ],
    edges: [],
  };
}

function buildRepositoryNodePrompt(
  repositoryName: string,
  node: RepositoryMapGraphNode,
  changes?: NodeChanges,
  question?: string,
): string {
  const changeContext = changes
    ? `\nChanged files in this area:\n${changes.files.map((file) => `- ${file.status}: ${file.filePath}`).join('\n')}`
    : '';
  return [
    question ?? `Help me understand this ${node.kind}.`,
    '',
    `Repository: ${repositoryName}`,
    `Selected ${node.kind}: ${node.name}`,
    `Path: ${node.path}`,
    node.sourceRange
      ? `Source lines: ${node.sourceRange.startLine}-${node.sourceRange.endLine}`
      : '',
    node.purpose ? `Indexed purpose: ${node.purpose}` : '',
    changeContext,
    '',
    'Use repository evidence, cite relevant files and lines, and distinguish confirmed findings from suggestions.',
  ]
    .filter(Boolean)
    .join('\n');
}

function compareExplorerNodes(a: RepositoryMapGraphNode, b: RepositoryMapGraphNode): number {
  const order = { module: 0, directory: 1, file: 2, symbol: 3, repository: 4 };
  return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
}

function getChangeTone(counts: Record<RepositoryChangeStatus, number>): string {
  const activeStatuses = Object.values(counts).filter((count) => count > 0).length;
  if (activeStatuses > 1) return 'border-warning/55';
  if (counts.added) return 'border-success/55';
  if (counts.deleted) return 'border-error/55';
  if (counts.renamed) return 'border-warning/55';
  return 'border-info/55';
}

function nodeHeight(kind: RepositoryMapGraphNode['kind']): number {
  if (kind === 'module') return 108;
  if (kind === 'symbol') return 72;
  return 84;
}

function nodeDescription(node: RepositoryMapGraphNode): string {
  if (node.kind === 'module') return `${node.fileCount ?? 0} indexed files`;
  if (node.kind === 'directory') return 'Source directory';
  if (node.kind === 'file') {
    return node.symbolCount === undefined
      ? node.language
        ? `${node.language} source file`
        : 'Symbol indexing is not available for this file type'
      : `${node.symbolCount} indexed ${node.symbolCount === 1 ? 'symbol' : 'symbols'}`;
  }
  if (node.kind === 'symbol') return node.exported ? 'Exported symbol' : 'File-local symbol';
  return 'Indexed repository';
}

function nodeIcon(kind: RepositoryMapGraphNode['kind']) {
  if (kind === 'repository') return PackageOpen;
  if (kind === 'module') return Box;
  if (kind === 'directory') return Folder;
  if (kind === 'file') return FileCode2;
  return Braces;
}

function NodeKindIcon({ kind, size }: { kind: RepositoryMapGraphNode['kind']; size: number }) {
  const Icon = nodeIcon(kind);
  return <Icon size={size} className="shrink-0 text-text-tertiary" />;
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
}

class RepositoryGardenBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('[RepositoryGarden] Rendering failed', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function GardenLoading({ compact }: { compact: boolean }) {
  return (
    <div
      className="grid place-items-center bg-[#08140f]"
      style={{ height: compact ? 400 : 560 }}
      role="status"
    >
      <div className="text-center">
        <TreePine size={26} className="mx-auto text-success" />
        <p className="mt-3 text-sm font-medium text-text-primary">Opening the Archive Garden…</p>
        <p className="mt-1 text-xs text-text-tertiary">Laying paths from the indexed graph</p>
      </div>
    </div>
  );
}

function GardenUnavailable({
  compact,
  onReturnToMap,
}: {
  compact: boolean;
  onReturnToMap: () => void;
}) {
  return (
    <div
      className="grid place-items-center bg-bg-primary px-6 text-center"
      style={{ height: compact ? 400 : 560 }}
      role="alert"
    >
      <div>
        <TreePine size={28} className="mx-auto text-text-muted" />
        <p className="mt-3 text-sm font-medium text-text-primary">The garden could not start</p>
        <p className="mt-1 max-w-sm text-xs text-text-tertiary">
          WebGL may be unavailable on this device. The complete repository remains available in Map.
        </p>
        <button
          type="button"
          onClick={onReturnToMap}
          className="mt-4 h-9 rounded-md bg-accent px-3 text-xs font-semibold text-bg-primary hover:bg-accent/90"
        >
          Return to Map
        </button>
      </div>
    </div>
  );
}

const NODE_TYPES = { repositoryMap: RepositoryMapNode };
