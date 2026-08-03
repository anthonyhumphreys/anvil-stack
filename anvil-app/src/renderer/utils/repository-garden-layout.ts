import type { RepositoryMapGraph, RepositoryMapGraphNode } from '../../shared/types';

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
  plots: GardenPlot[];
  paths: GardenPath[];
  extent: number;
  spawn: [number, number];
}

export function buildRepositoryGardenLayout(graph: RepositoryMapGraph): RepositoryGardenLayout {
  const modules = graph.nodes
    .filter((node) => node.kind === 'module')
    .toSorted((a, b) => a.path.localeCompare(b.path));
  const columns = Math.max(1, Math.ceil(Math.sqrt(modules.length)));
  const spacing = 9;
  const rows = Math.max(1, Math.ceil(modules.length / columns));
  const plots = modules.map<GardenPlot>((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const seed = hashString(node.path);
    return {
      node,
      x: (column - (columns - 1) / 2) * spacing,
      z: (row - (rows - 1) / 2) * spacing,
      width: 3.4 + (seed % 3) * 0.45,
      depth: 3.2 + ((seed >> 3) % 3) * 0.45,
      height: 2.6 + Math.min(3.4, Math.log2(Math.max(1, node.fileCount ?? 1)) * 0.72),
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
  const extent = Math.max(columns, rows) * spacing * 0.65 + 7;

  return {
    plots,
    paths,
    extent,
    spawn: [0, rows * spacing * 0.5 + 3.5],
  };
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
