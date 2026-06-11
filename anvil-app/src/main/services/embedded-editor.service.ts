import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { app, shell } from 'electron';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  type EmbeddedEditorFileSnapshot,
  type EmbeddedEditorFocusResult,
  type EmbeddedEditorStatus,
  type EmbeddedEditorTarget,
} from '../../shared/types.js';
import { parseEditorFileLocation } from '../../shared/editor-file-link.js';
import type { AppTheme } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { getSettings } from './settings.service.js';
import { getWorkspace } from './workspace.service.js';

interface RepoRow {
  id: string;
  name: string;
  path: string;
}

interface ResolvedTarget {
  repo?: RepoRow;
  absolutePath?: string;
  relativePath?: string;
  line?: number;
  column?: number;
  title?: string;
  source?: EmbeddedEditorTarget['source'];
  workspaceId?: string;
}

interface EditorRuntimeState {
  process: ChildProcessWithoutNullStreams | null;
  workspaceId: string | null;
  workspaceSignature: string | null;
  runtimeDir: string | null;
  workspaceFilePath: string | null;
  url: string | null;
  startedAt: string | null;
  lastError: string | null;
  outputTail: string[];
  provider: 'code-server' | 'vscode-web' | null;
  command: string | null;
}

interface ProcessListEntry {
  pid: number;
  ppid: number;
  command: string;
}

interface AnvilEditorProcessTargets {
  pids: number[];
  socketPaths: string[];
}

const MAX_OUTPUT_LINES = 40;
const PROCESS_STOP_GRACE_MS = 750;
const DEFAULT_EXCERPT_BEFORE = 35;
const DEFAULT_EXCERPT_AFTER = 90;
const DEFAULT_TOP_OF_FILE_LINES = 180;
const EMBEDDED_EDITOR_WORKSPACE_SETTINGS = {
  'git.enabled': false,
  'git.autoRepositoryDetection': false,
  'git.openRepositoryInParentFolders': 'never',
  'scm.alwaysShowRepositories': false,
  'chat.commandCenter.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'terminal.integrated.hideOnStartup': 'always',
  'terminal.integrated.hideOnLastClosed': true,
  'terminal.integrated.enablePersistentSessions': false,
  'terminal.integrated.tabs.enabled': false,
  'terminal.integrated.tabs.hideCondition': 'always',
  'task.allowAutomaticTasks': 'off',
} as const;
const EMBEDDED_EDITOR_DEFAULT_USER_SETTINGS = {
  ...EMBEDDED_EDITOR_WORKSPACE_SETTINGS,
  'workbench.preferredLightColorTheme': 'Default Light Modern',
  'workbench.preferredDarkColorTheme': 'Default Dark Modern',
} as const;
const VSCODE_WEB_DISABLED_EXTENSIONS = [
  'vscode.git',
  'vscode.github',
  'github.vscode-pull-request-github',
  'GitHub.vscode-pull-request-github',
] as const;
const EDITOR_TEMP_DIR_PREFIXES = ['anvil-editor-'] as const;

const runtimeState: EditorRuntimeState = {
  process: null,
  workspaceId: null,
  workspaceSignature: null,
  runtimeDir: null,
  workspaceFilePath: null,
  url: null,
  startedAt: null,
  lastError: null,
  outputTail: [],
  provider: null,
  command: null,
};

function listAllRepos(): RepoRow[] {
  const db = getDb();
  return db.prepare('SELECT id, name, path FROM repos ORDER BY updated_at DESC').all() as RepoRow[];
}

function getWorkspaceRepos(workspaceId?: string): RepoRow[] {
  if (!workspaceId) return listAllRepos();
  try {
    return getWorkspace(workspaceId).repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      path: repo.path,
    }));
  } catch {
    return listAllRepos();
  }
}

function commonParentDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const segments = paths.map((candidate) => resolve(candidate).split(sep).filter(Boolean));
  const shared: string[] = [];
  const shortestLength = Math.min(...segments.map((candidate) => candidate.length));

  for (let index = 0; index < shortestLength; index += 1) {
    const segment = segments[0][index];
    if (segments.every((candidate) => candidate[index] === segment)) {
      shared.push(segment);
    } else {
      break;
    }
  }

  if (shared.length === 0) return null;
  return `${sep}${shared.join(sep)}`;
}

