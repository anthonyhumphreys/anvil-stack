import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunWorktree,
  CodexEvent,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { detectCodexCli } from './codex-bridge.service.js';
import {
  appendAutomationRunEvent,
  completeAutomationRun,
  countEnabledAutomations,
  createAutomationRecord,
  createAutomationRun,
  deleteAutomationRecord,
  getAutomation,
  getAutomationRun,
  listAutomationRunEvents,
  listAutomationRuns,
  listAutomations,
  listDueAutomations,
  markStaleAutomationRunsFailed,
  updateAutomationRecord,
  updateAutomationRunWorktrees,
  updateAutomationScheduleState,
} from './automation-persistence.service.js';
import { getNextAutomationRunAt, validateAutomationCron } from './automation-cron.service.js';
import {
  getAutomationDaemonStatus,
  installAutomationDaemon,
  isAutomationDaemonMode,
  uninstallAutomationDaemon,
} from './automation-daemon.service.js';
import { commonParentDir, handleCodexServerLine, sendCodexJsonRpc } from './codex-protocol.service.js';
import { addWorktree, getFullStatus, removeWorktree } from './git.service.js';
import { notifyIfUnfocused } from './notification.service.js';
import { buildSystemPrompt, getPersonaById } from './persona.service.js';
import { getSettings } from './settings.service.js';

interface RepoRow {
  id: string;
  name: string;
  path: string;
}

interface PreparedWorktree {
  repoId: string;
  repoName: string;
  originalPath: string;
  branchName: string;
  path: string;
}

let schedulerTimer: NodeJS.Timeout | null = null;
const activeAutomationIds = new Set<string>();

function getRepoRows(repoIds: string[]): RepoRow[] {
  const db = getDb();
  const query = db.prepare('SELECT id, name, path FROM repos WHERE id = ?');
  const rows = repoIds
    .map((repoId) => query.get(repoId) as RepoRow | undefined)
    .filter((row): row is RepoRow => Boolean(row));
  return rows;
}

function validateAutomationInput(input: AutomationDefinitionInput): void {
  if (!input.name.trim()) throw new Error('Automation name is required.');
  if (!input.prompt.trim()) throw new Error('Automation prompt is required.');
  if (!input.personaId.trim()) throw new Error('Automation persona is required.');
  if (!getPersonaById(input.personaId)) {
    throw new Error(`Unknown persona: ${input.personaId}`);
  }
  if (input.repoIds.length === 0) {
    throw new Error('Select at least one repository for this automation.');
  }
  validateAutomationCron(input.scheduleCron, input.timezone);
}

function buildAutomationInstructions(
  automation: AutomationDefinition,
  worktrees: PreparedWorktree[],
): string {
  const repoLines = worktrees.map((worktree) => `- ${worktree.repoName}: ${worktree.path}`).join('\n');
  const repoWriteLine = automation.allowRepoWrite
    ? '- You may edit files inside the disposable worktree paths only.'
    : '- Do not edit files. Treat this as a read-only automation run.';
  const commandLine = automation.allowCommandRun
    ? '- You may run shell commands if they are necessary for the requested task.'
    : '- Do not run shell commands during this automation run.';

  return [
    '## Automation Mode',
    '- This run was triggered automatically by Anvil.',
    '- Operate only within the disposable worktrees listed below.',
    repoWriteLine,
    commandLine,
    '- Do not push branches, open pull requests, mutate remote systems, or create external tickets/docs/comments.',
    '- Summarise what you changed or learned at the end of the run.',
    '- If you hit a blocker, explain it clearly and stop.',
    '### Worktree Paths',
    repoLines,
  ].join('\n');
}

function sanitiseBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function buildWorktreePath(automationId: string, runId: string, repoName: string): string {
  const safeRepoName = sanitiseBranchName(repoName).replaceAll('/', '-') || 'repo';
  return path.join(
    app.getPath('userData'),
    'automation-worktrees',
    automationId,
    runId,
    safeRepoName,
  );
}

