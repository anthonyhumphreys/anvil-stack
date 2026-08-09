import Dagre from '@dagrejs/dagre';
import type {
  PullRequestVisualisationEdge,
  PullRequestVisualisationNode,
} from '../../shared/types';

export const PULL_REQUEST_NODE_WIDTH = 240;
export const PULL_REQUEST_NODE_HEIGHT = 80;

export interface PullRequestNodePosition {
  x: number;
  y: number;
}

/**
 * Produces a stable left-to-right systems map from the chapter's complete node set.
 * Callers can hide Before/After nodes without recalculating these coordinates, which
 * preserves the reviewer's mental map while comparing states.
 */
export function layoutPullRequestNodes(
  nodes: PullRequestVisualisationNode[],
  edges: PullRequestVisualisationEdge[],
): Map<string, PullRequestNodePosition> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const graph = new Dagre.graphlib.Graph({ multigraph: true })
    .setDefaultEdgeLabel(() => ({}))
    .setGraph({
      rankdir: 'LR',
      ranker: 'network-simplex',
      acyclicer: 'greedy',
      ranksep: 192,
      nodesep: 48,
      edgesep: 24,
      marginx: 32,
      marginy: 32,
    });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: PULL_REQUEST_NODE_WIDTH,
      height: PULL_REQUEST_NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    if (edge.source === edge.target || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      continue;
    }
    graph.setEdge(edge.source, edge.target, {}, edge.id);
  }

  Dagre.layout(graph);

  return new Map(
    nodes.map((node) => {
      const position = graph.node(node.id) as { x: number; y: number };
      return [
        node.id,
        {
          x: position.x - PULL_REQUEST_NODE_WIDTH / 2,
          y: position.y - PULL_REQUEST_NODE_HEIGHT / 2,
        },
      ];
    }),
  );
}

export function isRenderablePullRequestEdge(
  edge: Pick<PullRequestVisualisationEdge, 'source' | 'target'>,
  nodeIds: ReadonlySet<string>,
): boolean {
  return edge.source !== edge.target && nodeIds.has(edge.source) && nodeIds.has(edge.target);
}