export function findWorkspaceCodeWorkspaceFile(workspaceId: string): string | null {
  let workspace: ReturnType<typeof getWorkspace>;
  try {
    workspace = getWorkspace(workspaceId);
  } catch {
    return null;
  }

  const candidateDirs = new Set<string>();
  const scaffoldRoot = workspace.scaffoldSession?.rootPath;
  if (scaffoldRoot && existsSync(scaffoldRoot)) {
    candidateDirs.add(resolve(scaffoldRoot));
  }

  const repoParent = commonParentDir(workspace.repos.map((repo) => repo.path));
  if (repoParent && repoParent !== sep) {
    candidateDirs.add(repoParent);
  }
  for (const repo of workspace.repos) {
    const repoParentDir = dirname(resolve(repo.path));
    if (repoParentDir && repoParentDir !== sep) {
      candidateDirs.add(repoParentDir);
    }
  }

  for (const candidateDir of candidateDirs) {
    try {
      const files = readdirSync(candidateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.code-workspace'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));

      if (files.length === 0) continue;

      const exactName = `${workspace.name}.code-workspace`;
      const preferred =
        files.find((name) => name === exactName) ??
        files.find((name) => name.toLowerCase() === exactName.toLowerCase()) ??
        files[0];

      return join(candidateDir, preferred);
    } catch {
      continue;
    }
  }

  return null;
}

function getDefaultWorkspaceRepo(workspaceId?: string): RepoRow | undefined {
  if (!workspaceId) return undefined;
  return getWorkspaceRepos(workspaceId)[0];
}

function buildWorkspaceRepoSignature(workspace: ReturnType<typeof getWorkspace>): string {
  return JSON.stringify(
    workspace.repos
      .map((repo) => ({
        id: repo.id,
        path: resolve(repo.path),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function pushOutputLine(line: string): void {
  runtimeState.outputTail.push(line.trim());
  if (runtimeState.outputTail.length > MAX_OUTPUT_LINES) {
    runtimeState.outputTail.splice(0, runtimeState.outputTail.length - MAX_OUTPUT_LINES);
  }
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolveExec, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolveExec(String(stdout));
    });
  });
}

export function parseProcessList(output: string): ProcessListEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }))
    .filter((entry) => Number.isFinite(entry.pid) && Number.isFinite(entry.ppid));
}

function extractSocketPath(command: string): string | null {
  const match = command.match(/--socket-path\s+("[^"]+"|'[^']+'|\S+)/);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, '');
}

export function collectAnvilEmbeddedEditorProcessTargets(
  processes: ProcessListEntry[],
  anvilProfileDirs: string[],
): AnvilEditorProcessTargets {
  const anvilMarkers = [...anvilProfileDirs, ...EDITOR_TEMP_DIR_PREFIXES].filter(Boolean);
  const pids = new Set<number>();
  const socketPaths = new Set<string>();

  for (const processInfo of processes) {
    const command = processInfo.command;
    const isAnvilOwned = anvilMarkers.some((marker) => command.includes(marker));
    const isEditorServer =
      command.includes('serve-web') ||
      command.includes('code-tunnel') ||
      command.includes('server-main.js') ||
      command.includes('bin/code-server');

    if (!isAnvilOwned || !isEditorServer) continue;

    pids.add(processInfo.pid);
    const socketPath = extractSocketPath(command);
    if (socketPath) {
      socketPaths.add(socketPath);
    }
  }

  return {
    pids: [...pids].sort((left, right) => right - left),
    socketPaths: [...socketPaths],
  };
}

export function parseVscodeCommitId(versionOutput: string): string | null {
  const commit = versionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[a-f0-9]{40}$/i.test(line));
  return commit ?? null;
}