async function prepareWorktrees(
  automation: AutomationDefinition,
  runId: string,
  repoRows: RepoRow[],
): Promise<PreparedWorktree[]> {
  const prepared: PreparedWorktree[] = [];
  const baseBranch = sanitiseBranchName(automation.name) || 'automation';
  const suffix = runId.slice(0, 8);

  for (const repo of repoRows) {
    const safeRepoName = sanitiseBranchName(repo.name).replaceAll('/', '-') || 'repo';
    const branchName = `anvil/automation/${baseBranch}-${suffix}-${safeRepoName}`;
    const worktreePath = buildWorktreePath(automation.id, runId, repo.name);
    await addWorktree(repo.path, worktreePath, branchName);
    prepared.push({
      repoId: repo.id,
      repoName: repo.name,
      originalPath: repo.path,
      branchName,
      path: worktreePath,
    });
  }

  return prepared;
}

async function cleanupWorktrees(worktrees: PreparedWorktree[]): Promise<void> {
  for (const worktree of worktrees) {
    await removeWorktree(worktree.originalPath, worktree.path).catch(() => undefined);
    fs.rmSync(path.dirname(worktree.path), { recursive: true, force: true });
  }
}

async function getChangedFileCount(worktrees: PreparedWorktree[]): Promise<number> {
  let changedFileCount = 0;
  for (const worktree of worktrees) {
    const status = await getFullStatus(worktree.path).catch(() => null);
    changedFileCount += status?.files.length ?? 0;
  }
  return changedFileCount;
}

function serialiseEvent(runId: string, event: CodexEvent): AutomationRunEvent | null {
  switch (event.type) {
    case 'text':
      return event.text
        ? appendAutomationRunEvent(runId, 'text', event.text)
        : null;
    case 'thinking':
      return event.text
        ? appendAutomationRunEvent(runId, 'thinking', event.text)
        : null;
    case 'file_edit':
      return appendAutomationRunEvent(
        runId,
        'file_edit',
        event.diff || event.filePath || 'File edited',
        event.filePath ? { filePath: event.filePath } : undefined,
      );
    case 'command_exec':
      return appendAutomationRunEvent(runId, 'command_exec', event.output || event.command || '', {
        command: event.command,
        exitCode: event.exitCode,
      });
    case 'tool_call':
      return appendAutomationRunEvent(runId, 'tool_call', event.toolName || 'Tool call', {
        toolInput: event.toolInput,
      });
    case 'error':
      return appendAutomationRunEvent(runId, 'error', event.errorMessage || 'Unknown error');
    case 'status':
      return event.status
        ? appendAutomationRunEvent(runId, 'status', event.status)
        : null;
    default:
      return null;
  }
}

