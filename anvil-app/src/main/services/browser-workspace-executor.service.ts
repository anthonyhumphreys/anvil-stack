import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  BROWSER_WORKSPACE_MAX_CHAT_MESSAGE_CHARS,
  BROWSER_WORKSPACE_MAX_DIFF_BYTES,
  BROWSER_WORKSPACE_MAX_FILE_CONTENT_BYTES,
  BROWSER_WORKSPACE_MAX_FILE_READ_BYTES,
  BROWSER_WORKSPACE_MAX_HISTORY_BYTES,
  BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES,
  BROWSER_WORKSPACE_OPERATION_SCOPE,
} from '../../../cloud/contract/browser-workspace.js';
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandFailure,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceExecutionContext,
} from '../../../cloud/contract/browser-workspace.js';
import type {
  ChatMessage,
  CodexEvent,
  CodexInputResponse,
  CodexSession,
  RepoInfo,
  WorkflowRun,
  GitStatusResult,
} from '../../shared/types.js';
import {
  createChatSession,
  createChatThread,
  endChatSession,
  getChatThread,
  getChatThreadProviderBinding,
  listChatThreads,
  loadChatHistory,
  saveChatEntry,
  saveChatThreadGoal,
  saveChatThreadPlan,
} from './chat-persistence.service.js';
import { saveChatEvent } from './chat-evidence.service.js';
import {
  getCodexSession,
  claimSessionForBrowser,
  interruptTurn,
  listPendingApprovalRequests,
  listActiveCodexSessions,
  resolveApproval,
  resolveInputRequest,
  sendMessage,
  startSession,
  stopSession,
  subscribeToCodexEvents,
} from './codex-session.service.js';
import { getFullStatus, getFileDiff } from './git.service.js';
import {
  disposeSharedBrowserWorkspaceTools,
  getSharedBrowserWorkspaceTools,
  type BrowserWorkspaceRuntimeContext,
  type BrowserWorkspaceToolRequest,
} from './browser-workspace-tools.service.js';
import { getSettings } from './settings.service.js';
import { getWorkspace } from './workspace.service.js';
import {
  cancelWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflowTemplates,
  startWorkflowRun,
} from './workflow.service.js';

