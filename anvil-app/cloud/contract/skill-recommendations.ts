/** A curated collection is an explicitly chosen repository, never an owner-wide search. */
export interface SkillRecommendationSource {
  id: string;
  name: string;
  description: string;
  repository: string;
  /** Restrict discovery and installation to this repository directory. */
  path?: string;
  /** Branch, tag or commit. Omit to follow the repository's default branch. */
  ref?: string;
  /** Omit to recommend the whole collection; otherwise use exact SKILL.md names. */
  skills?: string[];
}

export interface OrganizationSkillRecommendations {
  organizationId: string;
  name: string;
  canEdit: boolean;
  version: number;
  sources: SkillRecommendationSource[];
}

export const SKILL_RECOMMENDATIONS_FEATURE = 'organization-skill-recommendations/1';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shared by the code catalogue, Desktop IPC and the server write boundary. */
export function parseSkillRecommendationSources(value: unknown): SkillRecommendationSource[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('Choose at most 20 skill collections.');
  }
  const ids = new Set<string>();
  return value.map((source): SkillRecommendationSource => {
    if (
      !record(source) ||
      typeof source.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(source.id) ||
      ids.has(source.id)
    ) {
      throw new Error('Each collection needs a unique lowercase id.');
    }
    ids.add(source.id);
    if (typeof source.name !== 'string' || !source.name.trim() || source.name.length > 100) {
      throw new Error('Each collection needs a name of up to 100 characters.');
    }
    if (typeof source.description !== 'string' || source.description.length > 600) {
      throw new Error('Collection descriptions must be at most 600 characters.');
    }
    if (typeof source.repository !== 'string') throw new Error('Choose a GitHub repository.');
    const repository = source.repository
      .replace(/^https:\/\/github\.com\//i, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) {
      throw new Error('Repositories must be owner/repo or https://github.com/owner/repo.');
    }
    if (
      source.path !== undefined &&
      (typeof source.path !== 'string' ||
        source.path.length > 160 ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(source.path) ||
        source.path.split('/').some((part) => part === '.' || part === '..'))
    ) {
      throw new Error('Choose a repository directory without leading slashes or parent traversal.');
    }
    if (
      source.ref !== undefined &&
      (typeof source.ref !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(source.ref) ||
        source.ref.split('/').some((part) => !part || part === '.' || part === '..'))
    ) {
      throw new Error('Choose a valid branch, tag or commit.');
    }
    if (
      source.skills !== undefined &&
      (!Array.isArray(source.skills) ||
        !source.skills.length ||
        source.skills.length > 100 ||
        !source.skills.every(
          (name) => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(name),
        ) ||
        new Set(source.skills).size !== source.skills.length)
    ) {
      throw new Error(
        'Select up to 100 unique skill names, or omit skills for the whole collection.',
      );
    }
    return {
      id: source.id,
      name: source.name.trim(),
      description: source.description.trim(),
      repository,
      ...(source.path === undefined ? {} : { path: source.path as string }),
      ...(source.ref === undefined ? {} : { ref: source.ref as string }),
      ...(source.skills === undefined ? {} : { skills: [...source.skills] as string[] }),
    };
  });
}
