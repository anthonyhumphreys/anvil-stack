import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  parseSkillRecommendationSources,
  SKILL_RECOMMENDATIONS_FEATURE,
} from '../../../cloud/contract/skill-recommendations.js';
import type {
  OrganizationSkillRecommendations,
  SaveSkillRecommendationsInput,
  SkillCollectionInspection,
  SkillRecommendationCatalog,
  SkillRecommendationSelection,
  SkillRecommendationSource,
} from '../../shared/skill-recommendations.js';
import { RECOMMENDED_SKILL_SOURCES } from '../../shared/config/skill-recommendations.js';
import { rpc } from './sync-backend-client.service.js';
import { installCodexSkill } from './codex-registry.service.js';

interface RecommendationContext {
  scopeKey: string;
  apiUrl: string;
  accessToken: string;
  features: string[];
}
let contextProvider: () => RecommendationContext | null = () => null;
export function configureSkillRecommendationsContext(provider: typeof contextProvider): void {
  contextProvider = provider;
}

const exec = promisify(execFile);
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SKILLS = 200;
const cache = new Map<string, { at: number; inspection: SkillCollectionInspection }>();
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertScope(scopeKey: string | null): void {
  if ((contextProvider()?.scopeKey ?? null) !== scopeKey) {
    throw new Error('Your account changed. Refresh the recommended collections and try again.');
  }
}

async function organizationRpc<T>(
  operation: string,
  params: unknown,
  scopeKey: string,
): Promise<T> {
  assertScope(scopeKey);
  const context = contextProvider();
  if (!context?.features.includes(SKILL_RECOMMENDATIONS_FEATURE)) {
    throw new Error('This backend does not support organisation skill recommendations yet.');
  }
  const { result } = await rpc<T>(
    { apiUrl: context.apiUrl },
    operation,
    params,
    context.accessToken,
  );
  assertScope(scopeKey);
  return result;
}

export async function getSkillRecommendationCatalog(): Promise<SkillRecommendationCatalog> {
  const context = contextProvider();
  const catalog: SkillRecommendationCatalog = {
    scopeKey: context?.scopeKey ?? null,
    sources: parseSkillRecommendationSources(RECOMMENDED_SKILL_SOURCES),
    organizations: [],
  };
  if (!context) return catalog;
  try {
    const result = await organizationRpc<{ organizations: OrganizationSkillRecommendations[] }>(
      'skills.recommendations.list',
      {},
      context.scopeKey,
    );
    if (!Array.isArray(result.organizations) || result.organizations.length > 100) {
      throw new Error('The backend returned an invalid organisation catalogue.');
    }
    catalog.organizations = result.organizations.map((org) => {
      if (
        !record(org) ||
        typeof org.organizationId !== 'string' ||
        typeof org.name !== 'string' ||
        typeof org.canEdit !== 'boolean' ||
        !Number.isSafeInteger(org.version) ||
        org.version < 0
      ) {
        throw new Error('The backend returned an invalid organisation catalogue.');
      }
      return { ...org, sources: parseSkillRecommendationSources(org.sources) };
    });
  } catch (error) {
    assertScope(catalog.scopeKey);
    catalog.warning =
      error instanceof Error ? error.message : 'Could not load organisation collections.';
  }
  return catalog;
}

export async function saveOrganizationSkillRecommendations(
  input: SaveSkillRecommendationsInput,
): Promise<void> {
  if (
    !input ||
    typeof input.scopeKey !== 'string' ||
    typeof input.organizationId !== 'string' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new Error('Invalid organisation recommendation update.');
  }
  await organizationRpc(
    'skills.recommendations.set',
    {
      organizationId: input.organizationId,
      expectedVersion: input.expectedVersion,
      sources: parseSkillRecommendationSources(input.sources),
    },
    input.scopeKey,
  );
}

async function selectedSource(
  input: SkillRecommendationSelection,
): Promise<SkillRecommendationSource> {
  if (
    !input ||
    typeof input.sourceId !== 'string' ||
    (input.scopeKey !== null && typeof input.scopeKey !== 'string') ||
    (input.organizationId !== undefined && typeof input.organizationId !== 'string')
  ) {
    throw new Error('Choose a recommended collection.');
  }
  assertScope(input.scopeKey);
  // Never trust renderer-supplied repository URLs or a cached org membership.
  const catalog = await getSkillRecommendationCatalog();
  assertScope(input.scopeKey);
  const sources =
    input.organizationId === undefined
      ? catalog.sources
      : catalog.organizations.find((org) => org.organizationId === input.organizationId)?.sources;
  const source = sources?.find((item) => item.id === input.sourceId);
  if (!source) throw new Error('This collection is no longer available. Refresh and try again.');
  return source;
}