// Text can expand substantially when JSON-encoded (for example, each LF is
// represented by two bytes and other controls by six). Keep reads well below
// the shared result ceiling even in that worst case; writes do not echo the
// content and may use the larger content budget.
const MAX_FILE_READ_BYTES = Math.min(
  BROWSER_WORKSPACE_MAX_FILE_CONTENT_BYTES,
  BROWSER_WORKSPACE_MAX_FILE_READ_BYTES,
  Math.floor(BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES / 8),
);
const MAX_FILE_WRITE_BYTES = BROWSER_WORKSPACE_MAX_FILE_CONTENT_BYTES;
const MAX_HISTORY_ENTRIES = 200;
const MAX_HISTORY_BYTES = Math.min(
  BROWSER_WORKSPACE_MAX_HISTORY_BYTES,
  Math.floor(BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES / 2),
);
const MAX_DIFF_BYTES = Math.min(
  BROWSER_WORKSPACE_MAX_DIFF_BYTES,
  Math.floor(BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES / 2),
);
const MAX_FILE_LIST_ENTRIES = 2_000;
const MAX_FILE_LIST_DEPTH = 32;
const MAX_MESSAGE_CHARS = BROWSER_WORKSPACE_MAX_CHAT_MESSAGE_CHARS;
const SKIPPED_LIST_DIRECTORIES = new Set([
  '.cache',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

type BrowserCommandErrorCode = BrowserWorkspaceCommandFailure['code'];

class BrowserWorkspaceCommandError extends Error {
  readonly code: BrowserCommandErrorCode;
  readonly currentRevision?: string | null;

  constructor(code: BrowserCommandErrorCode, message: string, currentRevision?: string | null) {
    super(message);
    this.name = 'BrowserWorkspaceCommandError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

interface BrowserRepo extends Omit<RepoInfo, 'path'> {
  path: string;
}

interface BrowserFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size?: number;
}

interface BrowserAssistantSegment {
  id: string;
  itemId?: string;
  phase?: 'progress' | 'final';
  content: string;
  createdAt: string;
}

interface BrowserSessionOutput {
  threadId: string;
  repoId: string | null;
  segments: BrowserAssistantSegment[];
  activeLegacySegmentId?: string;
}

const browserOutputs = new Map<string, BrowserSessionOutput>();

/**
 * Provider events for browser-owned sessions are persisted here, before the
 * renderer receives them. This lets a browser reconnect without depending on
 * a live Electron window, while `persistedBy: 'main'` makes the renderer
 * skip its own duplicate writes.
 */
let stopCodexEventSubscription: (() => void) | undefined;

function ensureCodexEventSubscription(): void {
  if (!stopCodexEventSubscription) {
    stopCodexEventSubscription = subscribeToCodexEvents(handleCodexEvent);
  }
}

function handleCodexEvent({
  sessionId,
  appThreadId,
  event,
}: {
  sessionId: string;
  appThreadId?: string;
  event: CodexEvent;
}): void {
  if (event.persistedBy !== 'main') return;
  const session = getCodexSession(sessionId);
  const threadId = appThreadId ?? session?.appThreadId;
  if (!session || !threadId || session.origin !== 'browser') return;

  const timestamp = new Date().toISOString();
  const output =
    browserOutputs.get(sessionId) ??
    ({
      threadId,
      repoId: session.repoId ?? null,
      segments: [],
    } satisfies BrowserSessionOutput);
  browserOutputs.set(sessionId, output);

  try {
    if (shouldPersistEvidenceEvent(event)) {
      saveChatEvent(threadId, session.repoId ?? null, sessionId, event, timestamp);
    }

    if (event.type === 'plan_update' && event.plan) {
      saveChatThreadPlan(threadId, event.plan);
    } else if (event.type === 'goal_update' && event.goal) {
      saveChatThreadGoal(threadId, event.goal);
    } else if (event.type === 'goal_cleared') {
      saveChatThreadGoal(threadId, null);
    }

    if (event.type === 'text' && event.text) {
      appendBrowserAssistantSegment(output, event);
      persistBrowserAssistantSegments(sessionId, session, output, false);
    } else if (event.type !== 'text') {
      output.activeLegacySegmentId = undefined;
    }

    if (event.type === 'status' && event.status === 'complete') {
      persistBrowserAssistantSegments(sessionId, session, output, true);
      output.activeLegacySegmentId = undefined;
    }
  } catch (error) {
    console.error('[BrowserWorkspace] Failed to persist Codex event:', error);
  }
}

function shouldPersistEvidenceEvent(event: CodexEvent): boolean {
  if (event.type === 'command_exec') return !!event.command || !!event.output;
  if (event.type === 'thinking') return !!event.text;
  return (
    event.type === 'file_edit' ||
    event.type === 'tool_call' ||
    event.type === 'approval_request' ||
    event.type === 'input_request' ||
    event.type === 'request_resolved' ||
    event.type === 'plan_update' ||
    event.type === 'agent_ui_intent' ||
    event.type === 'agent_ui_intent_resolved' ||
    event.type === 'goal_update' ||
    event.type === 'goal_cleared' ||
    event.type === 'error'
  );
}

function appendBrowserAssistantSegment(output: BrowserSessionOutput, event: CodexEvent): void {
  const existing = event.itemId
    ? output.segments.find((segment) => segment.itemId === event.itemId)
    : output.activeLegacySegmentId
      ? output.segments.find((segment) => segment.id === output.activeLegacySegmentId)
      : undefined;

  if (existing) {
    existing.content += event.text ?? '';
    existing.phase = event.assistantPhase ?? existing.phase;
    return;
  }

  const segment: BrowserAssistantSegment = {
    id: `browser:${event.itemId ?? randomUUID()}`,
    itemId: event.itemId,
    phase: event.assistantPhase,
    content: event.text ?? '',
    createdAt: new Date().toISOString(),
  };
  output.segments.push(segment);
  if (!event.itemId) output.activeLegacySegmentId = segment.id;
}

function persistBrowserAssistantSegments(
  sessionId: string,
  session: CodexSession,
  output: BrowserSessionOutput,
  completed: boolean,
): void {
  for (const segment of output.segments) {
    const content = segment.content.trim();
    if (!content) continue;
    const phase = segment.phase ?? (completed ? 'final' : 'progress');
    saveChatEntry(output.threadId, session.repoId ?? output.repoId, sessionId, {
      // Keep one durable row per streamed segment; the final write upgrades
      // the progress row in place instead of leaving duplicate history.
      id: segment.id,
      role: phase === 'final' ? 'assistant' : 'system',
      content,
      timestamp: segment.createdAt,
      personaId: session.personaId,
      threadId: output.threadId,
      sessionId,
      event: {
        type: 'text',
        text: content,
        itemId: segment.itemId,
        assistantPhase: phase,
        persistedBy: 'main',
      },
    });
  }
}

export function disposeBrowserWorkspaceExecutor(): void {
  stopCodexEventSubscription?.();
  stopCodexEventSubscription = undefined;
  browserOutputs.clear();
  disposeSharedBrowserWorkspaceTools();
}

function failure(
  commandId: string,
  code: BrowserCommandErrorCode,
  message: string,
  currentRevision?: string | null,
): BrowserWorkspaceCommandResult {
  return {
    commandId,
    ok: false,
    error: { code, message, ...(currentRevision !== undefined ? { currentRevision } : {}) },
  };
}

function commandError(commandId: string, error: unknown): BrowserWorkspaceCommandResult {
  if (error instanceof BrowserWorkspaceCommandError) {
    return failure(commandId, error.code, error.message, error.currentRevision);
  }
  return failure(
    commandId,
    'invalid-command',
    error instanceof Error ? error.message : String(error),
  );
}

function hasScope(context: BrowserWorkspaceExecutionContext, scope: string): boolean {
  return context.scopes.includes(scope as (typeof context.scopes)[number]);
}

function requireScope(context: BrowserWorkspaceExecutionContext, scope: string): void {
  if (!Number.isFinite(context.expiresAt) || context.expiresAt <= Date.now()) {
    throw new BrowserWorkspaceCommandError('expired', 'The browser workspace grant has expired.');
  }
  if (!context.grantId.trim()) {
    throw new BrowserWorkspaceCommandError('forbidden', 'The browser workspace grant is missing.');
  }
  if (!hasScope(context, scope)) {
    throw new BrowserWorkspaceCommandError('forbidden', `This grant does not allow ${scope}.`);
  }
}

function loadWorkspace(context: BrowserWorkspaceExecutionContext) {
  try {
    return getWorkspace(context.workspaceId);
  } catch {
    throw new BrowserWorkspaceCommandError('not-found', 'Workspace not found.');
  }
}

function loadRepo(context: BrowserWorkspaceExecutionContext, repositoryId: string): BrowserRepo {
  if (!context.repoIds.includes(repositoryId)) {
    throw new BrowserWorkspaceCommandError('forbidden', 'Repository is outside the grant scope.');
  }
  const workspace = loadWorkspace(context);
  const repo = workspace.repos.find((candidate) => candidate.id === repositoryId);
  if (!repo) {
    throw new BrowserWorkspaceCommandError('forbidden', 'Repository is not in this workspace.');
  }
  return repo;
}

function sanitizeRepo(repo: BrowserRepo): Omit<BrowserRepo, 'path'> {
  return {
    id: repo.id,
    name: repo.name,
    remoteUrl: sanitizeRemoteUrl(repo.remoteUrl),
    defaultBranch: repo.defaultBranch,
    languages: repo.languages,
    status: repo.status,
    lastIndexed: repo.lastIndexed,
    fileCount: repo.fileCount,
    branchCount: repo.branchCount,
    lastCommitMessage: repo.lastCommitMessage,
    lastCommitDate: repo.lastCommitDate,
    indexMode: repo.indexMode,
    indexProvider: repo.indexProvider,
    indexWarnings: repo.indexWarnings,
  };
}

function sanitizeRemoteUrl(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined;
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Keep scp-style git remotes (git@host:org/repo.git) usable while
    // removing a possible authority credential from URL-like input.
    return remoteUrl.replace(/\/\/[^/@\s]+@/g, '//');
  }
}

function assertThread(context: BrowserWorkspaceExecutionContext, threadId: string) {
  const thread = getChatThread(threadId);
  if (!thread || thread.workspaceId !== context.workspaceId) {
    throw new BrowserWorkspaceCommandError('not-found', 'Chat thread not found.');
  }
  if ((thread.repoIds ?? []).some((repoId) => !context.repoIds.includes(repoId))) {
    throw new BrowserWorkspaceCommandError(
      'forbidden',
      'Chat thread references an unauthorized repository.',
    );
  }
  return thread;
}

function assertSession(context: BrowserWorkspaceExecutionContext, sessionId: string): CodexSession {
  const session = getCodexSession(sessionId);
  if (!session || session.workspaceId !== context.workspaceId) {
    throw new BrowserWorkspaceCommandError('not-found', 'Chat session not found.');
  }
  if (session.repoId && !context.repoIds.includes(session.repoId)) {
    throw new BrowserWorkspaceCommandError(
      'forbidden',
      'Chat session references an unauthorized repository.',
    );
  }
  if (session.appThreadId) assertThread(context, session.appThreadId);
  return session;
}

function assertWorkflow(context: BrowserWorkspaceExecutionContext, runId: string): WorkflowRun {
  const run = getWorkflowRun(runId);
  if (!run || run.workspaceId !== context.workspaceId) {
    throw new BrowserWorkspaceCommandError('not-found', 'Workflow run not found.');
  }
  if (run.repoIds.some((repoId) => !context.repoIds.includes(repoId))) {
    throw new BrowserWorkspaceCommandError(
      'forbidden',
      'Workflow run references an unauthorized repository.',
    );
  }
  return run;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isSecretPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    if (lower === '.git' || lower === '.npmrc' || lower === '.netrc' || lower === '.pypirc')
      return true;
    if (
      lower === '.env' ||
      (lower.startsWith('.env.') &&
        !['.env.example', '.env.sample', '.env.template'].includes(lower))
    )
      return true;
    if (lower.includes('credential') || lower.includes('secret')) return true;
    return (
      /\.(pem|key|p12|pfx|keystore|jks)$/i.test(lower) ||
      lower === 'id_rsa' ||
      lower === 'id_ed25519'
    );
  });
}

