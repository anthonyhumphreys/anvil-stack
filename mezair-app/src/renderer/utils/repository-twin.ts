import type {
  AgentRunSummary,
  GitFileChange,
  GitStatusResult,
  RepositoryMapGraph,
  RepositoryMapGraphNode,
} from '../../shared/types';

export interface RepositoryTwinDistrict {
  node: RepositoryMapGraphNode;
  files: GitFileChange[];
  connectedNodes: RepositoryMapGraphNode[];
}

export interface RepositoryTwinSnapshot {
  branch: string;
  ahead: number;
  behind: number;
  changedFileCount: number;
  districts: RepositoryTwinDistrict[];
  activeRuns: AgentRunSummary[];
  recentRuns: AgentRunSummary[];
}

export function buildRepositoryTwinSnapshot(
  graph: RepositoryMapGraph,
  status: GitStatusResult,
  runs: AgentRunSummary[],
  repoId: string,
): RepositoryTwinSnapshot {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const filesByDistrict = new Map<string, GitFileChange[]>();

  for (const file of status.files) {
    const district = findDistrict(graph.nodes, file.path);
    if (!district) continue;
    filesByDistrict.set(district.id, [...(filesByDistrict.get(district.id) ?? []), file]);
  }

  const districts = [...filesByDistrict.entries()]
    .map<RepositoryTwinDistrict>(([nodeId, files]) => {
      const node = nodesById.get(nodeId)!;
      const connectedNodeIds = new Set(
        graph.edges.flatMap((edge) => {
          if (edge.kind !== 'dependency') return [];
          if (edge.source === nodeId) return [edge.target];
          if (edge.target === nodeId) return [edge.source];
          return [];
        }),
      );
      return {
        node,
        files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
        connectedNodes: [...connectedNodeIds]
          .map((id) => nodesById.get(id))
          .filter((candidate): candidate is RepositoryMapGraphNode => Boolean(candidate)),
      };
    })
    .toSorted((left, right) => right.files.length - left.files.length);

  const repositoryRuns = runs.filter((run) => run.repoIds.includes(repoId));
  return {
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    changedFileCount: status.files.length,
    districts,
    activeRuns: repositoryRuns.filter((run) => run.status === 'running' || run.status === 'queued'),
    recentRuns: repositoryRuns.slice(0, 8),
  };
}

function findDistrict(
  nodes: RepositoryMapGraphNode[],
  filePath: string,
): RepositoryMapGraphNode | undefined {
  const candidates = nodes.filter(
    (node) =>
      (node.kind === 'module' || node.kind === 'directory') && pathContains(node.path, filePath),
  );
  return (
    candidates.toSorted((left, right) => right.path.length - left.path.length)[0] ??
    nodes.find((node) => node.kind === 'repository')
  );
}

function pathContains(parentPath: string, filePath: string): boolean {
  const normalizedParent = parentPath.replace(/^\.\/?|\/$/g, '');
  if (!normalizedParent) return true;
  return filePath === normalizedParent || filePath.startsWith(`${normalizedParent}/`);
}