/** Bounded read, including servers without Content-Length. */
async function readGithubResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_BYTES)
    throw new Error('Repository response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BYTES) throw new Error('Repository response is too large.');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function github(path: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Mezair-skills' },
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  if (response.ok) return readGithubResponse(response);
  if (![401, 403, 404, 429].includes(response.status)) {
    throw new Error(`GitHub could not load this collection (${response.status}). Try again.`);
  }
  // gh applies its own authentication for private repos, without exposing a token.
  try {
    const { stdout } = await exec('gh', ['api', '--hostname', 'github.com', path], {
      timeout: 12_000,
      maxBuffer: MAX_BYTES,
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      'GitHub could not load this collection. Check repository access or sign in with gh auth login, then try again.',
    );
  }
}

async function inspectSource(
  source: SkillRecommendationSource,
  scopeKey: string | null,
): Promise<SkillCollectionInspection> {
  const key = JSON.stringify([scopeKey, source]);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.inspection;
  const base = `repos/${source.repository}`;
  const commit = await github(`${base}/commits/${encodeURIComponent(source.ref ?? 'HEAD')}`);
  if (!record(commit) || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/.test(commit.sha)) {
    throw new Error('GitHub returned an invalid collection revision.');
  }
  const sha = commit.sha;
  const tree = await github(`${base}/git/trees/${sha}?recursive=1`);
  if (!record(tree) || !Array.isArray(tree.tree) || tree.truncated === true) {
    throw new Error(
      'This repository is too large to inspect completely. Use a dedicated skills repository.',
    );
  }
  const files = tree.tree.filter(
    (file): file is { path: string; sha: string } =>
      record(file) &&
      file.type === 'blob' &&
      file.mode !== '120000' &&
      typeof file.path === 'string' &&
      /(^|\/)SKILL\.md$/.test(file.path) &&
      (!source.path || file.path.startsWith(`${source.path}/`)) &&
      !file.path.split('/').some((part) => ['node_modules', '.git', 'vendor'].includes(part)) &&
      typeof file.sha === 'string' &&
      /^[a-f0-9]{40}$/.test(file.sha),
  );
  if (files.length > MAX_SKILLS)
    throw new Error(`Collections can contain at most ${MAX_SKILLS} skills.`);
  const skills: SkillCollectionInspection['skills'] = [];
  let next = 0;
  // Repository metadata is untrusted content. Read frontmatter, never execute it.
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++];
        const blob = await github(`${base}/git/blobs/${file.sha}`);
        if (
          !record(blob) ||
          typeof blob.content !== 'string' ||
          blob.encoding !== 'base64' ||
          typeof blob.size !== 'number' ||
          blob.size > 128 * 1024
        ) {
          throw new Error(`Could not read skill metadata from ${file.path}.`);
        }
        const content = Buffer.from(blob.content, 'base64').toString('utf8');
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
        if (!frontmatter) continue;
        const metadata: unknown = parseYaml(frontmatter, { maxAliasCount: 10 });
        if (
          !record(metadata) ||
          typeof metadata.name !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(metadata.name) ||
          typeof metadata.description !== 'string' ||
          !metadata.description.trim()
        ) {
          throw new Error(`Invalid skill metadata in ${file.path}.`);
        }
        if (source.skills && !source.skills.includes(metadata.name)) continue;
        skills.push({
          name: metadata.name,
          description: metadata.description.slice(0, 1000),
          url: `https://github.com/${source.repository}/blob/${sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
        });
      }
    }),
  );
  if (source.skills?.some((name) => !skills.some((skill) => skill.name === name))) {
    throw new Error(
      'Some selected skills were not found in this collection. Check the collection configuration.',
    );
  }
  if (!skills.length) throw new Error('No installable skills were found in this collection.');
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
    throw new Error(
      'This collection contains duplicate skill names. Choose a repository with unique names.',
    );
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  const inspection = { commit: sha, skills };
  if (cache.size >= 20) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), inspection });
  return inspection;
}

export async function inspectRecommendedSkillCollection(
  input: SkillRecommendationSelection,
): Promise<SkillCollectionInspection> {
  const source = await selectedSource(input);
  const inspection = await inspectSource(source, input.scopeKey);
  assertScope(input.scopeKey);
  return inspection;
}

export async function installRecommendedSkillCollection(
  input: SkillRecommendationSelection & { skillName?: string },
) {
  const source = await selectedSource(input);
  const inspection = await inspectSource(source, input.scopeKey);
  if (
    input.skillName !== undefined &&
    !inspection.skills.some((skill) => skill.name === input.skillName)
  ) {
    throw new Error('That skill is not part of this recommended collection.');
  }
  if (input.organizationId !== undefined) {
    const current = await selectedSource(input);
    if (JSON.stringify(current) !== JSON.stringify(source)) {
      throw new Error('This collection changed. Refresh and try again.');
    }
  }
  assertScope(input.scopeKey);
  return installCodexSkill({
    // Resolve once to an immutable commit; a moving branch cannot change mid-install.
    source: `https://github.com/${source.repository}/tree/${inspection.commit}${source.path ? `/${source.path}` : ''}`,
    skillNames: input.skillName ? [input.skillName] : inspection.skills.map((skill) => skill.name),
    global: true,
  });
}