function resolveRepoRoot(repo: BrowserRepo): string {
  try {
    const root = realpathSync(repo.path);
    if (!lstatSync(root).isDirectory()) throw new Error('Repository path is not a directory.');
    return root;
  } catch {
    throw new BrowserWorkspaceCommandError('not-found', 'Repository checkout is unavailable.');
  }
}

function resolveRepoFile(
  repo: BrowserRepo,
  relativePath: string,
  options: { allowMissing: boolean },
): { root: string; absolute: string; relative: string } {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'Path is invalid.');
  }
  const normalisedInput = relativePath.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalisedInput) || normalisedInput.split('/').includes('..')) {
    throw new BrowserWorkspaceCommandError(
      'invalid-path',
      'Absolute and parent paths are not allowed.',
    );
  }
  const normalisedRelative = path.posix.normalize(normalisedInput === '.' ? '' : normalisedInput);
  const relative = normalisedRelative === '.' ? '' : normalisedRelative;
  if (isSecretPath(relative)) {
    throw new BrowserWorkspaceCommandError(
      'secret-path',
      'Secret and VCS metadata paths are not available.',
    );
  }
  const root = resolveRepoRoot(repo);
  const absolute = path.resolve(root, relative);
  if (!isPathWithin(root, absolute)) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'Path escapes the repository.');
  }
  assertNoSymlinkComponents(root, absolute);

  if (existsSync(absolute)) {
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new BrowserWorkspaceCommandError('invalid-path', 'Symbolic links are not available.');
      }
      const canonical = realpathSync(absolute);
      if (!isPathWithin(root, canonical)) {
        throw new BrowserWorkspaceCommandError('invalid-path', 'Path escapes the repository.');
      }
    } catch (error) {
      if (error instanceof BrowserWorkspaceCommandError) throw error;
      throw new BrowserWorkspaceCommandError('not-found', 'Path is unavailable.');
    }
  } else if (!options.allowMissing) {
    throw new BrowserWorkspaceCommandError('not-found', 'File not found.');
  }

  return { root, absolute, relative };
}

