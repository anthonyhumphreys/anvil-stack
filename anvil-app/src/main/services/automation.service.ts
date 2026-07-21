import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AutomationDaemonStatus,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationLoopConfig,
  AutomationRun,
  AutomationRunEvent,
  AutomationTriageItem,
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
  listAutomationTriageItems,
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
import {
  commonParentDir,
  handleCodexServerLine,
  sendCodexJsonRpc,
} from './codex-protocol.service.js';
import { addWorktree, getFullStatus, removeWorktree } from './git.service.js';
import { notifyIfUnfocused } from './notification.service.js';
import { buildSystemPrompt, getPersonaById } from './persona.service.js';
import { getSettings } from './settings.service.js';
import { resolvePersonaCodexPolicy } from './codex-session.service.js';

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
  if (input.loopConfig?.enabled) {
    const members = input.loopConfig.memberPersonaIds;
    if (members.length === 0) {
      throw new Error('Select at least one loop member.');
    }
    for (const memberPersonaId of members) {
      if (!getPersonaById(memberPersonaId)) {
        throw new Error(`Unknown loop persona: ${memberPersonaId}`);
      }
    }
    if (!Number.isInteger(input.loopConfig.maxIterations) || input.loopConfig.maxIterations < 1) {
      throw new Error('Loop max iterations must be at least 1.');
    }
    if (input.loopConfig.maxIterations > 8) {
      throw new Error('Loop max iterations cannot exceed 8.');
    }
  }
  if (input.repoIds.length === 0) {
    throw new Error('Select at least one repository for this automation.');
  }
  validateAutomationCron(input.scheduleCron, input.timezone);
}

function getActiveLoopConfig(automation: AutomationDefinition): AutomationLoopConfig | null {
  if (!automation.loopConfig?.enabled) return null;
  if (automation.loopConfig.memberPersonaIds.length === 0) return null;
  return {
    ...automation.loopConfig,
    separateThreads: true,
    maxIterations: Math.min(Math.max(automation.loopConfig.maxIterations, 1), 8),
  };
}

function buildAutomationInstructions(
  automation: AutomationDefinition,
  worktrees: PreparedWorktree[],
): string {
  const repoLines = worktrees
    .map((worktree) => `- ${worktree.repoName}: ${worktree.path}`)
    .join('\n');
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

function buildLoopMemberPrompt(
  automation: AutomationDefinition,
  loopConfig: AutomationLoopConfig,
  personaId: string,
  iteration: number,
  previousOutputs: string[],
): string {
  const persona = getPersonaById(personaId);
  const loopLines = [
    `Loop mode: ${loopConfig.mode}.`,
    `Loop member: ${persona?.name ?? personaId} (${personaId}).`,
    `Iteration: ${iteration + 1} of ${loopConfig.maxIterations}.`,
    `Stop condition: ${loopConfig.stopCondition.trim() || 'Stop when the requested automation outcome is complete or blocked.'}`,
    'This persona turn is intentionally running in its own Codex thread.',
  ];

  if (loopConfig.mode === 'sequence') {
    loopLines.push(
      'Act as the next member in the configured sequence. Use previous member notes as handoff context.',
    );
  } else {
    loopLines.push(
      'Use the orchestrator plan and previous thread notes to decide whether your persona is needed for this turn. If not, say so briefly and do not make changes.',
      'If you do act, explain why this persona was needed before doing the work.',
    );
  }

  const handoff =
    previousOutputs.length > 0
      ? previousOutputs
          .map((output, index) => `### Previous thread ${index + 1}\n${output}`)
          .join('\n\n')
      : 'No previous loop thread output yet.';

  return [
    '## Loop Run',
    ...loopLines.map((line) => `- ${line}`),
    '',
    '## Automation Goal',
    automation.prompt,
    '',
    '## Previous Thread Handoff',
    handoff,
  ].join('\n');
}

function buildLoopOrchestratorPrompt(
  automation: AutomationDefinition,
  loopConfig: AutomationLoopConfig,
): string {
  const memberLines = loopConfig.memberPersonaIds.map((personaId) => {
    const persona = getPersonaById(personaId);
    return `- ${persona?.name ?? personaId} (${personaId}): ${persona?.description ?? 'No description available.'}`;
  });

  return [
    '## Dynamic Loop Orchestrator',
    'You are designing the thread loop for this automation run before specialist persona threads execute.',
    'Do not edit files in this orchestrator turn.',
    'Create a concise execution plan shaped around the actual work, not a generic checklist.',
    'Call out which specialist personas are likely needed, what each should inspect or change, and when the loop should stop.',
    'Prefer fewer thread turns when the work is small. Token bonfires are not a personality.',
    '',
    '## Automation Goal',
    automation.prompt,
    '',
    '## Eligible Specialist Personas',
    memberLines.join('\n') || '- No specialist personas selected.',
    '',
    '## Stop Condition',
    loopConfig.stopCondition.trim() ||
      'Stop when the requested automation outcome is complete or blocked.',
  ].join('\n');
}

function getLoopMemberForTurn(loopConfig: AutomationLoopConfig, turnIndex: number): string {
  const memberIndex =
    loopConfig.mode === 'sequence' ? turnIndex % loopConfig.memberPersonaIds.length : turnIndex;
  return loopConfig.memberPersonaIds[memberIndex];
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
      return event.text ? appendAutomationRunEvent(runId, 'text', event.text) : null;
    case 'thinking':
      return event.text ? appendAutomationRunEvent(runId, 'thinking', event.text) : null;
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
      return event.status ? appendAutomationRunEvent(runId, 'status', event.status) : null;
    default:
      return null;
  }
}