async function resolveVscodeCommitId(command: string): Promise<string | null> {
  try {
    return parseVscodeCommitId(await execFileText(command, ['--version']));
  } catch {
    return null;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone or not signalable.
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;

  if (process.platform === 'win32') {
    signalProcess(pid, signal);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    signalProcess(pid, signal);
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  await execFileText('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined);
}

async function terminateRuntimeProcess(
  child: ChildProcessWithoutNullStreams,
  options: { killGroup: boolean },
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    child.kill('SIGTERM');
    await wait(PROCESS_STOP_GRACE_MS);
    if (child.exitCode === null) {
      await killWindowsProcessTree(pid);
    }
    return;
  }

  if (options.killGroup) {
    signalProcessGroup(pid, 'SIGTERM');
  } else {
    signalProcess(pid, 'SIGTERM');
  }
  await wait(PROCESS_STOP_GRACE_MS);
  if (child.exitCode === null) {
    if (options.killGroup) {
      signalProcessGroup(pid, 'SIGKILL');
    } else {
      signalProcess(pid, 'SIGKILL');
    }
  }
}

async function cleanupStaleEmbeddedEditorProcesses(): Promise<void> {
  if (process.platform === 'win32') return;

  let processOutput: string;
  try {
    processOutput = await execFileText('ps', ['-axo', 'pid=,ppid=,command=']);
  } catch {
    return;
  }

  const targets = collectAnvilEmbeddedEditorProcessTargets(parseProcessList(processOutput), [
    getEmbeddedEditorProfileDir('vscode-web'),
    getEmbeddedEditorProfileDir('code-server'),
  ]);

  for (const pid of targets.pids) {
    if (pid === process.pid) continue;
    signalProcess(pid, 'SIGTERM');
  }

  if (targets.pids.length > 0) {
    await wait(PROCESS_STOP_GRACE_MS);
  }

  for (const pid of targets.pids) {
    if (pid === process.pid) continue;
    signalProcess(pid, 'SIGKILL');
  }

  for (const socketPath of targets.socketPaths) {
    if (existsSync(socketPath)) {
      rmSync(socketPath, { force: true });
    }
  }
}

function cleanupStaleRuntimeDirs(): void {
  const tempDir = app.getPath('temp');
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(tempDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !EDITOR_TEMP_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
    ) {
      continue;
    }
    const candidate = join(tempDir, entry.name);
    if (runtimeState.runtimeDir && resolve(candidate) === resolve(runtimeState.runtimeDir))
      continue;
    rmSync(candidate, { recursive: true, force: true });
  }
}

function detectEmbeddedProvider(): {
  provider: 'code-server' | 'vscode-web';
  command: string;
} | null {
  const vscodeCommand = findFirstAvailableCommand(['code']);
  if (vscodeCommand) {
    return { provider: 'vscode-web', command: vscodeCommand };
  }

  const codeServerCommand = findFirstAvailableCommand(['code-server']);
  if (codeServerCommand) {
    return { provider: 'code-server', command: codeServerCommand };
  }

  return null;
}

function runtimeProcessHasExited(): boolean {
  return Boolean(
    runtimeState.process &&
    (runtimeState.process.exitCode !== null || runtimeState.process.signalCode !== null),
  );
}

function clearRuntimeAfterExit(workspaceId?: string): void {
  runtimeState.process = null;
  runtimeState.url = null;
  runtimeState.startedAt = null;
  if (!workspaceId || runtimeState.workspaceId === workspaceId) {
    runtimeState.workspaceId = null;
    runtimeState.workspaceSignature = null;
  }
  runtimeState.provider = null;
  runtimeState.command = null;
  removeRuntimeArtifacts();
}

function buildStatus(): EmbeddedEditorStatus {
  const embeddedProvider = detectEmbeddedProvider();
  const externalCommand = findFirstAvailableCommand(['code', 'codium', 'cursor']) as
    | 'code'
    | 'codium'
    | 'cursor'
    | null;

  if (runtimeProcessHasExited()) {
    runtimeState.lastError =
      runtimeState.lastError ??
      runtimeState.outputTail.at(-1) ??
      'Embedded editor exited unexpectedly.';
    clearRuntimeAfterExit();
  }

  if (runtimeState.process && runtimeState.url) {
    return {
      availability: 'available',
      mode: 'browser',
      running: true,
      provider: runtimeState.provider ?? embeddedProvider?.provider,
      command: runtimeState.command ?? embeddedProvider?.command ?? undefined,
      url: runtimeState.url,
      workspaceId: runtimeState.workspaceId ?? undefined,
      startedAt: runtimeState.startedAt ?? undefined,
      lastError: runtimeState.lastError ?? undefined,
      externalCommand: externalCommand ?? undefined,
    };
  }

  if (runtimeState.lastError) {
    return {
      availability: embeddedProvider ? 'error' : 'unavailable',
      mode: 'inspect',
      running: false,
      provider: embeddedProvider?.provider,
      command: embeddedProvider?.command,
      workspaceId: runtimeState.workspaceId ?? undefined,
      startedAt: runtimeState.startedAt ?? undefined,
      lastError: runtimeState.lastError,
      externalCommand: externalCommand ?? undefined,
    };
  }

  return {
    availability: embeddedProvider ? 'available' : 'unavailable',
    mode: embeddedProvider ? 'browser' : 'inspect',
    running: false,
    provider: embeddedProvider?.provider,
    command: embeddedProvider?.command,
    externalCommand: externalCommand ?? undefined,
  };
}

function findFirstAvailableCommand(commands: readonly string[]): string | null {
  const pathValue = process.env.PATH ?? '';
  const searchDirs = pathValue.split(delimiter).filter(Boolean);

  for (const command of commands) {
    if (command.includes(sep)) {
      if (existsSync(command)) return command;
      continue;
    }

    for (const dir of searchDirs) {
      const candidate = join(dir, command);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function isWithinRepo(candidatePath: string, repoPath: string): boolean {
  const normalizedCandidate = normalize(candidatePath);
  const normalizedRepoPath = normalize(repoPath);
  return (
    normalizedCandidate === normalizedRepoPath ||
    normalizedCandidate.startsWith(`${normalizedRepoPath}${sep}`)
  );
}

function resolveTarget(target: EmbeddedEditorTarget): ResolvedTarget {
  const repos = getWorkspaceRepos(target.workspaceId);
  const absoluteLocation = parseEditorFileLocation(target.absolutePath, {
    requireFileSignal: false,
  });
  const relativeLocation = parseEditorFileLocation(target.relativePath, {
    requireFileSignal: false,
  });
  const absolutePathInput = absoluteLocation?.path ?? target.absolutePath;
  const relativePathInput = relativeLocation?.path ?? target.relativePath;
  const normalizedAbsolutePath = absolutePathInput ? resolve(absolutePathInput) : undefined;
  const existingWorkspaceFile = target.workspaceId
    ? findWorkspaceCodeWorkspaceFile(target.workspaceId)
    : null;

  let repo: RepoRow | undefined;
  let relativePath = relativePathInput ? normalize(relativePathInput) : undefined;
  let absolutePath = normalizedAbsolutePath;
  const line = target.line ?? absoluteLocation?.line ?? relativeLocation?.line;
  const column = target.column ?? absoluteLocation?.column ?? relativeLocation?.column;

  if (target.repoId) {
    repo = repos.find((candidate) => candidate.id === target.repoId);
  }

  if (!repo && normalizedAbsolutePath) {
    repo = [...repos]
      .sort((a, b) => b.path.length - a.path.length)
      .find((candidate) => isWithinRepo(normalizedAbsolutePath, candidate.path));
  }

  if (!repo && relativePath) {
    repo = repos.find((candidate) => existsSync(join(candidate.path, relativePath!)));
  }

  if (repo && relativePath && !absolutePath) {
    absolutePath = resolve(repo.path, relativePath);
  }

  if (repo && absolutePath && !relativePath && isWithinRepo(absolutePath, repo.path)) {
    relativePath = relative(repo.path, absolutePath);
  }

  if (!repo && !absolutePath && !relativePath && target.workspaceId && !existingWorkspaceFile) {
    repo = getDefaultWorkspaceRepo(target.workspaceId);
  }

  return {
    repo,
    absolutePath,
    relativePath,
    line,
    column,
    title: target.title,
    source: target.source,
    workspaceId: target.workspaceId,
  };
}

function buildSnapshot(resolvedTarget: ResolvedTarget): EmbeddedEditorFileSnapshot | null {
  if (!resolvedTarget.absolutePath) return null;

  if (!existsSync(resolvedTarget.absolutePath)) {
    return {
      kind: 'missing',
      absolutePath: resolvedTarget.absolutePath,
      relativePath: resolvedTarget.relativePath,
      fileName: basename(resolvedTarget.absolutePath),
      repoId: resolvedTarget.repo?.id,
      repoName: resolvedTarget.repo?.name,
      content: '',
      totalLines: 0,
      displayStartLine: 0,
      displayEndLine: 0,
      focusLine: resolvedTarget.line,
      focusColumn: resolvedTarget.column,
      truncated: false,
      message: 'The file could not be found on disk.',
    };
  }

  try {
    const fileStat = statSync(resolvedTarget.absolutePath);
    if (!fileStat.isFile()) {
      return {
        kind: 'missing',
        absolutePath: resolvedTarget.absolutePath,
        relativePath: resolvedTarget.relativePath,
        fileName: basename(resolvedTarget.absolutePath),
        repoId: resolvedTarget.repo?.id,
        repoName: resolvedTarget.repo?.name,
        content: '',
        totalLines: 0,
        displayStartLine: 0,
        displayEndLine: 0,
        focusLine: resolvedTarget.line,
        focusColumn: resolvedTarget.column,
        truncated: false,
        message: 'The selected path is not a file.',
      };
    }

    const rawContent = readFileSync(resolvedTarget.absolutePath, 'utf8');
    if (rawContent.includes('\u0000')) {
      return {
        kind: 'binary',
        absolutePath: resolvedTarget.absolutePath,
        relativePath: resolvedTarget.relativePath,
        fileName: basename(resolvedTarget.absolutePath),
        repoId: resolvedTarget.repo?.id,
        repoName: resolvedTarget.repo?.name,
        content: '',
        totalLines: 0,
        displayStartLine: 0,
        displayEndLine: 0,
        focusLine: resolvedTarget.line,
        focusColumn: resolvedTarget.column,
        truncated: false,
        message: 'This file looks binary, so Anvil is showing metadata only.',
      };
    }

    const lines = rawContent.split(/\r?\n/);
    const totalLines = lines.length;
    const focusLine =
      resolvedTarget.line && resolvedTarget.line > 0 ? resolvedTarget.line : undefined;
    const displayStartLine = focusLine ? Math.max(1, focusLine - DEFAULT_EXCERPT_BEFORE) : 1;
    const maxWindowSize = focusLine
      ? DEFAULT_EXCERPT_BEFORE + DEFAULT_EXCERPT_AFTER + 1
      : DEFAULT_TOP_OF_FILE_LINES;
    const displayEndLine = Math.min(totalLines, displayStartLine + maxWindowSize - 1);
    const truncated = displayStartLine > 1 || displayEndLine < totalLines;

    return {
      kind: 'text',
      absolutePath: resolvedTarget.absolutePath,
      relativePath: resolvedTarget.relativePath,
      fileName: basename(resolvedTarget.absolutePath),
      repoId: resolvedTarget.repo?.id,
      repoName: resolvedTarget.repo?.name,
      content: lines.slice(displayStartLine - 1, displayEndLine).join('\n'),
      totalLines,
      displayStartLine,
      displayEndLine,
      focusLine,
      focusColumn: resolvedTarget.column,
      truncated,
    };
  } catch (error) {
    return {
      kind: 'missing',
      absolutePath: resolvedTarget.absolutePath,
      relativePath: resolvedTarget.relativePath,
      fileName: basename(resolvedTarget.absolutePath),
      repoId: resolvedTarget.repo?.id,
      repoName: resolvedTarget.repo?.name,
      content: '',
      totalLines: 0,
      displayStartLine: 0,
      displayEndLine: 0,
      focusLine: resolvedTarget.line,
      focusColumn: resolvedTarget.column,
      truncated: false,
      message: error instanceof Error ? error.message : 'Failed to read the file.',
    };
  }
}

function removeRuntimeArtifacts(): void {
  if (runtimeState.runtimeDir && existsSync(runtimeState.runtimeDir)) {
    rmSync(runtimeState.runtimeDir, { recursive: true, force: true });
  }
  runtimeState.runtimeDir = null;
  runtimeState.workspaceFilePath = null;
}

function getEmbeddedEditorProfileDir(provider: 'code-server' | 'vscode-web'): string {
  return join(app.getPath('userData'), 'embedded-editor', provider);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function stripJsonComments(jsonText: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < jsonText.length; index += 1) {
    const char = jsonText[index];
    const next = jsonText[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < jsonText.length && jsonText[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < jsonText.length && !(jsonText[index] === '*' && jsonText[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function getUserVscodeSettingsPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }

  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Code',
      'User',
      'settings.json',
    );
  }

  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'Code',
    'User',
    'settings.json',
  );
}

function readUserVscodeSettings(): Record<string, unknown> {
  return readJsonObject(getUserVscodeSettingsPath()) ?? {};
}

async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to allocate a local port.'));
          return;
        }
        resolvePort(address.port);
      });
    });
    server.on('error', reject);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForServerReady(url: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (runtimeState.process && runtimeState.process.exitCode !== null) {
      break;
    }

    try {
      const response = await fetch(url, { method: 'GET' });
      if (!response.ok && response.status !== 401) {
        throw new Error(`Editor server responded with HTTP ${response.status}`);
      }
      return;
    } catch {
      await wait(250);
    }
  }

  const detail = runtimeState.outputTail.at(-1);
  throw new Error(
    detail
      ? `Embedded editor failed to start: ${detail}`
      : 'Embedded editor timed out while starting.',
  );
}

