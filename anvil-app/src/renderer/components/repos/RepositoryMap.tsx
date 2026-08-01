import { useMemo, useState } from 'react';
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
import { Boxes, FileCode2, FolderTree, GitPullRequest, PackageOpen } from 'lucide-react';
import type {
  ModuleSummary,
  RepositoryChangedFile,
  RepositoryChangeStatus,
} from '../../../shared/types';
import { groupChangesByModule, type RepositoryModuleChanges } from '../../utils/repository-map';

interface RepositoryMapProps {
  repositoryName: string;
  modules: ModuleSummary[];
  changedFiles?: RepositoryChangedFile[];
  className?: string;
  compact?: boolean;
  changeMode?: boolean;
}

interface MapNodeData extends Record<string, unknown> {
  kind: 'repository' | 'module' | 'other';
  label: string;
  purpose?: string;
  fileCount: number;
  changes?: RepositoryModuleChanges;
}

type MapNode = Node<MapNodeData, 'repositoryMap'>;

const NODE_WIDTH = 250;
const NODE_HEIGHT = 126;
const NODE_GAP_X = 100;
const NODE_GAP_Y = 34;
const ROWS_PER_COLUMN = 4;

export function RepositoryMap({
  repositoryName,
  modules,
  changedFiles = [],
  className = '',
  compact = false,
  changeMode,
}: RepositoryMapProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const moduleChanges = useMemo(
    () => groupChangesByModule(modules, changedFiles),
    [changedFiles, modules],
  );
  const changesByPath = useMemo(
    () => new Map(moduleChanges.map((changes) => [changes.modulePath, changes])),
    [moduleChanges],
  );
  const { nodes, edges } = useMemo(
    () => buildRepositoryGraph(repositoryName, modules, changesByPath),
    [changesByPath, modules, repositoryName],
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const hasChanges = changeMode ?? changedFiles.length > 0;

  return (
    <div className={`overflow-hidden rounded-xl border border-border bg-bg-secondary ${className}`}>
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {hasChanges ? (
              <GitPullRequest size={15} className="text-accent" />
            ) : (
              <Boxes size={15} className="text-accent" />
            )}
            <h4 className="truncate text-sm font-semibold text-text-primary">
              {hasChanges ? 'Change map' : 'Repository map'}
            </h4>
          </div>
          <p className="mt-0.5 text-xs text-text-tertiary">
            {hasChanges
              ? `${changedFiles.length} changed ${changedFiles.length === 1 ? 'file' : 'files'} across ${moduleChanges.length} ${moduleChanges.length === 1 ? 'area' : 'areas'}`
              : `${modules.length} indexed ${modules.length === 1 ? 'area' : 'areas'} · select a node to inspect it`}
          </p>
        </div>
        {hasChanges && <ChangeLegend />}
      </div>

      <div className="relative" style={{ height: compact ? 390 : 520 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: compact ? 0.22 : 0.3 }}
          minZoom={0.3}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          elementsSelectable
          onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={28} size={1} color="var(--color-border-subtle)" />
          {nodes.length > 7 && (
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) =>
                node.data.changes ? 'var(--color-accent)' : 'var(--color-bg-elevated)'
              }
              maskColor="color-mix(in srgb, var(--color-bg-primary) 74%, transparent)"
            />
          )}
          <Controls showInteractive={false} />
        </ReactFlow>

        {selectedNode && selectedNode.data.kind !== 'repository' && (
          <MapInspector data={selectedNode.data} onClose={() => setSelectedNodeId(null)} />
        )}
      </div>
    </div>
  );
}

