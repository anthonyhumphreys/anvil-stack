import type { FactoryDefinition } from '../../shared/factories.js';

export interface ScopedRepositorySource {
  id: string;
  remoteUrl: string;
}

function parseGitHubSource(
  remoteUrl: string,
): { host: string; owner: string; repo: string } | null {
  const value = remoteUrl.trim().replace(/\.git$/i, '');
  const match =
    value.match(/^(?:https?:\/\/|ssh:\/\/git@)([^/:]+)[/:]([^/]+)\/([^/#]+)$/i) ??
    value.match(/^git@([^:]+):([^/]+)\/([^/#]+)$/i);
  if (!match || !match[2] || !match[3]) return null;
  return {
    host: match[1].toLowerCase(),
    owner: match[2].toLowerCase(),
    repo: match[3].toLowerCase(),
  };
}

/** Local factories use workspace/repo IDs; remote org factories use canonical GitHub identity. */
export function factoryWithinSessionScope(
  factory: FactoryDefinition,
  workspaceId: string,
  repositories: readonly ScopedRepositorySource[],
): boolean {
  if (!factory.remote) {
    return (
      factory.workspaceId === workspaceId &&
      repositories.some((repo) => repo.id === factory.definition.repoId)
    );
  }
  if (factory.definition.access.kind !== 'organization' || factory.sourceAccess !== true)
    return false;
  const wanted = factory.definition.github;
  return repositories.some((repository) => {
    const source = parseGitHubSource(repository.remoteUrl);
    return (
      source?.host === wanted.host.toLowerCase() &&
      source.owner === wanted.owner.toLowerCase() &&
      source.repo === wanted.repo.toLowerCase()
    );
  });
}