interface CodeWorkspaceFolder {
  path?: unknown;
  uri?: unknown;
  name?: unknown;
}

interface CodeWorkspaceFile {
  folders?: unknown;
  settings?: unknown;
}

function normalizeCodeWorkspaceFolders(
  workspaceFilePath: string,
  folders: unknown,
): Array<Record<string, string>> {
  if (!Array.isArray(folders)) return [];
  const workspaceDir = dirname(workspaceFilePath);

  return folders
    .map((folder): Record<string, string> | null => {
      if (!folder || typeof folder !== 'object') return null;
      const candidate = folder as CodeWorkspaceFolder;
      if (typeof candidate.uri === 'string') {
        return {
          ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
          uri: candidate.uri,
        };
      }
      if (typeof candidate.path !== 'string') return null;
      const folderPath = isAbsolute(candidate.path)
        ? candidate.path
        : resolve(workspaceDir, candidate.path);
      return {
        ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
        path: folderPath,
      };
    })
    .filter((folder): folder is Record<string, string> => Boolean(folder));
}

export function createWorkspaceSnapshotFile(
  workspaceId: string,
  runtimeDir: string,
  sourceWorkspaceFilePath?: string,
): string {
  const workspace = getWorkspace(workspaceId);
  if (workspace.repos.length === 0 && !sourceWorkspaceFilePath) {
    throw new Error('This workspace has no repositories yet.');
  }

  mkdirSync(runtimeDir, { recursive: true });

  const workspaceFilePath = join(
    runtimeDir,
    `${workspace.name.replace(/[^a-z0-9-_]+/gi, '-')}.code-workspace`,
  );
  let folders = workspace.repos.map((repo) => ({ path: repo.path }));
  let settings: Record<string, unknown> = {};

  if (sourceWorkspaceFilePath) {
    try {
      const parsed = JSON.parse(
        stripJsonComments(readFileSync(sourceWorkspaceFilePath, 'utf8')),
      ) as CodeWorkspaceFile;
      const sourceFolders = normalizeCodeWorkspaceFolders(sourceWorkspaceFilePath, parsed.folders);
      if (workspace.repos.length === 0) {
        folders = sourceFolders;
      }
      settings =
        parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
          ? (parsed.settings as Record<string, unknown>)
          : {};
    } catch (error) {
      if (workspace.repos.length === 0) {
        throw error;
      }
    }
  }

  if (folders.length === 0) {
    throw new Error('This workspace has no folders to open in the embedded editor.');
  }

  writeFileSync(
    workspaceFilePath,
    JSON.stringify(
      {
        folders,
        settings: {
          ...settings,
          ...EMBEDDED_EDITOR_WORKSPACE_SETTINGS,
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  return workspaceFilePath;
}

export function buildWorkbenchUrl(
  baseUrl: string,
  target:
    | {
        type: 'workspace';
        path: string;
      }
    | {
        type: 'folder';
        path: string;
      },
): string {
  const url = new URL(baseUrl);
  url.searchParams.delete('workspace');
  url.searchParams.delete('folder');
  url.searchParams.set(target.type === 'workspace' ? 'workspace' : 'folder', target.path);
  return url.toString();
}

function getEditorColorTheme(appTheme: AppTheme): string {
  return appTheme === 'system' ? 'Default Light Modern' : 'Default Dark Modern';
}

export function buildEmbeddedEditorUserSettings(
  existingSettings: Record<string, unknown>,
): Record<string, unknown> {
  const appTheme = getSettings().theme;
  const themeSettings: Record<string, unknown> =
    appTheme === 'system'
      ? {
          'window.autoDetectColorScheme': true,
          'workbench.preferredLightColorTheme': 'Default Light Modern',
          'workbench.preferredDarkColorTheme': 'Default Dark Modern',
        }
      : {
          'window.autoDetectColorScheme': false,
          'workbench.colorTheme': getEditorColorTheme(appTheme),
          'workbench.preferredLightColorTheme': 'Default Light Modern',
          'workbench.preferredDarkColorTheme': 'Default Dark Modern',
        };

  const settings = {
    ...existingSettings,
    ...EMBEDDED_EDITOR_DEFAULT_USER_SETTINGS,
    ...themeSettings,
  };

  if (appTheme === 'system') {
    delete settings['workbench.colorTheme'];
  }

  return settings;
}

function writeEmbeddedEditorUserProfile(
  userDataDir: string,
  seedSettings: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const userDir = join(userDataDir, 'User');
  mkdirSync(userDir, { recursive: true });

  const settingsPath = join(userDir, 'settings.json');
  const existingSettings = readJsonObject(settingsPath);
  if (!existingSettings) return;
  const settings = buildEmbeddedEditorUserSettings({ ...seedSettings, ...existingSettings });

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}

export function buildVscodeWebArgs(options: {
  port: number;
  userDataDir: string;
  workspaceFilePath: string;
  commitId?: string | null;
}): string[] {
  return [
    ...VSCODE_WEB_DISABLED_EXTENSIONS.flatMap((extensionId) => [
      '--disable-extension',
      extensionId,
    ]),
    'serve-web',
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
    '--without-connection-token',
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--server-data-dir',
    options.userDataDir,
    ...(options.commitId ? ['--commit-id', options.commitId] : []),
    '--default-workspace',
    options.workspaceFilePath,
  ];
}

export function buildDirectVscodeServerArgs(options: {
  port: number;
  userDataDir: string;
  extensionsDir: string;
  workspaceFilePath: string;
}): string[] {
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
    '--without-connection-token',
    '--accept-server-license-terms',
    '--disable-telemetry',
    '--server-data-dir',
    options.userDataDir,
    '--extensions-dir',
    options.extensionsDir,
    '--default-workspace',
    options.workspaceFilePath,
  ];
}

function getCachedVscodeServerCommand(commitId: string): string | null {
  const commandName = process.platform === 'win32' ? 'code-server.cmd' : 'code-server';
  const candidate = join(homedir(), '.vscode', 'cli', 'serve-web', commitId, 'bin', commandName);
  return existsSync(candidate) ? candidate : null;
}

export function getEmbeddedEditorStatus(): EmbeddedEditorStatus {
  return buildStatus();
}

export async function startEmbeddedEditor(workspaceId: string): Promise<EmbeddedEditorStatus> {
  const embeddedProvider = detectEmbeddedProvider();
  if (!embeddedProvider) {
    runtimeState.lastError = null;
    return buildStatus();
  }

  const workspace = getWorkspace(workspaceId);
  const workspaceSignature = buildWorkspaceRepoSignature(workspace);

  if (
    runtimeState.process &&
    runtimeState.workspaceId === workspaceId &&
    runtimeState.workspaceSignature === workspaceSignature &&
    runtimeState.url
  ) {
    const currentStatus = buildStatus();
    if (currentStatus.running) {
      return currentStatus;
    }
  }

  await stopEmbeddedEditor();
  await cleanupStaleEmbeddedEditorProcesses();
  cleanupStaleRuntimeDirs();

  runtimeState.outputTail = [];
  runtimeState.lastError = null;
  runtimeState.provider = embeddedProvider.provider;

  const runtimeDir = mkdtempSync(join(app.getPath('temp'), 'anvil-editor-'));
  runtimeState.runtimeDir = runtimeDir;
  const existingWorkspaceFilePath = findWorkspaceCodeWorkspaceFile(workspaceId);
  const workspaceFilePath = createWorkspaceSnapshotFile(
    workspaceId,
    runtimeDir,
    existingWorkspaceFilePath ?? undefined,
  );
  runtimeState.workspaceFilePath = workspaceFilePath;
  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const url = buildWorkbenchUrl(baseUrl, { type: 'workspace', path: workspaceFilePath });
  const profileDir = getEmbeddedEditorProfileDir(embeddedProvider.provider);
  const sharedUserDataDir = join(profileDir, 'user-data');
  const userDataDir = join(runtimeDir, 'user-data');
  const extensionsDir = join(profileDir, 'extensions');

  mkdirSync(sharedUserDataDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  const userVscodeSettings = readUserVscodeSettings();
  const sharedSettings =
    writeEmbeddedEditorUserProfile(sharedUserDataDir, userVscodeSettings) ?? {};
  writeEmbeddedEditorUserProfile(userDataDir, sharedSettings);

  let command = embeddedProvider.command;
  let args: string[];

  if (embeddedProvider.provider === 'vscode-web') {
    const commitId = await resolveVscodeCommitId(embeddedProvider.command);
    const cachedServerCommand = commitId ? getCachedVscodeServerCommand(commitId) : null;

    if (cachedServerCommand) {
      command = cachedServerCommand;
      args = buildDirectVscodeServerArgs({ port, userDataDir, extensionsDir, workspaceFilePath });
    } else {
      args = buildVscodeWebArgs({ port, userDataDir, workspaceFilePath, commitId });
    }
  } else {
    args = [
      '--bind-addr',
      `127.0.0.1:${port}`,
      '--auth',
      'none',
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      workspaceFilePath,
    ];
  }

  runtimeState.command = command;

  const child = spawn(command, args, {
    stdio: 'pipe',
    env: {
      ...process.env,
      BROWSER: 'none',
    },
  });

  runtimeState.process = child;
  runtimeState.workspaceId = workspaceId;
  runtimeState.workspaceSignature = workspaceSignature;
  runtimeState.url = url;
  runtimeState.startedAt = new Date().toISOString();

  child.stdout.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) pushOutputLine(line);
    }
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) pushOutputLine(line);
    }
  });

  child.once('error', (error) => {
    runtimeState.lastError = error.message;
  });

  child.once('exit', (code, signal) => {
    const wasIntentional = runtimeState.process === null;
    if (!wasIntentional) {
      runtimeState.lastError =
        runtimeState.outputTail.at(-1) ??
        `Embedded editor exited unexpectedly (${signal ?? code ?? 'unknown'}).`;
    }
    clearRuntimeAfterExit(workspaceId);
  });

  try {
    await waitForServerReady(baseUrl);
    return buildStatus();
  } catch (error) {
    runtimeState.lastError =
      error instanceof Error ? error.message : 'Embedded editor failed to start.';
    await stopEmbeddedEditor();
    return buildStatus();
  }
}

