// Layered left-to-right DAG layout for pipeline graphs. Pure and dependency
// free so main (static share SVG) and renderer (inline/stage graph) agree.
//
// 1. Break cycles (DFS back edges are kept but marked `back`).
// 2. Longest-path layering from sources.
// 3. Barycentre ordering sweeps to reduce crossings.
// 4. Fixed-size boxes; layers are vertically centred against the tallest one.

export interface LayoutInputNode {
  id: string;
}

export interface LayoutInputEdge {
  from: string;
  to: string;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
  /** Barycentre sweeps (down + up counts as two). */
  sweeps?: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  order: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** Start and end anchor points (right-middle of source, left-middle of target). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Edge that closes a cycle (drawn against the flow). */
  back: boolean;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  layers: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 168,
  nodeHeight: 44,
  gapX: 48,
  gapY: 14,
  padding: 8,
  sweeps: 4,
};

export function layoutDag(
  inputNodes: readonly LayoutInputNode[],
  inputEdges: readonly LayoutInputEdge[],
  options: LayoutOptions = {},
): GraphLayout {
  const opts = { ...DEFAULTS, ...options };
  const ids: string[] = [];
  const index = new Map<string, number>();
  for (const node of inputNodes) {
    if (index.has(node.id)) continue;
    index.set(node.id, ids.length);
    ids.push(node.id);
  }
  const n = ids.length;
  if (n === 0) {
    return { nodes: [], edges: [], width: opts.padding * 2, height: opts.padding * 2, layers: 0 };
  }

  // Unique, resolvable, non-self edges.
  const seen = new Set<string>();
  const edges: Array<{ from: number; to: number; source: LayoutInputEdge }> = [];
  for (const edge of inputEdges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, source: edge });
  }

  // 1. Cycle breaking via iterative DFS.
  const out: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((edge, edgeIndex) => out[edge.from].push(edgeIndex));
  const back = new Set<number>();
  const state = new Uint8Array(n); // 0 unvisited, 1 on stack, 2 done
  for (let root = 0; root < n; root += 1) {
    if (state[root] !== 0) continue;
    const stack: Array<{ node: number; next: number }> = [{ node: root, next: 0 }];
    state[root] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= out[frame.node].length) {
        state[frame.node] = 2;
        stack.pop();
        continue;
      }
      const edgeIndex = out[frame.node][frame.next];
      frame.next += 1;
      const target = edges[edgeIndex].to;
      if (state[target] === 1) back.add(edgeIndex);
      else if (state[target] === 0) {
        state[target] = 1;
        stack.push({ node: target, next: 0 });
      }
    }
  }

  // 2. Longest-path layering over forward edges (Kahn).
  const forwardOut: number[][] = Array.from({ length: n }, () => []);
  const forwardIn: number[][] = Array.from({ length: n }, () => []);
  const indegree = new Int32Array(n);
  edges.forEach((edge, edgeIndex) => {
    if (back.has(edgeIndex)) return;
    forwardOut[edge.from].push(edge.to);
    forwardIn[edge.to].push(edge.from);
    indegree[edge.to] += 1;
  });
  const layer = new Int32Array(n);
  const queue: number[] = [];
  for (let node = 0; node < n; node += 1) if (indegree[node] === 0) queue.push(node);
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const target of forwardOut[node]) {
      layer[target] = Math.max(layer[target], layer[node] + 1);
      indegree[target] -= 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  const layerCount = Math.max(...layer) + 1;

  // 3. Ordering: start from input order, then barycentre sweeps.
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  for (let node = 0; node < n; node += 1) layers[layer[node]].push(node);
  const position = new Float64Array(n);
  const refreshPositions = () =>
    layers.forEach((nodes) => nodes.forEach((node, order) => (position[node] = order)));
  refreshPositions();
  const reorder = (nodes: number[], neighbours: number[][]) => {
    const keyed = nodes.map((node) => {
      const adjacent = neighbours[node];
      const bary =
        adjacent.length > 0
          ? adjacent.reduce((sum, other) => sum + position[other], 0) / adjacent.length
          : position[node];
      return { node, bary, order: position[node] };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.order - b.order);
    keyed.forEach((entry, order) => {
      nodes[order] = entry.node;
      position[entry.node] = order;
    });
  };
  for (let sweep = 0; sweep < opts.sweeps; sweep += 1) {
    if (sweep % 2 === 0) {
      for (let current = 1; current < layerCount; current += 1) reorder(layers[current], forwardIn);
    } else {
      for (let current = layerCount - 2; current >= 0; current -= 1) {
        reorder(layers[current], forwardOut);
      }
    }
  }

  // 4. Coordinates.
  const maxCount = Math.max(...layers.map((nodes) => nodes.length));
  const rowStep = opts.nodeHeight + opts.gapY;
  const colStep = opts.nodeWidth + opts.gapX;
  const totalHeight = maxCount * opts.nodeHeight + (maxCount - 1) * opts.gapY;
  const placed: LayoutNode[] = new Array(n);
  layers.forEach((nodes, layerIndex) => {
    const columnHeight = nodes.length * opts.nodeHeight + (nodes.length - 1) * opts.gapY;
    const offset = (totalHeight - columnHeight) / 2;
    nodes.forEach((node, order) => {
      placed[node] = {
        id: ids[node],
        x: opts.padding + layerIndex * colStep,
        y: opts.padding + offset + order * rowStep,
        width: opts.nodeWidth,
        height: opts.nodeHeight,
        layer: layerIndex,
        order,
      };
    });
  });

  const laidEdges: LayoutEdge[] = edges.map((edge, edgeIndex) => {
    const source = placed[edge.from];
    const target = placed[edge.to];
    return {
      from: ids[edge.from],
      to: ids[edge.to],
      x1: source.x + source.width,
      y1: source.y + source.height / 2,
      x2: target.x,
      y2: target.y + target.height / 2,
      back: back.has(edgeIndex),
    };
  });

  return {
    nodes: placed,
    edges: laidEdges,
    width: opts.padding * 2 + layerCount * opts.nodeWidth + (layerCount - 1) * opts.gapX,
    height: opts.padding * 2 + totalHeight,
    layers: layerCount,
  };
}

/** Smooth cubic path between edge anchors; back edges loop under the boxes. */
export function edgePath(edge: LayoutEdge, nodeHeight = DEFAULTS.nodeHeight): string {
  const { x1, y1, x2, y2 } = edge;
  if (edge.back || x2 <= x1) {
    const drop = Math.max(y1, y2) + nodeHeight / 2 + 12;
    return `M${round(x1)},${round(y1)} C${round(x1 + 24)},${round(drop)} ${round(x2 - 24)},${round(drop)} ${round(x2)},${round(y2)}`;
  }
  const dx = Math.max(16, (x2 - x1) / 2);
  return `M${round(x1)},${round(y1)} C${round(x1 + dx)},${round(y1)} ${round(x2 - dx)},${round(y2)} ${round(x2)},${round(y2)}`;
}

/** Count edges whose segments cross between adjacent layers (layout quality metric). */
export function countCrossings(layout: GraphLayout): number {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const segments = layout.edges
    .filter((edge) => !edge.back)
    .map((edge) => ({ a: byId.get(edge.from)!, b: byId.get(edge.to)! }))
    .filter((segment) => segment.b.layer === segment.a.layer + 1);
  let crossings = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s = segments[i];
      const t = segments[j];
      if (s.a.layer !== t.a.layer) continue;
      if ((s.a.order - t.a.order) * (s.b.order - t.b.order) < 0) crossings += 1;
    }
  }
  return crossings;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