function assertNoSymlinkComponents(root: string, absolute: string): void {
  const relative = path.relative(root, absolute);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new BrowserWorkspaceCommandError('invalid-path', 'Symbolic links are not available.');
    }
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function currentFileRevision(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_FILE_WRITE_BYTES) {
      throw new BrowserWorkspaceCommandError(
        'conflict',
        `File exceeds the ${MAX_FILE_WRITE_BYTES}-byte write limit.`,
      );
    }
    return hashBytes(readFileSync(filePath));
  } catch (error) {
    // Preserve the explicit bounded-file error instead of converting it to a
    // missing revision during a compare-and-swap write.
    if (error instanceof BrowserWorkspaceCommandError) throw error;
    return null;
  }
}

function parentRealpathWithin(root: string, parent: string): string {
  let candidate = parent;
  while (!existsSync(candidate)) {
    const next = path.dirname(candidate);
    if (next === candidate)
      throw new BrowserWorkspaceCommandError('invalid-path', 'Parent path is unavailable.');
    candidate = next;
  }
  const canonical = realpathSync(candidate);
  if (!isPathWithin(root, canonical)) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'Path escapes the repository.');
  }
  return canonical;
}

function readBrowserFile(repo: BrowserRepo, relativePath: string, maxBytes?: number) {
  const resolved = resolveRepoFile(repo, relativePath, { allowMissing: false });
  const stat = lstatSync(resolved.absolute);
  if (!stat.isFile()) throw new BrowserWorkspaceCommandError('invalid-path', 'Path is not a file.');
  const limit = Math.min(Math.max(maxBytes ?? MAX_FILE_READ_BYTES, 1), MAX_FILE_READ_BYTES);
  if (stat.size > limit) {
    throw new BrowserWorkspaceCommandError(
      'conflict',
      `File exceeds the ${limit}-byte read limit.`,
    );
  }
  const bytes = readFileSync(resolved.absolute);
  const binary = bytes.includes(0);
  return {
    repositoryId: repo.id,
    relativePath: resolved.relative,
    revision: hashBytes(bytes),
    bytes: bytes.byteLength,
    binary,
    content: binary ? null : bytes.toString('utf8'),
  };
}

function listBrowserFiles(
  repo: BrowserRepo,
  relativePath = '',
  maxEntries = MAX_FILE_LIST_ENTRIES,
) {
  const resolved = resolveRepoFile(repo, relativePath, { allowMissing: false });
  if (!lstatSync(resolved.absolute).isDirectory()) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'List path is not a directory.');
  }
  const entries: BrowserFileEntry[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: resolved.absolute, relative: resolved.relative, depth: 0 },
  ];
  const limit = Math.min(Math.max(maxEntries, 1), MAX_FILE_LIST_ENTRIES);
  let truncated = false;
  while (queue.length > 0 && entries.length < limit) {
    const current = queue.shift()!;
    for (const entry of readdirSync(current.absolute, { withFileTypes: true })) {
      const childRelative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (isSecretPath(childRelative)) continue;
      if (entry.isDirectory() && SKIPPED_LIST_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const childAbsolute = path.join(current.absolute, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        entries.push({ path: childRelative, kind: 'directory' });
        if (current.depth < MAX_FILE_LIST_DEPTH && entries.length < limit) {
          queue.push({
            absolute: childAbsolute,
            relative: childRelative,
            depth: current.depth + 1,
          });
        } else {
          truncated = true;
        }
      } else if (entry.isFile()) {
        entries.push({ path: childRelative, kind: 'file', size: lstatSync(childAbsolute).size });
      }
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
    }
  }
  return {
    repositoryId: repo.id,
    relativePath: resolved.relative,
    entries,
    truncated: truncated || queue.length > 0,
  };
}