export async function stopEmbeddedEditor(): Promise<void> {
  const child = runtimeState.process;
  runtimeState.process = null;
  runtimeState.url = null;
  runtimeState.startedAt = null;
  runtimeState.workspaceId = null;
  runtimeState.workspaceSignature = null;
  runtimeState.provider = null;
  runtimeState.command = null;

  if (child) await terminateRuntimeProcess(child, { killGroup: false });

  removeRuntimeArtifacts();
}

export async function focusEmbeddedEditorTarget(
  target: EmbeddedEditorTarget,
  options?: { startServer?: boolean },
): Promise<EmbeddedEditorFocusResult> {
  if (options?.startServer && target.workspaceId) {
    await startEmbeddedEditor(target.workspaceId);
  }

  const resolvedTarget = resolveTarget(target);
  if (
    runtimeState.process &&
    runtimeState.url &&
    (!resolvedTarget.workspaceId || runtimeState.workspaceId === resolvedTarget.workspaceId) &&
    !resolvedTarget.absolutePath &&
    runtimeState.workspaceFilePath
  ) {
    runtimeState.url = buildWorkbenchUrl(runtimeState.url, {
      type: 'workspace',
      path: runtimeState.workspaceFilePath,
    });
  }
  const snapshot = buildSnapshot(resolvedTarget);

  return {
    status: buildStatus(),
    snapshot,
    resolvedTarget: {
      workspaceId: resolvedTarget.workspaceId,
      repoId: resolvedTarget.repo?.id,
      repoName: resolvedTarget.repo?.name,
      relativePath: resolvedTarget.relativePath,
      absolutePath: resolvedTarget.absolutePath,
      line: resolvedTarget.line,
      column: resolvedTarget.column,
      source: resolvedTarget.source,
      title: resolvedTarget.title,
      repoPath: resolvedTarget.repo?.path,
    },
  };
}

