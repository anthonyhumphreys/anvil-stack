import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type {
  CodexMcpRegisterInput,
  CodexMcpServer,
  CodexRegisteredSkill,
  CodexRegistryActionResult,
  CodexRegistryCliStatus,
  CodexRegistrySnapshot,
  CodexSkillInstallInput,
  CodexSkillScope,
  CodexSkillSearchResult,
} from '../../shared/types.js';

const execFileAsync = promisify(execFile);

const SKILLS_SH_API_BASE_URL = 'https://skills.sh';
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SKILL_FILES = 500;
const MAX_OUTPUT_BUFFER = 1024 * 1024 * 4;
const DEFAULT_SEARCH_LIMIT = 40;

let skillsCache: {
  loadedAt: number;
  query: string;
  items: CodexSkillSearchResult[];
} | null = null;

export async function getCodexRegistrySnapshot(): Promise<CodexRegistrySnapshot> {
  const cli = await detectCodexRegistryCli();

  const [skillResult, mcpResult] = await Promise.all([
    discoverRegisteredSkills(cli.codexHome),
    listCodexMcpServers(),
  ]);

  return {
    cli,
    skills: skillResult.skills,
    mcpServers: mcpResult.servers,
    scannedSkillRoots: skillResult.roots,
    warnings: [...skillResult.warnings, ...mcpResult.warnings],
    refreshedAt: new Date().toISOString(),
  };
}

export async function searchSkillsShRegistry(query: string): Promise<CodexSkillSearchResult[]> {
  const items = await getSkillsShCatalog(query);
  const trimmedQuery = query.trim();
  const results = trimmedQuery ? items : filterSkillSearchResults(items, query);
  return results.slice(0, DEFAULT_SEARCH_LIMIT);
}

