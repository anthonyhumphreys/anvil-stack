import type { RepositoryMapGraph, RepositoryMapGraphNode } from '../../shared/types';

export const GARDEN_PAGE_SIZE = 24;

export interface GardenPlot {
  node: RepositoryMapGraphNode;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  seed: number;
}

export interface GardenPath {
  id: string;
  sourceId: string;
  targetId: string;
  source: [number, number];
  target: [number, number];
  count: number;
}

export interface RepositoryGardenLayout {
  scopeNode: RepositoryMapGraphNode;
  plots: GardenPlot[];
  paths: GardenPath[];
  extent: number;
  spawn: [number, number];
  totalChildren: number;
  offset: number;
  limit: number;
}

interface GardenLayoutOptions {
  scopeId?: string;
  offset?: number;
  limit?: number;
}

export function buildRepositoryGardenLayout(
  graph: RepositoryMapGraph,
  options: GardenLayoutOptions = {},
): RepositoryGardenLayout {
  const root = graph.nodes.find((node) => node.kind === 'repository') ?? graph.nodes[0];
  if (!root) throw new Error('Repository graph has no nodes.');
  const scopeNode = graph.nodes.find((node) => node.id === options.scopeId) ?? root;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? GARDEN_PAGE_SIZE);
  const allChildren = graph.nodes
    .filter((node) => node.parentId === scopeNode.id)
    .toSorted(compareGardenNodes);
  const visibleChildren = allChildren.slice(offset, offset + limit);
  const spacing = spacingForScope(scopeNode, visibleChildren);
  const columns = Math.max(1, Math.ceil(Math.sqrt(visibleChildren.length)));
  const rows = Math.max(1, Math.ceil(visibleChildren.length / columns));
  const plots = visibleChildren.map<GardenPlot>((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const seed = hashString(`${scopeNode.id}:${node.id}`);
    const dimensions = dimensionsForNode(node, seed);
    return {
      node,
      x: (column - (columns - 1) / 2) * spacing,
      z: (row - (rows - 1) / 2) * spacing,
      ...dimensions,
      seed,
    };
  });
  const plotsById = new Map(plots.map((plot) => [plot.node.id, plot]));
  const paths = graph.edges
    .filter((edge) => edge.kind === 'dependency')
    .flatMap<GardenPath>((edge) => {
      const source = plotsById.get(edge.source);
      const target = plotsById.get(edge.target);
      if (!source || !target) return [];
      return [
        {
          id: edge.id,
          sourceId: edge.source,
          targetId: edge.target,
          source: [source.x, source.z],
          target: [target.x, target.z],
          count: edge.count ?? 1,
        },
      ];
    });
  const extent = Math.max(columns, rows) * spacing * 0.62 + 7;

  return {
    scopeNode,
    plots,
    paths,
    extent,
    spawn: [0, rows * spacing * 0.5 + 3.5],
    totalChildren: allChildren.length,
    offset,
    limit,
  };
}

function compareGardenNodes(a: RepositoryMapGraphNode, b: RepositoryMapGraphNode): number {
  const order = { module: 0, directory: 1, file: 2, symbol: 3, repository: 4 };
  return order[a.kind] - order[b.kind] || a.name.localeCompare(b.name);
}

function spacingForScope(
  scope: RepositoryMapGraphNode,
  children: RepositoryMapGraphNode[],
): number {
  if (scope.kind === 'repository' || children.some((node) => node.kind === 'module')) return 11;
  if (children.some((node) => node.kind === 'directory')) return 9;
  if (children.some((node) => node.kind === 'file')) return 7.5;
  return 6.5;
}

function dimensionsForNode(node: RepositoryMapGraphNode, seed: number) {
  if (node.kind === 'module') {
    return {
      width: 4.6 + (seed % 3) * 0.35,
      depth: 4.1 + ((seed >>> 3) % 3) * 0.35,
      height: 2.8 + Math.min(3.2, Math.log2(Math.max(1, node.fileCount ?? 1)) * 0.68),
    };
  }
  if (node.kind === 'directory') {
    return { width: 4.3, depth: 3.9, height: 1.9 };
  }
  if (node.kind === 'file') {
    return { width: 3.4, depth: 2.7, height: 1.25 };
  }
  return { width: 2.5, depth: 2.3, height: 1.85 };
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