export async function openEmbeddedEditorExternally(target: EmbeddedEditorTarget): Promise<void> {
  const resolvedTarget = resolveTarget(target);
  const externalCommand = findFirstAvailableCommand(['code', 'codium', 'cursor']);

  if (externalCommand) {
    const launchPath =
      resolvedTarget.absolutePath ??
      resolvedTarget.repo?.path ??
      (target.workspaceId
        ? createWorkspaceSnapshotFile(
            target.workspaceId,
            mkdtempSync(join(app.getPath('temp'), 'anvil-editor-')),
            findWorkspaceCodeWorkspaceFile(target.workspaceId) ?? undefined,
          )
        : null);

    if (!launchPath) {
      throw new Error('No file or repository target could be resolved.');
    }

    const gotoArg =
      resolvedTarget.absolutePath && resolvedTarget.line
        ? `${launchPath}:${resolvedTarget.line}:${resolvedTarget.column ?? 1}`
        : launchPath;
    const args =
      resolvedTarget.absolutePath && resolvedTarget.line ? ['--goto', gotoArg] : [launchPath];

    const child = spawn(externalCommand, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  const fallbackPath = resolvedTarget.absolutePath ?? resolvedTarget.repo?.path;
  if (!fallbackPath) {
    throw new Error('No file or repository target could be resolved.');
  }

  const suffix = resolvedTarget.line ? `:${resolvedTarget.line}:${resolvedTarget.column ?? 1}` : '';
  await shell.openExternal(`vscode://file/${encodeURI(fallbackPath)}${suffix}`);
}

export async function cleanupEmbeddedEditor(): Promise<void> {
  await stopEmbeddedEditor();
}