function RepositoryMapNode({ data, selected }: NodeProps<MapNode>) {
  const changes = data.changes;
  const changeTone = changes ? getChangeTone(changes.counts) : 'border-border';
  const isRepository = data.kind === 'repository';

  return (
    <div
      className={`w-[250px] rounded-xl border bg-bg-elevated transition-[border-color,background-color] duration-200 ${
        selected ? 'border-accent bg-bg-tertiary' : changeTone
      } ${isRepository ? 'border-accent/55' : ''}`}
      aria-label={`${data.label}, ${changes ? `${changes.files.length} changed files` : `${data.fileCount} files`}`}
    >
      {!isRepository && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-bg-primary !bg-info"
        />
      )}
      <div className="flex items-start gap-3 p-3.5">
        <div
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
            isRepository
              ? 'bg-accent/15 text-accent'
              : changes
                ? 'bg-info/12 text-info'
                : 'bg-bg-tertiary text-text-secondary'
          }`}
        >
          {isRepository ? (
            <PackageOpen size={18} />
          ) : data.kind === 'other' ? (
            <FileCode2 size={17} />
          ) : (
            <FolderTree size={17} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-semibold text-text-primary">
            {data.label}
          </div>
          <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-text-tertiary">
            {data.purpose ??
              (isRepository ? 'Indexed repository architecture' : 'Files outside indexed areas')}
          </p>
        </div>
      </div>
      <div className="flex min-h-9 items-center gap-2 border-t border-border-subtle px-3.5 py-2 text-[11px] text-text-tertiary">
        <span>{data.fileCount} files</span>
        {changes && <ChangeBadges changes={changes} />}
      </div>
      {isRepository && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-3 !w-3 !border-bg-primary !bg-accent"
        />
      )}
    </div>
  );
}

function MapInspector({ data, onClose }: { data?: MapNodeData; onClose: () => void }) {
  if (!data) return null;

  return (
    <aside className="absolute bottom-3 right-3 top-3 z-10 w-[310px] overflow-auto rounded-xl border border-border bg-bg-primary p-4 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold text-text-primary">{data.label}</p>
          {data.purpose && (
            <p className="mt-2 text-xs leading-5 text-text-secondary">{data.purpose}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-xs text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
        >
          Close
        </button>
      </div>

      {data.changes && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-text-secondary">Changed files</span>
            <ChangeBadges changes={data.changes} />
          </div>
          <div className="space-y-1">
            {data.changes.files.map((file) => (
              <div
                key={`${file.status}:${file.filePath}`}
                className="flex items-start gap-2 rounded-md bg-bg-secondary px-2.5 py-2"
              >
                <ChangeStatusDot status={file.status} />
                <span className="min-w-0 break-all font-mono text-[11px] leading-4 text-text-secondary">
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
    <div className="hidden items-center gap-3 text-[11px] text-text-tertiary md:flex">
      {(['added', 'modified', 'renamed', 'deleted'] as const).map((status) => (
        <span key={status} className="flex items-center gap-1.5 capitalize">
          <ChangeStatusDot status={status} />
          {status}
        </span>
      ))}
    </div>
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

function ChangeBadges({ changes }: { changes: RepositoryModuleChanges }) {
  return (
    <span className="ml-auto flex items-center gap-1 font-mono text-[10px]">
      {changes.counts.added > 0 && <span className="text-success">+{changes.counts.added}</span>}
      {changes.counts.modified > 0 && <span className="text-info">~{changes.counts.modified}</span>}
      {changes.counts.renamed > 0 && (
        <span className="text-warning">↪{changes.counts.renamed}</span>
      )}
      {changes.counts.deleted > 0 && <span className="text-error">−{changes.counts.deleted}</span>}
    </span>
  );
}

function getChangeTone(counts: Record<RepositoryChangeStatus, number>): string {
  const activeStatuses = Object.values(counts).filter((count) => count > 0).length;
  if (activeStatuses > 1) return 'border-warning/55';
  if (counts.added) return 'border-success/55';
  if (counts.deleted) return 'border-error/55';
  if (counts.renamed) return 'border-warning/55';
  return 'border-info/55';
}

function buildRepositoryGraph(
  repositoryName: string,
  modules: ModuleSummary[],
  changesByPath: Map<string, RepositoryModuleChanges>,
): { nodes: MapNode[]; edges: Edge[] } {
  const changedOtherFiles = changesByPath.get('Other repository files');
  const displayedModules = changedOtherFiles
    ? [
        ...modules,
        {
          path: 'Other repository files',
          purpose: 'Changed files outside the areas captured by the last repository index.',
          fileCount: changedOtherFiles.files.length,
          keyFiles: [],
          dependencies: [],
        },
      ]
    : modules;
  const rowCount = Math.min(ROWS_PER_COLUMN, Math.max(displayedModules.length, 1));
  const rootY = ((rowCount - 1) * (NODE_HEIGHT + NODE_GAP_Y)) / 2;
  const rootId = 'repository-root';

  const nodes: MapNode[] = [
    {
      id: rootId,
      type: 'repositoryMap',
      position: { x: 0, y: rootY },
      data: {
        kind: 'repository',
        label: repositoryName,
        fileCount: modules.reduce((total, module) => total + module.fileCount, 0),
      },
    },
    ...displayedModules.map<MapNode>((module, index) => ({
      id: `module-${index}`,
      type: 'repositoryMap',
      position: {
        x:
          NODE_WIDTH + NODE_GAP_X + Math.floor(index / ROWS_PER_COLUMN) * (NODE_WIDTH + NODE_GAP_X),
        y: (index % ROWS_PER_COLUMN) * (NODE_HEIGHT + NODE_GAP_Y),
      },
      data: {
        kind: module.path === 'Other repository files' ? 'other' : 'module',
        label: module.path === '.' ? 'Repository root' : module.path,
        purpose: module.purpose,
        fileCount: module.fileCount,
        changes: changesByPath.get(module.path),
      },
    })),
  ];

  const edges = displayedModules.map<Edge>((_module, index) => ({
    id: `repo-module-${index}`,
    source: rootId,
    target: `module-${index}`,
    type: 'smoothstep',
    style: {
      stroke: changesByPath.get(displayedModules[index].path)
        ? 'var(--color-accent)'
        : 'var(--color-border)',
      strokeWidth: changesByPath.get(displayedModules[index].path) ? 2 : 1.25,
    },
  }));

  return { nodes, edges };
}

const NODE_TYPES = { repositoryMap: RepositoryMapNode };