export async function installCodexSkill(
  input: CodexSkillInstallInput,
): Promise<CodexRegistryActionResult> {
  const args = buildSkillCliArgs(input);
  const command = formatCommand(['npx', ...args]);

  try {
    const { stdout, stderr } = await execFileAsync('npx', args, {
      timeout: 180_000,
      maxBuffer: MAX_OUTPUT_BUFFER,
      env: {
        ...process.env,
        DISABLE_TELEMETRY: '1',
        HOMEBREW_NO_AUTO_UPDATE: '1',
      },
    });

    return {
      success: true,
      command,
      output: joinOutput(stdout, stderr),
    };
  } catch (err) {
    return {
      success: false,
      command,
      output: getExecOutput(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerCodexMcp(
  input: CodexMcpRegisterInput,
): Promise<CodexRegistryActionResult> {
  const args = buildMcpRegisterArgs(input);
  const command = formatCommand(['codex', ...args]);

  try {
    const { stdout, stderr } = await execFileAsync('codex', args, {
      timeout: 30_000,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });

    return {
      success: true,
      command,
      output: joinOutput(stdout, stderr),
    };
  } catch (err) {
    return {
      success: false,
      command,
      output: getExecOutput(err),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function detectCodexRegistryCli(): Promise<CodexRegistryCliStatus> {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const configPaths = [
    join(codexHome, 'config.toml'),
    join(codexHome, 'config.json'),
    join(homedir(), '.config', 'codex', 'config.toml'),
    join(homedir(), '.config', 'codex', 'config.json'),
  ].filter((path) => existsSync(path));

  const base: CodexRegistryCliStatus = {
    installed: false,
    codexHome,
    configPaths,
    authConfigured: existsSync(join(codexHome, 'auth.json')),
  };

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(whichCmd, ['codex'], { timeout: 5_000 });
    const codexPath = String(stdout).trim().split(/\r?\n/)[0];

    let version: string | undefined;
    try {
      const versionResult = await execFileAsync('codex', ['--version'], { timeout: 5_000 });
      version = String(versionResult.stdout).trim() || undefined;
    } catch {
      version = undefined;
    }

    return {
      ...base,
      installed: true,
      path: codexPath,
      version,
    };
  } catch {
    return base;
  }
}

function discoverRegisteredSkills(codexHome: string): {
  skills: CodexRegisteredSkill[];
  roots: string[];
  warnings: string[];
} {
  const cwd = process.cwd();
  const rootCandidates = [
    { path: join(codexHome, 'skills'), maxDepth: 5 },
    { path: join(homedir(), '.agents', 'skills'), maxDepth: 5 },
    { path: join(cwd, '.agents', 'skills'), maxDepth: 5 },
    { path: join(cwd, '.codex', 'skills'), maxDepth: 5 },
    { path: join(codexHome, 'plugins', 'cache'), maxDepth: 8 },
  ];

  const roots = dedupePaths(rootCandidates.filter((root) => existsSync(root.path)));
  const warnings: string[] = [];
  const skills: CodexRegisteredSkill[] = [];
  const seenFiles = new Set<string>();

  for (const root of roots) {
    try {
      const files = findSkillFiles(root.path, root.maxDepth, MAX_SKILL_FILES - skills.length);
      for (const file of files) {
        if (seenFiles.has(file)) continue;
        seenFiles.add(file);
        skills.push(readRegisteredSkill(file, root.path, codexHome));
        if (skills.length >= MAX_SKILL_FILES) {
          warnings.push(`Stopped after ${MAX_SKILL_FILES} skill files to keep the scan bounded.`);
          break;
        }
      }
    } catch (err) {
      warnings.push(
        `Could not scan ${root.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  skills.sort((a, b) => {
    const byScope = a.scope.localeCompare(b.scope);
    if (byScope !== 0) return byScope;
    return a.name.localeCompare(b.name);
  });

  return {
    skills,
    roots: roots.map((root) => root.path),
    warnings,
  };
}

function findSkillFiles(root: string, maxDepth: number, limit: number): string[] {
  const files: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const skillFile = entries.find((entry) => /^skill\.md$/i.test(entry.name));
    if (skillFile) {
      files.push(join(current.dir, skillFile.name));
      continue;
    }

    for (const entry of entries.reverse()) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipSkillDirectory(entry.name, current.dir, root)) continue;
      stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return files;
}

function shouldSkipSkillDirectory(name: string, dir: string, root: string): boolean {
  const noisy = new Set([
    '.git',
    '.tmp',
    'node_modules',
    'out',
    'dist',
    'build',
    'coverage',
    '.cache',
  ]);
  if (noisy.has(name)) return true;
  if (name.startsWith('.') && name !== '.system' && dir !== root) return true;
  return false;
}

function readRegisteredSkill(file: string, root: string, codexHome: string): CodexRegisteredSkill {
  const content = readFileSync(file, 'utf-8');
  const metadata = parseMarkdownMetadata(content);
  const directory = dirname(file);
  const scope = inferSkillScope(file, root, codexHome);
  const name = metadata.name || basename(directory);
  const description = metadata.description || readFirstParagraph(content);
  const stat = statSync(file);

  return {
    id: `${scope}:${relative(root, directory) || basename(directory)}`,
    name,
    description,
    path: file,
    directory,
    scope,
    source: metadata.source || metadata.repository || metadata.url,
    tags: parseTags(metadata.tags),
    updatedAt: stat.mtime.toISOString(),
  };
}

function inferSkillScope(file: string, root: string, codexHome: string): CodexSkillScope {
  const normalised = file.split('\\').join('/');
  const normalisedRoot = root.split('\\').join('/');
  const normalisedCodexHome = codexHome.split('\\').join('/');

  if (normalised.startsWith(`${normalisedCodexHome}/plugins/cache/`)) return 'plugin';
  if (normalised.includes('/skills/.system/')) return 'codex-system';
  if (normalised.startsWith(`${normalisedCodexHome}/skills/`)) return 'codex-global';
  if (normalisedRoot.endsWith('/.agents/skills')) {
    return normalisedRoot.startsWith(homedir().split('\\').join('/')) ? 'user-agents' : 'project';
  }
  return 'unknown';
}

function parseMarkdownMetadata(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {};

  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};

  const raw = content.slice(3, end).trim();
  const metadata: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    metadata[match[1]] = stripQuotes(match[2].trim());
  }

  return metadata;
}

function readFirstParagraph(content: string): string | undefined {
  const body = content.replace(/^---[\s\S]*?\n---\s*/, '');
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('#'));
  return paragraph?.replace(/\s+/g, ' ').slice(0, 240);
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/^\[/, '').replace(/\]$/, '');
  const tags = trimmed
    .split(',')
    .map((tag) => stripQuotes(tag.trim()))
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

async function listCodexMcpServers(): Promise<{
  servers: CodexMcpServer[];
  warnings: string[];
}> {
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['mcp', 'list'], {
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT_BUFFER,
    });
    const warnings = String(stderr)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('WARNING:'));

    return {
      servers: parseCodexMcpListOutput(String(stdout)),
      warnings,
    };
  } catch (err) {
    return {
      servers: [],
      warnings: [`Could not list Codex MCP servers: ${getErrorMessage(err)}`],
    };
  }
}

export function parseCodexMcpListOutput(output: string): CodexMcpServer[] {
  const servers: CodexMcpServer[] = [];
  let table: 'stdio' | 'http' | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('WARNING:')) continue;

    if (/^Name\s+Command\s+Args/i.test(line)) {
      table = 'stdio';
      continue;
    }

    if (/^Name\s+Url\s+Bearer/i.test(line)) {
      table = 'http';
      continue;
    }

    if (!table) continue;

    const columns = line.split(/\s{2,}/).map((column) => column.trim());
    if (columns.length < 4) continue;

    if (table === 'stdio') {
      if (columns.length < 6) continue;
      const status = dashToUndefined(columns[columns.length - 2]);
      const auth = dashToUndefined(columns[columns.length - 1]);
      const argsRaw = columns.slice(2, columns.length - 4).join(' ');

      servers.push({
        name: columns[0],
        transport: 'stdio',
        command: dashToUndefined(columns[1]),
        args: splitCommandLine(dashToUndefined(argsRaw) ?? ''),
        status,
        auth,
        raw: line,
      });
      continue;
    }

    const status = dashToUndefined(columns[columns.length - 2]);
    const auth = dashToUndefined(columns[columns.length - 1]);

    servers.push({
      name: columns[0],
      transport: 'http',
      url: dashToUndefined(columns[1]),
      status,
      auth,
      raw: line,
    });
  }

  return servers;
}

async function getSkillsShCatalog(query: string): Promise<CodexSkillSearchResult[]> {
  const trimmedQuery = query.trim();
  if (
    skillsCache &&
    skillsCache.query === trimmedQuery &&
    Date.now() - skillsCache.loadedAt < SEARCH_CACHE_TTL_MS
  ) {
    return skillsCache.items;
  }

  const items = await fetchSkillsShCatalog(trimmedQuery);
  skillsCache = { loadedAt: Date.now(), query: trimmedQuery, items };
  return items;
}

async function fetchSkillsShCatalog(query: string): Promise<CodexSkillSearchResult[]> {
  const apiKey = process.env.SKILLS_SH_API_KEY || process.env.SKILLS_API_KEY;

  if (apiKey) {
    try {
      return await fetchSkillsShApiCatalog(query, apiKey);
    } catch (err) {
      console.warn('[Codex Registry] Falling back to skills CLI search:', err);
    }
  }

  return searchSkillsWithCli(query);
}

async function fetchSkillsShApiCatalog(
  query: string,
  apiKey: string,
): Promise<CodexSkillSearchResult[]> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 12_000);
  const endpoint = new URL(
    query ? '/api/v1/skills/search' : '/api/v1/skills',
    SKILLS_SH_API_BASE_URL,
  );

  if (query) {
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('limit', String(DEFAULT_SEARCH_LIMIT));
  } else {
    endpoint.searchParams.set('per_page', String(DEFAULT_SEARCH_LIMIT));
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'Anvil Codex Registry',
      },
      signal: abort.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`skills.sh returned ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return normaliseSkillsShPayload(payload);
}

async function searchSkillsWithCli(query: string): Promise<CodexSkillSearchResult[]> {
  if (!query) return [];

  const { stdout, stderr } = await execFileAsync('npx', ['--yes', 'skills', 'find', query], {
    timeout: 30_000,
    maxBuffer: MAX_OUTPUT_BUFFER,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });

  return parseSkillsFindOutput(joinOutput(stdout, stderr) ?? '');
}

export function parseSkillsFindOutput(output: string): CodexSkillSearchResult[] {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const results: CodexSkillSearchResult[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('Install with')) continue;

    const match = line.match(/^(\S+)(?:\s+([\d.]+)([KkMm])?\s+installs?)?$/);
    if (!match) continue;

    const spec = match[1];
    const parsed = parseSkillPackageSpec(spec);
    if (!parsed) continue;

    const urlLine = lines[index + 1]?.match(/^└\s+(https?:\/\/\S+)$/);
    const url = urlLine?.[1];
    if (urlLine) index += 1;

    results.push({
      id: `${parsed.source}:${parsed.skillName || parsed.name}`,
      name: parsed.name,
      source: parsed.source,
      skillName: parsed.skillName,
      installCommand: buildSkillInstallCommand({
        source: parsed.source,
        skillName: parsed.skillName,
        global: true,
      }),
      url,
      repositoryUrl: buildRepositoryUrl(parsed.source),
      installs: parseInstallCount(match[2], match[3]),
    });
  }

  return results;
}

export function normaliseSkillsShPayload(payload: unknown): CodexSkillSearchResult[] {
  const items = flattenSkillsShItems(extractArrayPayload(payload));

  return items
    .map((item) => normaliseSkillsShItem(item))
    .filter((item): item is CodexSkillSearchResult => Boolean(item));
}

function flattenSkillsShItems(items: unknown[]): unknown[] {
  const flattened: unknown[] = [];

  for (const item of items) {
    if (!isRecord(item) || !Array.isArray(item.skills)) {
      flattened.push(item);
      continue;
    }

    for (const skill of item.skills) {
      flattened.push(isRecord(skill) ? { ...item, ...skill } : skill);
    }
  }

  return flattened;
}

function normaliseSkillsShItem(item: unknown): CodexSkillSearchResult | null {
  if (!isRecord(item)) return null;

  const name =
    pickString(item, ['name', 'title', 'slug', 'id', 'skillName', 'skill_name']) || 'Unnamed skill';
  const source =
    pickSource(item) || pickString(item, ['repository', 'repo', 'source', 'package', 'github']);
  if (!source || source.startsWith('-')) return null;

  const skillName =
    pickString(item, ['skillName', 'skill_name', 'skill', 'slug']) ||
    (source.includes('/') ? name : undefined);
  const repositoryUrl = pickRepositoryUrl(item, source);
  const url = pickString(item, ['url', 'homepage', 'htmlUrl', 'html_url']) || repositoryUrl;
  const tags = pickTags(item);

  return {
    id: `${source}:${skillName || name}`,
    name,
    description: pickString(item, ['description', 'summary', 'readme', 'excerpt']),
    source,
    skillName,
    installCommand: buildSkillInstallCommand({
      source,
      skillName,
      global: true,
    }),
    url,
    repositoryUrl,
    installs: pickNumber(item, ['installs', 'installCount', 'downloads', 'totalInstalls']),
    weeklyInstalls: pickNumber(item, ['weeklyInstalls', 'weeklyDownloads']),
    tags,
  };
}

export function filterSkillSearchResults(
  items: CodexSkillSearchResult[],
  query: string,
): CodexSkillSearchResult[] {
  const trimmedQuery = query.trim().toLowerCase();
  if (!trimmedQuery) {
    return [...items].sort((a, b) => (b.installs ?? 0) - (a.installs ?? 0));
  }

  return items
    .map((item) => ({
      item,
      score: scoreSkillSearchResult(item, trimmedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.installs ?? 0) - (a.item.installs ?? 0);
    })
    .map(({ item }) => item);
}

function scoreSkillSearchResult(item: CodexSkillSearchResult, query: string): number {
  const tokens = query.split(/\s+/).filter(Boolean);
  const name = item.name.toLowerCase();
  const source = item.source.toLowerCase();
  const haystack = [item.name, item.source, item.skillName, item.description, ...(item.tags ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 80;
    if (name.startsWith(token)) score += 40;
    if (source.includes(token)) score += 25;
    if (haystack.includes(token)) score += 15;
    if (isSubsequence(token, name) || isSubsequence(token, source)) score += 6;
  }

  return tokens.every((token) => haystack.includes(token) || isSubsequence(token, haystack))
    ? score
    : 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

function buildSkillCliArgs(input: CodexSkillInstallInput): string[] {
  const source = validateSource(input.source, 'Skill source');
  const skillName = input.skillName ? validateSource(input.skillName, 'Skill name') : undefined;
  const args = ['skills', 'add', source];

  if (skillName) {
    args.push('--skill', skillName);
  }

  args.push('-a', 'codex');

  if (input.global ?? true) {
    args.push('-g');
  }

  args.push('-y');
  return args;
}

function buildSkillInstallCommand(input: CodexSkillInstallInput): string {
  return formatCommand(['npx', ...buildSkillCliArgs(input)]);
}

function buildMcpRegisterArgs(input: CodexMcpRegisterInput): string[] {
  const name = validateMcpName(input.name);
  const args = ['mcp', 'add', name];

  if (input.transport === 'http') {
    const url = validateUrl(input.url);
    args.push('--transport', 'http');

    if (input.bearerTokenEnvVar?.trim()) {
      const envVar = validateEnvVar(input.bearerTokenEnvVar);
      args.push('--header', `Authorization: Bearer $${envVar}`);
    }

    args.push(url);
    return args;
  }

  const command = validateCommand(input.command);
  args.push('--', command, ...(input.args ?? []).map((arg) => validateArg(arg)));
  return args;
}

function validateSource(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.startsWith('-')) throw new Error(`${label} cannot start with a dash`);
  if (/[\r\n\0]/.test(trimmed)) throw new Error(`${label} contains invalid characters`);
  if (trimmed.length > 300) throw new Error(`${label} is too long`);
  return trimmed;
}

function validateMcpName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(trimmed)) {
    throw new Error('MCP name must use letters, numbers, dots, dashes, or underscores');
  }
  return trimmed;
}

function validateCommand(value: string | undefined): string {
  const trimmed = validateSource(value ?? '', 'MCP command');
  if (trimmed.includes(' ')) {
    throw new Error('MCP command must be the executable only. Put flags in Args.');
  }
  return trimmed;
}

function validateArg(value: string): string {
  const trimmed = value.trim();
  if (/[\r\n\0]/.test(trimmed)) throw new Error('MCP args contain invalid characters');
  if (trimmed.length > 500) throw new Error('MCP arg is too long');
  return trimmed;
}

function validateUrl(value: string | undefined): string {
  const trimmed = validateSource(value ?? '', 'MCP URL');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('MCP URL must start with http:// or https://');
  }
  return parsed.toString();
}

function validateEnvVar(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error('Bearer token environment variable is invalid');
  }
  return trimmed;
}

function extractArrayPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  for (const key of ['skills', 'data', 'items', 'results']) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }

  return [];
}

function pickSource(record: Record<string, unknown>): string | undefined {
  const repository = record.repository || record.repo || record.github;
  if (typeof repository === 'string') return stripGithubUrl(repository);

  if (isRecord(repository)) {
    const fullName = pickString(repository, ['full_name', 'fullName', 'nameWithOwner']);
    if (fullName) return stripGithubUrl(fullName);

    const owner = pickString(repository, ['owner', 'org', 'organization']);
    const name = pickString(repository, ['name', 'repo']);
    if (owner && name) return `${owner}/${name}`;

    const url = pickString(repository, ['url', 'html_url', 'htmlUrl']);
    if (url) return stripGithubUrl(url);
  }

  const owner = pickString(record, ['owner', 'org', 'organization']);
  const repo = pickString(record, ['repo', 'repositoryName', 'repository_name']);
  if (owner && repo) return `${owner}/${repo}`;

  return undefined;
}

function pickRepositoryUrl(record: Record<string, unknown>, source: string): string | undefined {
  const explicit = pickString(record, [
    'repositoryUrl',
    'repository_url',
    'repoUrl',
    'repo_url',
    'installUrl',
    'install_url',
  ]);
  if (explicit) return explicit;
  const githubUrl = buildRepositoryUrl(source);
  if (githubUrl) return githubUrl;
  if (source.startsWith('https://github.com/')) return source;
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickTags(record: Record<string, unknown>): string[] | undefined {
  const raw = record.tags || record.keywords || record.categories;
  if (Array.isArray(raw)) {
    const tags = raw.filter(
      (tag): tag is string => typeof tag === 'string' && tag.trim().length > 0,
    );
    return tags.length > 0 ? tags : undefined;
  }
  if (typeof raw === 'string') return parseTags(raw);
  return undefined;
}

function stripGithubUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

function buildRepositoryUrl(source: string): string | undefined {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return `https://github.com/${source}`;
  }
  if (source.startsWith('https://github.com/')) return source;
  return undefined;
}

function parseSkillPackageSpec(spec: string):
  | {
      source: string;
      skillName?: string;
      name: string;
    }
  | undefined {
  const atIndex = spec.lastIndexOf('@');
  const source = atIndex > 0 ? spec.slice(0, atIndex) : spec;
  const skillName = atIndex > 0 ? spec.slice(atIndex + 1) : undefined;

  if (!source || source.startsWith('-')) return undefined;

  return {
    source,
    skillName,
    name: humaniseSkillName(skillName || basename(source)),
  };
}

function humaniseSkillName(value: string): string {
  return value
    .replace(/[:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseInstallCount(
  value: string | undefined,
  suffix: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;

  if (suffix?.toLowerCase() === 'm') return Math.round(parsed * 1_000_000);
  if (suffix?.toLowerCase() === 'k') return Math.round(parsed * 1_000);
  return parsed;
}

function stripAnsi(value: string): string {
  const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return value.replace(ansiEscapePattern, '');
}

function dedupePaths<T extends { path: string }>(roots: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const root of roots) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    result.push(root);
  }
  return result;
}

function dashToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed && trimmed !== '-' ? trimmed : undefined;
}

function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]/, '').replace(/['"]$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinOutput(stdout: unknown, stderr: unknown): string | undefined {
  const output = [stdout, stderr]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return output || undefined;
}

function getExecOutput(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined;
  return joinOutput(err.stdout, err.stderr);
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatCommand(args: string[]): string {
  return args.map(shellQuote).join(' ');
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,$-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