async function runCodexAutomation(
  automation: AutomationDefinition,
  runId: string,
  worktrees: PreparedWorktree[],
): Promise<{ assistantMessage: string }> {
  const codexStatus = await detectCodexCli();
  if (!codexStatus.installed) {
    throw new Error('Codex CLI is not installed, so automations cannot run.');
  }

  const settings = getSettings();
  const pathOverrides = Object.fromEntries(worktrees.map((worktree) => [worktree.repoId, worktree.path]));
  const systemPrompt = [
    buildSystemPrompt(automation.personaId, automation.repoIds, automation.workspaceId, pathOverrides),
    buildAutomationInstructions(automation, worktrees),
  ].join('\n\n');

  const cwd = commonParentDir(worktrees.map((worktree) => worktree.path));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (settings.llmProvider === 'openai' && settings.openaiApiKey) {
    env['OPENAI_API_KEY'] = settings.openaiApiKey;
  }

  const proc = spawn('codex', ['app-server'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    const state = { threadId: null, turnId: null, initialized: false };
    let buffer = '';
    let assistantMessage = '';
    let threadReady = false;
    let turnCompleted = false;

    const complete = (result: { assistantMessage: string } | null, error?: Error) => {
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners();
      if (proc.pid && !proc.killed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      }
      if (error) reject(error);
      else if (result) resolve(result);
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        handleCodexServerLine(state, line.trim(), {
          onThreadReady: () => {
            if (threadReady) return;
            threadReady = true;
            sendCodexJsonRpc(proc, 'turn/start', {
              threadId: state.threadId,
              input: [{ type: 'text', text: automation.prompt }],
            });
          },
          onTurnCompleted: () => {
            turnCompleted = true;
            complete({ assistantMessage: assistantMessage.trim() });
          },
          onEvent: (event) => {
            if (event.type === 'text' && event.text) {
              assistantMessage += event.text;
            }
            serialiseEvent(runId, event);
          },
          onLog: (message) => {
            appendAutomationRunEvent(runId, 'system', message);
          },
        });
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        appendAutomationRunEvent(runId, 'system', text);
      }
    });

    proc.on('error', (error) => {
      complete(null, new Error(`Failed to start Codex automation run: ${error.message}`));
    });

    proc.on('exit', (code, signal) => {
      if (turnCompleted) return;
      complete(
        null,
        new Error(`Codex automation exited before completion (code=${code}, signal=${signal}).`),
      );
    });

    sendCodexJsonRpc(proc, 'initialize', {
      clientInfo: { name: 'anvil-automation', version: '0.1.0' },
    });
    sendCodexJsonRpc(proc, 'thread/start', {
      cwd,
      developerInstructions: systemPrompt,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });
}