async function runCodexAutomation(
  automation: AutomationDefinition,
  runId: string,
  worktrees: PreparedWorktree[],
  options?: {
    personaId?: string;
    prompt?: string;
    extraInstructions?: string;
    eventMetadata?: Record<string, unknown>;
  },
): Promise<{ assistantMessage: string }> {
  const codexStatus = await detectCodexCli();
  if (!codexStatus.installed) {
    throw new Error('Codex CLI is not installed, so automations cannot run.');
  }

  const settings = getSettings();
  const pathOverrides = Object.fromEntries(
    worktrees.map((worktree) => [worktree.repoId, worktree.path]),
  );
  const personaId = options?.personaId ?? automation.personaId;
  const systemPrompt = [
    buildSystemPrompt(personaId, automation.repoIds, automation.workspaceId, pathOverrides),
    buildAutomationInstructions(automation, worktrees),
    options?.extraInstructions,
  ]
    .filter(Boolean)
    .join('\n\n');
  const prompt = options?.prompt ?? automation.prompt;

  if (options?.eventMetadata) {
    appendAutomationRunEvent(
      runId,
      'system',
      `Starting ${personaId} loop thread.`,
      options.eventMetadata,
    );
  }

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
              input: [{ type: 'text', text: prompt }],
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
    const personaPolicy = resolvePersonaCodexPolicy(settings.codexMode ?? 'on-request', personaId);
    sendCodexJsonRpc(proc, 'thread/start', {
      cwd,
      developerInstructions: systemPrompt,
      approvalPolicy: personaPolicy.approvalPolicy,
      sandbox: personaPolicy.sandbox,
    });
  });
}

async function runLoopAutomation(
  automation: AutomationDefinition,
  runId: string,
  worktrees: PreparedWorktree[],
  loopConfig: AutomationLoopConfig,
): Promise<{ assistantMessage: string }> {
  const previousOutputs: string[] = [];
  const summaries: string[] = [];
  const maxTurns = Math.min(loopConfig.maxIterations, 8);
  const memberTurns =
    loopConfig.mode === 'sequence'
      ? maxTurns
      : Math.max(0, Math.min(loopConfig.memberPersonaIds.length, maxTurns - 1));

  appendAutomationRunEvent(
    runId,
    'system',
    `Starting ${loopConfig.mode} loop with up to ${maxTurns} thread turn${maxTurns === 1 ? '' : 's'}.`,
    {
      loopMode: loopConfig.mode,
      memberPersonaIds: loopConfig.memberPersonaIds,
      maxTurns,
    },
  );

  if (loopConfig.mode === 'dynamic') {
    const orchestratorPersona = getPersonaById(automation.personaId);
    const { assistantMessage } = await runCodexAutomation(automation, runId, worktrees, {
      personaId: automation.personaId,
      prompt: buildLoopOrchestratorPrompt(automation, loopConfig),
      eventMetadata: {
        loopMode: loopConfig.mode,
        loopMemberIndex: 0,
        personaId: automation.personaId,
        role: 'orchestrator',
      },
      extraInstructions: [
        '## Orchestrator Thread Discipline',
        '- Shape the loop for the current work and hand off clear instructions to specialist threads.',
        '- Do not perform implementation in this thread.',
        '- Keep the plan compact enough for the next threads to use.',
      ].join('\n'),
    });

    const label = `${orchestratorPersona?.name ?? automation.personaId} Orchestrator`;
    const summary = assistantMessage || `${label} completed without a final message.`;
    previousOutputs.push(`Persona: ${label}\n${summary}`);
    summaries.push(`## ${label}\n${summary}`);
    appendAutomationRunEvent(runId, 'system', `Completed ${label} loop thread.`, {
      loopMode: loopConfig.mode,
      loopMemberIndex: 0,
      personaId: automation.personaId,
      role: 'orchestrator',
    });
  }

  for (let index = 0; index < memberTurns; index += 1) {
    const personaId = getLoopMemberForTurn(loopConfig, index);
    const persona = getPersonaById(personaId);
    const turnIndex = loopConfig.mode === 'dynamic' ? index + 1 : index;
    const prompt = buildLoopMemberPrompt(
      automation,
      loopConfig,
      personaId,
      turnIndex,
      previousOutputs,
    );
    const metadata = {
      loopMode: loopConfig.mode,
      loopMemberIndex: turnIndex,
      personaId,
      role: 'member',
    };

    const { assistantMessage } = await runCodexAutomation(automation, runId, worktrees, {
      personaId,
      prompt,
      eventMetadata: metadata,
      extraInstructions: [
        '## Loop Thread Discipline',
        '- Treat this as one member turn in a larger automation loop.',
        '- Keep your final response concise enough for the next persona to use as handoff context.',
        '- Do not ask the user for input during a loop run; stop with a clear blocker instead.',
      ].join('\n'),
    });

    const label = persona?.name ?? personaId;
    const summary = assistantMessage || `${label} completed without a final message.`;
    previousOutputs.push(`Persona: ${label}\n${summary}`);
    summaries.push(`## ${label}\n${summary}`);
    appendAutomationRunEvent(runId, 'system', `Completed ${label} loop thread.`, metadata);
  }

  return {
    assistantMessage: summaries.join('\n\n') || 'Loop automation completed.',
  };
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

    const loopConfig = getActiveLoopConfig(automation);
    const { assistantMessage } = loopConfig
      ? await runLoopAutomation(automation, run.id, preparedWorktrees, loopConfig)
      : await runCodexAutomation(automation, run.id, preparedWorktrees);
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

export function listWorkspaceAutomationTriage(workspaceId: string): AutomationTriageItem[] {
  return listAutomationTriageItems(workspaceId);
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