function writeBrowserFile(
  repo: BrowserRepo,
  relativePath: string,
  content: string,
  expectedRevision: string | null,
) {
  const contentBytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
  if (typeof content !== 'string' || contentBytes > MAX_FILE_WRITE_BYTES) {
    throw new BrowserWorkspaceCommandError(
      'conflict',
      `File exceeds the ${MAX_FILE_WRITE_BYTES}-byte write limit.`,
    );
  }
  const resolved = resolveRepoFile(repo, relativePath, { allowMissing: true });
  const current = currentFileRevision(resolved.absolute);
  if (current !== expectedRevision) {
    throw new BrowserWorkspaceCommandError(
      'stale-revision',
      'File changed since it was read.',
      current,
    );
  }
  if (existsSync(resolved.absolute) && !lstatSync(resolved.absolute).isFile()) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'Path is not a file.');
  }
  const existingMode = existsSync(resolved.absolute)
    ? lstatSync(resolved.absolute).mode & 0o777
    : 0o600;
  parentRealpathWithin(resolved.root, path.dirname(resolved.absolute));
  mkdirSync(path.dirname(resolved.absolute), { recursive: true });
  const parent = realpathSync(path.dirname(resolved.absolute));
  if (!isPathWithin(resolved.root, parent)) {
    throw new BrowserWorkspaceCommandError('invalid-path', 'Path escapes the repository.');
  }
  const tempPath = path.join(
    parent,
    `.${path.basename(resolved.absolute)}.anvil-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: existingMode });
    renameSync(tempPath, resolved.absolute);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  const bytes = Buffer.from(content, 'utf8');
  return {
    repositoryId: repo.id,
    relativePath: resolved.relative,
    revision: hashBytes(bytes),
    bytes: bytes.byteLength,
  };
}

function boundedChatHistory(threadId: string) {
  const messages = loadChatHistory(threadId);
  const selected: ChatMessage[] = [];
  let bytes = 0;
  let truncated = false;
  let firstSelectedIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const safeMessage = sanitizeChatMessage(message);
    const messageBytes = Buffer.byteLength(JSON.stringify(safeMessage), 'utf8');
    if (selected.length >= MAX_HISTORY_ENTRIES || bytes + messageBytes > MAX_HISTORY_BYTES) {
      truncated = true;
      break;
    }
    selected.unshift(safeMessage);
    firstSelectedIndex = index;
    bytes += messageBytes;
  }
  if (selected.length < messages.length) truncated = true;
  const omittedCount = firstSelectedIndex;
  return {
    messages: selected,
    truncated,
    omittedCount,
    /** Cursor for a follow-up request asking for messages before this row. */
    beforeMessageId: omittedCount > 0 ? (selected[0]?.id ?? null) : null,
    bytes,
  };
}

function sanitizeChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
      path: '',
      createdAt: attachment.createdAt,
    })),
    event: message.event
      ? {
          ...message.event,
          approvalCwd: undefined,
          approvalGrantRoot: undefined,
        }
      : undefined,
  };
}

function sanitizeWorkflowRun(run: WorkflowRun): Omit<WorkflowRun, 'executionPaths'> {
  const safeRun = { ...run } as WorkflowRun & { executionPaths?: WorkflowRun['executionPaths'] };
  delete safeRun.executionPaths;
  return safeRun;
}

function sanitizeApproval(approval: ReturnType<typeof listPendingApprovalRequests>[number]) {
  return {
    sessionId: approval.sessionId,
    requestKey: approval.requestKey,
    requestId: approval.requestId,
    kind: approval.kind,
    reason: approval.reason,
    command: approval.command,
    workspaceId: approval.workspaceId,
    workspaceName: approval.workspaceName,
    repoId: approval.repoId,
    repoName: approval.repoName,
    policy: approval.policy,
    createdAt: approval.createdAt,
  };
}

async function boundedGitDiff(repo: BrowserRepo, relativePath: string, staged: boolean) {
  const diff = await getFileDiff(repo.path, relativePath, staged);
  const bytes = Buffer.byteLength(JSON.stringify(diff), 'utf8');
  if (bytes <= MAX_DIFF_BYTES) return { ...diff, truncated: false, bytes };
  return {
    filePath: diff.filePath,
    oldContent: '',
    newContent: '',
    hunks: '',
    truncated: true,
    bytes,
    reason: `Diff exceeds the ${MAX_DIFF_BYTES}-byte browser result limit.`,
  };
}

function isSafeGitRelativePath(value: string): boolean {
  const normalised = value.replaceAll('\\', '/');
  return (
    !path.posix.isAbsolute(normalised) &&
    !normalised.split('/').includes('..') &&
    !isSecretPath(normalised)
  );
}

function boundedGitStatus(status: GitStatusResult) {
  const safeFiles = status.files.filter(
    (file) =>
      isSafeGitRelativePath(file.path) && (!file.oldPath || isSafeGitRelativePath(file.oldPath)),
  );
  const safeStatus = { ...status, files: safeFiles };
  const bytes = Buffer.byteLength(JSON.stringify(safeStatus), 'utf8');
  if (bytes <= MAX_DIFF_BYTES) return { ...safeStatus, truncated: false, bytes };

  const selected: GitStatusResult['files'] = [];
  for (const file of safeFiles) {
    const candidate = { ...safeStatus, files: [...selected, file] };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_DIFF_BYTES) break;
    selected.push(file);
  }
  let bounded = {
    ...safeStatus,
    files: selected,
    truncated: true,
    bytes,
    reason: `Status exceeds the ${MAX_DIFF_BYTES}-byte browser result limit.`,
  };
  while (
    Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_DIFF_BYTES &&
    selected.length > 0
  ) {
    selected.pop();
    bounded = {
      ...safeStatus,
      files: selected,
      truncated: true,
      bytes,
      reason: `Status exceeds the ${MAX_DIFF_BYTES}-byte browser result limit.`,
    };
  }
  return bounded;
}

function activeSessionForThread(
  context: BrowserWorkspaceExecutionContext,
  threadId: string,
): CodexSession | null {
  return (
    listActiveCodexSessions().find(
      (session) => session.appThreadId === threadId && session.workspaceId === context.workspaceId,
    ) ?? null
  );
}

function sessionRepoPaths(context: BrowserWorkspaceExecutionContext, threadRepoIds: string[]) {
  const workspace = loadWorkspace(context);
  return threadRepoIds.map((repoId) => {
    const repo = workspace.repos.find((candidate) => candidate.id === repoId);
    if (!repo || !context.repoIds.includes(repoId)) {
      throw new BrowserWorkspaceCommandError(
        'forbidden',
        'Chat thread references an unauthorized repository.',
      );
    }
    return repo;
  });
}

async function startBrowserSession(
  context: BrowserWorkspaceExecutionContext,
  threadId: string,
  requestedRepositoryId?: string,
) {
  const thread = assertThread(context, threadId);
  if (requestedRepositoryId && !thread.repoIds.includes(requestedRepositoryId)) {
    throw new BrowserWorkspaceCommandError(
      'forbidden',
      'Requested repository is not in the chat thread.',
    );
  }
  if (getSettings().codexMode === 'full-access') {
    throw new BrowserWorkspaceCommandError(
      'forbidden',
      'Browser sessions cannot start while Desktop Codex is configured for full access.',
    );
  }
  const existing = activeSessionForThread(context, threadId);
  if (existing) return claimSessionForBrowser(existing.id) ?? existing;
  const repos = sessionRepoPaths(context, thread.repoIds);
  const binding = getChatThreadProviderBinding(threadId);
  const session = await startSession(
    repos.map((repo) => repo.path),
    repos.map((repo) => repo.id),
    thread.personaId,
    {
      origin: 'browser',
      threadId,
      provider: binding?.provider,
      providerThreadId: binding?.providerThreadId,
      workspace: { workspaceId: context.workspaceId },
    },
  );
  createChatSession(
    threadId,
    thread.activeRepoId ?? thread.repoIds[0] ?? null,
    thread.personaId,
    session.id,
    session.providerThreadId ?? null,
    session.provider,
  );
  return session;
}

function assertApproval(
  context: BrowserWorkspaceExecutionContext,
  sessionId: string,
  requestKey: string,
) {
  const session = assertSession(context, sessionId);
  const approval = listPendingApprovalRequests().find(
    (candidate) => candidate.sessionId === sessionId && candidate.requestKey === requestKey,
  );
  if (!approval) throw new BrowserWorkspaceCommandError('not-found', 'Approval request not found.');
  return { session, approval };
}

/**
 * Terminal and preview commands execute against the grant-bound tools
 * service, which re-checks scope, expiry, repository binding, and per-grant
 * limits before touching a PTY or the preview capture.
 */
function browserWorkspaceToolRequest(
  command: BrowserWorkspaceCommand,
  context: BrowserWorkspaceExecutionContext,
): BrowserWorkspaceToolRequest {
  const runtimeContext: BrowserWorkspaceRuntimeContext = {
    grantId: context.grantId,
    workspaceId: context.workspaceId,
    repoIds: context.repoIds,
    scopes: context.scopes,
    expiresAt: context.expiresAt,
  };
  switch (command.operation) {
    case 'terminal.create':
      return { type: 'terminal.create', context: runtimeContext, repoId: command.repositoryId };
    case 'terminal.read':
      return {
        type: 'terminal.read',
        context: runtimeContext,
        repoId: command.repositoryId,
        terminalId: command.terminalId,
        afterSequence: command.afterSequence,
      };
    case 'terminal.write':
      return {
        type: 'terminal.write',
        context: runtimeContext,
        repoId: command.repositoryId,
        terminalId: command.terminalId,
        data: command.data,
      };
    case 'terminal.resize':
      return {
        type: 'terminal.resize',
        context: runtimeContext,
        repoId: command.repositoryId,
        terminalId: command.terminalId,
        cols: command.cols,
        rows: command.rows,
      };
    case 'terminal.close':
      return {
        type: 'terminal.close',
        context: runtimeContext,
        repoId: command.repositoryId,
        terminalId: command.terminalId,
      };
    case 'preview.screenshot':
      return {
        type: 'preview.screenshot',
        context: runtimeContext,
        repoId: command.repositoryId,
        refresh: command.refresh,
      };
    default:
      throw new BrowserWorkspaceCommandError(
        'unsupported',
        'Browser workspace operation is not supported.',
      );
  }
}

async function executeBrowserWorkspaceCommandInternal(
  command: BrowserWorkspaceCommand,
  context: BrowserWorkspaceExecutionContext,
): Promise<BrowserWorkspaceCommandResult> {
  try {
    ensureCodexEventSubscription();
    switch (command.operation) {
      case 'workspace.get': {
        requireScope(context, 'workspace-read');
        const workspace = loadWorkspace(context);
        return {
          commandId: context.commandId,
          ok: true,
          data: {
            id: workspace.id,
            name: workspace.name,
            definitionState: workspace.definitionState,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
            repos: workspace.repos
              .filter((repo) => context.repoIds.includes(repo.id))
              .map(sanitizeRepo),
          },
        };
      }
      case 'repo.list': {
        requireScope(context, 'workspace-read');
        const workspace = loadWorkspace(context);
        return {
          commandId: context.commandId,
          ok: true,
          data: workspace.repos
            .filter((repo) => context.repoIds.includes(repo.id))
            .map(sanitizeRepo),
        };
      }
      case 'file.list': {
        requireScope(context, 'workspace-read');
        return {
          commandId: context.commandId,
          ok: true,
          data: listBrowserFiles(
            loadRepo(context, command.repositoryId),
            command.relativePath,
            command.maxEntries,
          ),
        };
      }
      case 'file.read': {
        requireScope(context, 'workspace-read');
        return {
          commandId: context.commandId,
          ok: true,
          data: readBrowserFile(
            loadRepo(context, command.repositoryId),
            command.relativePath,
            command.maxBytes,
          ),
        };
      }
      case 'file.write': {
        requireScope(context, 'workspace-write');
        return {
          commandId: context.commandId,
          ok: true,
          data: writeBrowserFile(
            loadRepo(context, command.repositoryId),
            command.relativePath,
            command.content,
            command.expectedRevision,
          ),
        };
      }
      case 'chat.thread.list': {
        requireScope(context, 'workspace-read');
        return {
          commandId: context.commandId,
          ok: true,
          data: listChatThreads(context.workspaceId, command.personaId).filter((thread) =>
            (thread.repoIds ?? []).every((repoId) => context.repoIds.includes(repoId)),
          ),
        };
      }
      case 'chat.create': {
        requireScope(context, 'submit-task');
        const repoIds = command.repositoryIds ?? [...context.repoIds];
        repoIds.forEach((repoId) => loadRepo(context, repoId));
        if (command.activeRepositoryId && !repoIds.includes(command.activeRepositoryId)) {
          throw new BrowserWorkspaceCommandError(
            'forbidden',
            'Active repository is outside the chat repository selection.',
          );
        }
        const thread = createChatThread({
          workspaceId: context.workspaceId,
          personaId: command.personaId.trim() || 'coder',
          title: command.title,
          repoIds,
          activeRepoId: command.activeRepositoryId ?? repoIds[0] ?? null,
        });
        return { commandId: context.commandId, ok: true, data: thread };
      }
      case 'chat.history.read': {
        requireScope(context, 'workspace-read');
        assertThread(context, command.threadId);
        return {
          commandId: context.commandId,
          ok: true,
          data: boundedChatHistory(command.threadId),
        };
      }
      case 'chat.session.start': {
        requireScope(context, 'submit-task');
        return {
          commandId: context.commandId,
          ok: true,
          data: await startBrowserSession(context, command.threadId, command.repositoryId),
        };
      }
      case 'chat.send': {
        requireScope(context, 'submit-task');
        if (!command.message.trim() || command.message.length > MAX_MESSAGE_CHARS) {
          throw new BrowserWorkspaceCommandError(
            'invalid-command',
            'Message is empty or too large.',
          );
        }
        const thread = assertThread(context, command.threadId);
        const session = assertSession(context, command.sessionId);
        if (session.origin !== 'browser' || getSettings().codexMode === 'full-access') {
          throw new BrowserWorkspaceCommandError(
            'forbidden',
            'This session is not owned by a browser workspace grant.',
          );
        }
        if (session.appThreadId !== thread.id) {
          throw new BrowserWorkspaceCommandError(
            'forbidden',
            'Session does not belong to the chat thread.',
          );
        }
        const timestamp = new Date().toISOString();
        const message: ChatMessage = {
          id: `browser:${context.commandId}`,
          role: 'user',
          content: command.message.trim(),
          timestamp,
          personaId: thread.personaId,
          sessionId: session.id,
          threadId: thread.id,
          repoContext: session.repoId,
        };
        saveChatEntry(thread.id, session.repoId ?? null, session.id, message);
        await sendMessage(session.id, message.content);
        return { commandId: context.commandId, ok: true, data: { sessionId: session.id } };
      }
      case 'chat.status': {
        requireScope(context, 'workspace-read');
        const session = assertSession(context, command.sessionId);
        return { commandId: context.commandId, ok: true, data: session };
      }
      case 'chat.cancel': {
        requireScope(context, 'submit-task');
        const session = assertSession(context, command.sessionId);
        if (command.mode === 'stop') {
          stopSession(session.id);
          endChatSession(session.id);
        } else {
          interruptTurn(session.id);
        }
        return {
          commandId: context.commandId,
          ok: true,
          data: { sessionId: session.id, mode: command.mode ?? 'interrupt' },
        };
      }
      case 'chat.approvals.list': {
        requireScope(context, 'workspace-read');
        const approvals = listPendingApprovalRequests().filter((approval) => {
          try {
            assertSession(context, approval.sessionId);
            return true;
          } catch {
            return false;
          }
        });
        return {
          commandId: context.commandId,
          ok: true,
          data: approvals.map(sanitizeApproval),
        };
      }
      case 'chat.approve': {
        requireScope(context, 'approve-action');
        const { session, approval } = assertApproval(
          context,
          command.sessionId,
          command.requestKey,
        );
        resolveApproval(session.id, approval.requestId, command.decision, command.optionId);
        return {
          commandId: context.commandId,
          ok: true,
          data: { sessionId: session.id, requestKey: approval.requestKey },
        };
      }
      case 'chat.input': {
        requireScope(context, 'approve-action');
        const session = assertSession(context, command.sessionId);
        resolveInputRequest(session.id, command.requestId, command.response as CodexInputResponse);
        return {
          commandId: context.commandId,
          ok: true,
          data: { sessionId: session.id, requestId: command.requestId },
        };
      }
      case 'git.status': {
        requireScope(context, 'workspace-read');
        const repo = loadRepo(context, command.repositoryId);
        return {
          commandId: context.commandId,
          ok: true,
          data: boundedGitStatus(await getFullStatus(repo.path)),
        };
      }
      case 'git.diff': {
        requireScope(context, 'workspace-read');
        const repo = loadRepo(context, command.repositoryId);
        resolveRepoFile(repo, command.relativePath, { allowMissing: true });
        return {
          commandId: context.commandId,
          ok: true,
          data: await boundedGitDiff(repo, command.relativePath, command.staged ?? false),
        };
      }
      case 'workflow.list': {
        requireScope(context, 'workspace-read');
        return {
          commandId: context.commandId,
          ok: true,
          data: {
            templates: listWorkflowTemplates(),
            runs: listWorkflowRuns(context.workspaceId)
              .filter((run) => run.repoIds.every((id) => context.repoIds.includes(id)))
              .map(sanitizeWorkflowRun),
          },
        };
      }
      case 'workflow.get': {
        requireScope(context, 'workspace-read');
        return {
          commandId: context.commandId,
          ok: true,
          data: sanitizeWorkflowRun(assertWorkflow(context, command.runId)),
        };
      }
      case 'workflow.start': {
        requireScope(context, 'submit-task');
        command.repositoryIds.forEach((repoId) => loadRepo(context, repoId));
        const run = startWorkflowRun({
          templateId: command.templateId,
          workspaceId: context.workspaceId,
          repoIds: command.repositoryIds,
          kickoff: command.kickoff,
        });
        return {
          commandId: context.commandId,
          ok: true,
          data: sanitizeWorkflowRun(run),
        };
      }
      case 'workflow.cancel': {
        requireScope(context, 'submit-task');
        const run = assertWorkflow(context, command.runId);
        const cancelled = cancelWorkflowRun(run.id);
        return {
          commandId: context.commandId,
          ok: true,
          data: cancelled ? sanitizeWorkflowRun(cancelled) : null,
        };
      }
      case 'terminal.create':
      case 'terminal.read':
      case 'terminal.write':
      case 'terminal.resize':
      case 'terminal.close':
      case 'preview.screenshot': {
        requireScope(context, BROWSER_WORKSPACE_OPERATION_SCOPE[command.operation]);
        return {
          commandId: context.commandId,
          ok: true,
          data: await getSharedBrowserWorkspaceTools().execute(
            browserWorkspaceToolRequest(command, context),
          ),
        };
      }
      default:
        throw new BrowserWorkspaceCommandError(
          'unsupported',
          'Browser workspace operation is not supported.',
        );
    }
  } catch (error) {
    return commandError(context.commandId, error);
  }
}

export async function executeBrowserWorkspaceCommand(
  command: BrowserWorkspaceCommand,
  context: BrowserWorkspaceExecutionContext,
): Promise<BrowserWorkspaceCommandResult> {
  const result = await executeBrowserWorkspaceCommandInternal(command, context);
  if (
    Buffer.byteLength(JSON.stringify(result), 'utf8') > BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES
  ) {
    return failure(
      context.commandId,
      'result-too-large',
      `The browser workspace result exceeds the ${BROWSER_WORKSPACE_MAX_RESULT_PLAINTEXT_BYTES}-byte limit.`,
    );
  }
  return result;
}