async function executeAutomationRun(run: AutomationRun): Promise<void> {
  const automation = getAutomation(run.automationId);
  if (!automation) {
    completeAutomationRun(run.id, {
      status: 'failed',
      errorMessage: 'Automation definition was deleted before the run started.',
      changedFileCount: 0,
      worktrees: [],
    });
    return;
  }

  if (activeAutomationIds.has(automation.id)) return;
  activeAutomationIds.add(automation.id);

  const repoRows = getRepoRows(automation.repoIds);
  let preparedWorktrees: PreparedWorktree[] = [];

  try {
    if (repoRows.length === 0) {
      throw new Error('No repositories are available for this automation run.');
    }

    appendAutomationRunEvent(run.id, 'status', 'running');
    preparedWorktrees = await prepareWorktrees(automation, run.id, repoRows);
    updateAutomationRunWorktrees(
      run.id,
      preparedWorktrees.map((worktree) => ({
        repoId: worktree.repoId,
        repoName: worktree.repoName,
        branchName: worktree.branchName,
        path: worktree.path,
        kept: true,
      })),
    );

    const { assistantMessage } = await runCodexAutomation(automation, run.id, preparedWorktrees);
    const changedFileCount = await getChangedFileCount(preparedWorktrees);
    const keepWorktrees = changedFileCount > 0;

    if (!keepWorktrees) {
      await cleanupWorktrees(preparedWorktrees);
    }

    const persistedWorktrees: AutomationRunWorktree[] = preparedWorktrees.map((worktree) => ({
      repoId: worktree.repoId,
      repoName: worktree.repoName,
      branchName: worktree.branchName,
      path: keepWorktrees ? worktree.path : undefined,
      kept: keepWorktrees,
    }));

    completeAutomationRun(run.id, {
      status: 'completed',
      assistantMessage: assistantMessage || 'Automation completed.',
      changedFileCount,
      worktrees: persistedWorktrees,
    });

    if (assistantMessage.trim() || changedFileCount > 0) {
      notifyIfUnfocused(
        'Automation Complete',
        `${automation.name} finished${changedFileCount > 0 ? ` with ${changedFileCount} changed files` : ''}.`,
      );
    }
  } catch (error) {
    const changedFileCount = await getChangedFileCount(preparedWorktrees).catch(() => 0);
    const persistedWorktrees: AutomationRunWorktree[] = preparedWorktrees.map((worktree) => ({
      repoId: worktree.repoId,
      repoName: worktree.repoName,
      branchName: worktree.branchName,
      path: worktree.path,
      kept: true,
    }));
    completeAutomationRun(run.id, {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
      changedFileCount,
      worktrees: persistedWorktrees,
    });
    notifyIfUnfocused(
      'Automation Failed',
      `${automation.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    activeAutomationIds.delete(automation.id);
  }
}

async function processDueAutomations(): Promise<void> {
  const due = listDueAutomations(new Date().toISOString());
  for (const automation of due) {
    try {
      const run = createAutomationRun(automation, 'schedule');
      updateAutomationScheduleState(automation.id, {
        nextRunAt: getNextAutomationRunAt(automation.scheduleCron, automation.timezone),
      });
      void executeAutomationRun(run);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already has an active run')) {
        continue;
      }
      updateAutomationScheduleState(automation.id, {
        lastRunStatus: 'failed',
        nextRunAt: getNextAutomationRunAt(automation.scheduleCron, automation.timezone),
      });
    }
  }
}

function startSchedulerLoop(): void {
  if (schedulerTimer) return;
  void processDueAutomations();
  schedulerTimer = setInterval(() => {
    void processDueAutomations();
  }, 30_000);
}

export function shutdownAutomationRuntime(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function initializeAutomationRuntime(): void {
  if (isAutomationDaemonMode()) {
    markStaleAutomationRunsFailed('Automation daemon restarted while a run was still active.');
    startSchedulerLoop();
  }
}

export function listWorkspaceAutomations(workspaceId: string): AutomationDefinition[] {
  return listAutomations(workspaceId);
}

export function getAutomationById(automationId: string): AutomationDefinition | null {
  return getAutomation(automationId);
}

export function createWorkspaceAutomation(
  workspaceId: string,
  input: AutomationDefinitionInput,
): AutomationDefinition {
  validateAutomationInput(input);
  const nextRunAt = input.enabled
    ? getNextAutomationRunAt(input.scheduleCron, input.timezone)
    : null;
  const automation = createAutomationRecord(workspaceId, input, nextRunAt);
  void reconcileAutomationDaemon();
  return automation;
}

export function updateWorkspaceAutomation(
  automationId: string,
  input: AutomationDefinitionInput,
): AutomationDefinition | null {
  validateAutomationInput(input);
  const nextRunAt = input.enabled
    ? getNextAutomationRunAt(input.scheduleCron, input.timezone)
    : null;
  const automation = updateAutomationRecord(automationId, input, nextRunAt);
  void reconcileAutomationDaemon();
  return automation;
}

export function deleteWorkspaceAutomation(automationId: string): void {
  deleteAutomationRecord(automationId);
  void reconcileAutomationDaemon();
}

export function runAutomationNow(automationId: string): AutomationRun {
  const automation = getAutomation(automationId);
  if (!automation) throw new Error(`Automation not found: ${automationId}`);

  const run = createAutomationRun(automation, 'manual');
  void executeAutomationRun(run);
  return run;
}

export function listRunsForAutomation(automationId: string): AutomationRun[] {
  return listAutomationRuns(automationId);
}

export function getAutomationRunById(runId: string): AutomationRun | null {
  return getAutomationRun(runId);
}

export function listRunEventsForRun(runId: string): AutomationRunEvent[] {
  return listAutomationRunEvents(runId);
}

export function getAutomationDaemonRuntimeStatus(): AutomationDaemonStatus {
  return getAutomationDaemonStatus();
}

export function reconcileAutomationDaemon(): AutomationDaemonStatus {
  if (isAutomationDaemonMode()) {
    return getAutomationDaemonStatus();
  }
  if (process.platform !== 'darwin') {
    return getAutomationDaemonStatus();
  }

  return countEnabledAutomations() > 0 ? installAutomationDaemon() : uninstallAutomationDaemon();
}
