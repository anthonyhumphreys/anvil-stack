import { writeGatewayCodexCatalog } from './llm-gateway-runtime.service.js';
import {
  automationAccessMode,
  automationGit,
  isPrFeedbackEvent,
  matchesRepairTarget,
  prepareAutomationRepairTarget,
  remotePublishingAllowed,
  remotePublishingInstructions,
  repairTargetInstructions,
  type AutomationRepairTarget,
} from './automation-remote-publishing.service.js';
import { previewBuild } from '../../shared/preview-build.js';
import { app } from 'electron';
import {
  buildCodexWorkflowArgs,
  getWorkflowTemplate,
  startWorkflowRun,
  waitForWorkflowRun,
} from './workflow.service.js';
import { isAcpAgentProvider, type AcpAgentProvider } from '../../shared/agent-providers.js';
import { providerSpawnEnv } from './agent-spawn-env.js';
import { acpProviderLabel, buildAcpPrintInvocation } from './acp-print-cli.js';
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
  CodexMode,
  WatchtowerEvent,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import {
  appendAutomationRunEvent,
  completeAutomationRun,
  countEnabledAutomations,
  createAutomationRecord,
  createAutomationRun,
  claimPendingWatchtowerEvent,
  deleteAutomationRecord,
  enqueueWatchtowerEvent,
  getAutomation,
  getAutomationRun,
  listExternalWatchtowerAutomations,
  listPendingWatchtowerEvents,
  listAutomationRunEvents,
  listAutomationRuns,
  listAutomationTriageItems,
  listAutomations,
  listDueAutomations,
  listWatchtowerAutomations,
  markStaleAutomationRunsFailed,
  updateAutomationRecord,
  updateAutomationRunWorktrees,
  updateAutomationScheduleState,
  updateWatchtowerState,
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
import { resolveLlmGatewayModelConfig } from './llm-gateway.service.js';
import {
  buildCodexProcessEnvironment,
  resolvePersonaCodexPolicy,
} from './codex-session.service.js';
import { resolveCodexRuntime } from './codex-runtime.service.js';
import { resolveCodexReasoningEffort } from '../../shared/codex-models.js';
import { parseAdoRemoteUrl, parseGitHubRemoteUrl } from './code-review-pr.service.js';
import {
  buildExternalWatchtowerEvents,
  isExternalWatchtowerEvent,
  observeExternalWatchtowerSource,
  watchtowerStateFromObservation,
} from './watchtower-source.service.js';
import {
  countEnabledDojoConfigs,
  markStaleDojoReportsFailed,
  processDueDojoReviews,
} from './dojo.service.js';

interface RepoRow {
  id: string;
  name: string;
  path: string;
  remoteUrl?: string;
}

interface PreparedWorktree {
  repoId: string;
  repoName: string;
  originalPath: string;
  branchName: string;
  path: string;
  startHead?: string;
}

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerTickInFlight = false;
const activeAutomationIds = new Set<string>();

function getRepoRows(repoIds: string[]): RepoRow[] {
  const db = getDb();
  const query = db.prepare('SELECT id, name, path, remote_url FROM repos WHERE id = ?');
  const rows = repoIds
    .map((repoId): RepoRow | undefined => {
      const row = query.get(repoId) as
        { id: string; name: string; path: string; remote_url: string | null } | undefined;
      return row
        ? { id: row.id, name: row.name, path: row.path, remoteUrl: row.remote_url ?? undefined }
        : undefined;
    })
    .filter((row): row is RepoRow => Boolean(row));
  return rows;
}

function validateAutomationInput(input: AutomationDefinitionInput): void {
  if (input.allowRemotePublishing !== undefined && typeof input.allowRemotePublishing !== 'boolean')
    throw new Error('Remote publishing permission must be a boolean.');
  if (!input.name.trim()) throw new Error('Automation name is required.');
  if (!input.prompt.trim()) throw new Error('Automation prompt is required.');
  if (!input.personaId.trim()) throw new Error('Automation persona is required.');
  if (!getPersonaById(input.personaId)) {
    throw new Error(`Unknown persona: ${input.personaId}`);
  }
  if (input.allowRemotePublishing && (!input.allowRepoWrite || !input.allowCommandRun))
    throw new Error(
      'Remote publishing requires repository write and command execution permissions.',
    );
  if (input.workflowTemplateId) {
    if (!getWorkflowTemplate(input.workflowTemplateId))
      throw new Error('Choose an existing workflow template.');
    if (input.loopConfig?.enabled)
      throw new Error('Choose a workflow or a persona loop, not both.');
    if (!input.allowRepoWrite || !input.allowCommandRun)
      throw new Error(
        'Workflow automations require repository write and command execution permissions. Use a persona automation for restricted runs.',
      );
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
  if ((input.triggerMode ?? 'schedule') === 'watchtower') {
    const supportedEvents = new Set([
      'workflow.completed',
      'workflow.failed',
      'pull_request.merged',
      'pull_request.closed',
      'pull_request.review_comment',
      'pull_request.head_changed',
      'pipeline.completed',
      'pipeline.failed',
    ]);
    if (!input.watchEvent || !supportedEvents.has(input.watchEvent)) {
      throw new Error('Choose a Watchtower event.');
    }
    if (isExternalWatchtowerEvent(input.watchEvent)) {
      const target = input.watchTarget;
      if (!target || !input.repoIds.includes(target.repoId)) {
        throw new Error('Choose one of the automation repositories to watch.');
      }
      const targetRepo = getRepoRows([target.repoId])[0];
      if (!targetRepo?.remoteUrl) {
        throw new Error('The watched repository needs a GitHub or Azure DevOps remote.');
      }
      if (!parseGitHubRemoteUrl(targetRepo.remoteUrl) && !parseAdoRemoteUrl(targetRepo.remoteUrl)) {
        throw new Error('Watchtower currently supports GitHub and Azure DevOps remotes.');
      }
      if (input.watchEvent.startsWith('pull_request.')) {
        if (!Number.isInteger(target.pullRequestNumber) || (target.pullRequestNumber ?? 0) < 1) {
          throw new Error('Enter a valid pull request number.');
        }
      } else if (!target.pipelineIdentifier?.trim()) {
        throw new Error('Enter a pipeline name, workflow file, or run ID.');
      }
    }
  } else {
    validateAutomationCron(input.scheduleCron, input.timezone);
  }
}

function withWatchtowerContext(
  automation: AutomationDefinition,
  event: WatchtowerEvent | undefined,
): AutomationDefinition {
  if (!event) return automation;
  return {
    ...automation,
    prompt: [
      automation.prompt,
      '',
      '## Watchtower event',
      `Event: ${event.type}`,
      `Source: ${event.sourceLabel} (${event.sourceId})`,
      `Occurred at: ${event.occurredAt}`,
      event.metadata ? `Metadata: ${JSON.stringify(event.metadata)}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
  };
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

function currentAutomationPolicy(automation: AutomationDefinition): AutomationDefinition {
  const current = getAutomation(automation.id);
  if (!current || automation.repoIds.some((id) => !current.repoIds.includes(id)))
    throw new Error('Automation was deleted or its repository scope changed.');
  if (JSON.stringify(current.watchTarget) !== JSON.stringify(automation.watchTarget))
    throw new Error('Automation watch target changed before execution.');
  return {
    ...automation,
    allowRepoWrite: automation.allowRepoWrite && current.allowRepoWrite,
    allowCommandRun: automation.allowCommandRun && current.allowCommandRun,
    allowRemotePublishing: automation.allowRemotePublishing && current.allowRemotePublishing,
  };
}

function buildAutomationInstructions(
  automation: AutomationDefinition,
  worktrees: PreparedWorktree[],
  personaId: string | null = automation.personaId,
): string {
  const mode = automationAccessMode(automation, getSettings().codexMode ?? 'on-request');
  // Workflow nodes use their own personas. Their sandbox is clamped at execution.
  const personaCanWrite =
    personaId === null || resolvePersonaCodexPolicy(mode, personaId).sandbox !== 'read-only';
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
    '- This run was triggered automatically by Mezair.',
    '- Operate only within the disposable worktrees listed below.',
    repoWriteLine,
    commandLine,
    remotePublishingInstructions(remotePublishingAllowed(automation, mode) && personaCanWrite),
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
  repairTarget?: AutomationRepairTarget,
): Promise<PreparedWorktree[]> {
  const prepared: PreparedWorktree[] = [];
  const baseBranch = sanitiseBranchName(automation.name) || 'automation';
  const suffix = runId.slice(0, 8);

  for (const repo of repoRows) {
    const safeRepoName = sanitiseBranchName(repo.name).replaceAll('/', '-') || 'repo';
    const branchName = `mezair/automation/${baseBranch}-${suffix}-${safeRepoName}`;
    const worktreePath = buildWorktreePath(automation.id, runId, repo.name);
    await addWorktree(repo.path, worktreePath, branchName, repairTarget?.headSha ?? 'HEAD');
    prepared.push({
      repoId: repo.id,
      repoName: repo.name,
      originalPath: repo.path,
      branchName,
      path: worktreePath,
      startHead: repairTarget?.headSha,
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
  const settings = getSettings();
  const pathOverrides = Object.fromEntries(
    worktrees.map((worktree) => [worktree.repoId, worktree.path]),
  );
  const personaId = options?.personaId ?? automation.personaId;
  // A later edit can narrow an active run, never expand its original grants.
  automation = currentAutomationPolicy(automation);
  const accessMode = automationAccessMode(automation, settings.codexMode ?? 'on-request');
  const systemPrompt = [
    buildSystemPrompt(personaId, automation.repoIds, automation.workspaceId, pathOverrides),
    buildAutomationInstructions(automation, worktrees, personaId),
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
  const provider = settings.llmProvider;

  // H6: run the configured provider, never a hard-coded Codex. ACP providers
  // (Cursor/Devin) run a one-shot print-mode invocation; Codex-family
  // providers spawn `codex app-server` with their provider-specific args.
  if (isAcpAgentProvider(provider)) {
    return runAcpPrintAutomation({
      runId,
      provider,
      cwd,
      personaId,
      systemPrompt,
      prompt,
      model: settings.openaiModel,
      accessMode,
    });
  }

  const env = await buildCodexProcessEnvironment(provider, settings);

  const args = buildCodexWorkflowArgs(provider);
  const executable = provider === 'llmgateway' ? await resolveCodexRuntime() : 'codex';
  const model = settings.openaiModel;
  const gatewayConfig =
    provider === 'llmgateway'
      ? await resolveLlmGatewayModelConfig(model, settings.reasoningLevel)
      : undefined;
  if (gatewayConfig)
    args.push(...(await writeGatewayCodexCatalog(env.CODEX_HOME, gatewayConfig.models)));
  const proc = spawn(executable, args, {
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
              model: gatewayConfig?.model ?? model,
              ...(gatewayConfig
                ? gatewayConfig.effort
                  ? { effort: gatewayConfig.effort }
                  : {}
                : { effort: resolveCodexReasoningEffort(model, settings.reasoningLevel) }),
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
      clientInfo: { name: 'mezair-automation', version: '0.1.0' },
    });
    const personaPolicy = resolvePersonaCodexPolicy(accessMode, personaId);
    sendCodexJsonRpc(proc, 'thread/start', {
      cwd,
      developerInstructions: systemPrompt,
      approvalPolicy: personaPolicy.approvalPolicy,
      sandbox: personaPolicy.sandbox,
      model: gatewayConfig?.model ?? model,
    });
  });
}

/**
 * One-shot print-mode run for ACP providers (H6). A Cursor/Devin-primary
 * install must never spawn `codex app-server`; the ACP CLIs have no
 * non-interactive streaming protocol, so the run captures only the final
 * text — the run event log records that limitation explicitly. Same
 * allowlisted spawn env and persona-clamped permission mapping as the
 * workflow ACP path (acp-print-cli.ts).
 */
async function runAcpPrintAutomation(input: {
  runId: string;
  provider: AcpAgentProvider;
  cwd: string;
  personaId: string;
  systemPrompt: string;
  prompt: string;
  model?: string;
  accessMode: CodexMode;
}): Promise<{ assistantMessage: string }> {
  const label = acpProviderLabel(input.provider);
  const policy = resolvePersonaCodexPolicy(input.accessMode, input.personaId);
  const { executable, args } = buildAcpPrintInvocation({
    provider: input.provider,
    model: input.model,
    mode: input.accessMode,
    policy,
    prompt: [input.systemPrompt, input.prompt].filter(Boolean).join('\n\n'),
  });
  appendAutomationRunEvent(
    input.runId,
    'system',
    `${label} automation step runs in one-shot print mode; tool calls, file edits and reasoning are not captured.`,
    { executionMode: 'acp-print', provider: input.provider },
  );
  const proc = spawn(executable, args, {
    cwd: input.cwd,
    env: providerSpawnEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let output = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGTERM');
      settle(null, new Error(`${label} automation run timed out after 10 minutes.`));
    }, 600_000);
    const settle = (result: { assistantMessage: string } | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
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
      output += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const text = chunk.toString().trim();
      if (text) appendAutomationRunEvent(input.runId, 'system', text);
    });
    proc.on('error', (error) => {
      settle(null, new Error(`Failed to start ${label} automation run: ${error.message}`));
    });
    proc.on('exit', (code, signal) => {
      if (code === 0) {
        const assistantMessage = output.trim();
        if (!assistantMessage) {
          settle(
            null,
            new Error(stderr.trim() || `${label} returned no output for this automation run.`),
          );
          return;
        }
        settle({ assistantMessage });
        return;
      }
      settle(
        null,
        new Error(
          stderr.trim() ||
            `${label} automation run exited before completion (code=${code}, signal=${signal}).`,
        ),
      );
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
  const storedAutomation = getAutomation(run.automationId);
  if (!storedAutomation) {
    completeAutomationRun(run.id, {
      status: 'failed',
      errorMessage: 'Automation definition was deleted before the run started.',
      changedFileCount: 0,
      worktrees: [],
    });
    return;
  }
  // Feedback cannot grant publication authority. Legacy definitions remain disabled.
  const contextEventType = run.triggerContext?.type;
  const feedbackEventType =
    contextEventType === 'pull_request.review_comment' ||
    contextEventType === 'pull_request.head_changed'
      ? contextEventType
      : storedAutomation.watchEvent;
  if (
    feedbackEventType === 'pull_request.review_comment' ||
    feedbackEventType === 'pull_request.head_changed'
  ) {
    const metadata = run.triggerContext?.metadata;
    const feedback =
      metadata?.feedback && typeof metadata.feedback === 'object'
        ? (metadata.feedback as Record<string, unknown>)
        : undefined;
    const observedHead = typeof metadata?.headSha === 'string' ? metadata.headSha : undefined;
    const commentHead = typeof feedback?.headSha === 'string' ? feedback.headSha : undefined;
    const latestHead = storedAutomation.watchState?.headSha;
    const stale = Boolean(
      observedHead &&
      ((latestHead && latestHead !== observedHead) ||
        (commentHead && commentHead !== observedHead)),
    );
    const unknownScope =
      !observedHead || (feedbackEventType === 'pull_request.review_comment' && !commentHead);
    const allowed = remotePublishingAllowed(
      storedAutomation,
      automationAccessMode(storedAutomation, getSettings().codexMode ?? 'on-request'),
    );
    const stopReason = stale
      ? 'stale-head'
      : unknownScope
        ? 'unknown-head'
        : !allowed
          ? 'remote-publishing-disabled'
          : undefined;
    if (stopReason) {
      const reason = stale
        ? 'PR feedback refers to an older head. Refresh the pull request and review the current changes.'
        : unknownScope
          ? 'PR feedback has no verified head SHA. Open the pull request and verify its current changes.'
          : 'PR feedback repair requires remote publishing, repository write and command execution to be enabled, and a writable current access mode.';
      appendAutomationRunEvent(run.id, 'system', reason, {
        repoId: storedAutomation.watchTarget?.repoId,
        pullRequestNumber: storedAutomation.watchTarget?.pullRequestNumber,
        feedbackDisposition: stale || unknownScope ? 'rejected' : 'deferred',
        stopReason,
        eventId: run.triggerContext?.id,
        sourceId: run.triggerContext?.sourceId,
        feedbackId: feedback?.id,
        feedbackBody: typeof feedback?.body === 'string' ? feedback.body : undefined,
        feedbackUrl: typeof feedback?.url === 'string' ? feedback.url : undefined,
        feedbackAuthor: typeof feedback?.author === 'string' ? feedback.author : undefined,
        observedHead,
        commentHead,
        latestHead,
        repairRounds: 0,
      });
      completeAutomationRun(run.id, {
        status: 'failed',
        errorMessage: reason,
        assistantMessage: reason,
        changedFileCount: 0,
        worktrees: [],
      });
      return;
    }
  }
  let automation = withWatchtowerContext(storedAutomation, run.triggerContext);

  if (activeAutomationIds.has(automation.id)) return;
  activeAutomationIds.add(automation.id);

  let repoRows = getRepoRows(automation.repoIds);
  let preparedWorktrees: PreparedWorktree[] = [];
  let repairTarget: AutomationRepairTarget | undefined;

  try {
    if (repoRows.length === 0) {
      throw new Error('No repositories are available for this automation run.');
    }

    if (isPrFeedbackEvent(feedbackEventType)) {
      const event = run.triggerContext;
      if (!event || !matchesRepairTarget(automation, event))
        throw new Error('PR feedback does not match the configured repository and pull request.');
      const repo = repoRows.find((row) => row.id === automation.watchTarget?.repoId);
      if (!repo) throw new Error('The watched repository is unavailable.');
      if (
        isOwnPublishedHead(automation, event) ||
        (await isRetainedWorkflowHead(automation, event))
      ) {
        const reason =
          'This head change matches a retained commit from this automation; no repair is needed.';
        appendAutomationRunEvent(run.id, 'system', reason, {
          feedbackDisposition: 'accepted',
          stopReason: 'own-head',
          sourceId: event.sourceId,
          observedHead: event.metadata?.headSha,
        });
        completeAutomationRun(run.id, {
          status: 'completed',
          assistantMessage: reason,
          changedFileCount: 0,
          worktrees: [],
        });
        return;
      }
      repairTarget = await prepareAutomationRepairTarget(automation, event, repo, run.id);
      repoRows = [repo];
      automation = {
        ...automation,
        repoIds: [repo.id],
        prompt: [automation.prompt, repairTargetInstructions(repairTarget)].join('\n\n'),
      };
    }
    appendAutomationRunEvent(run.id, 'status', 'running');
    preparedWorktrees = await prepareWorktrees(automation, run.id, repoRows, repairTarget);
    if (repairTarget) {
      const head = await automationGit(preparedWorktrees[0].path, ['rev-parse', 'HEAD']);
      if (head !== repairTarget.headSha)
        throw new Error('The repair checkout does not match the verified PR head.');
      // Fetch/worktree creation must not hide a concurrent PR update.
      const fresh = await observeExternalWatchtowerSource(automation);
      if (
        fresh.repo.id !== repairTarget.repoId ||
        fresh.observation.status !== 'open' ||
        fresh.observation.headSha !== repairTarget.headSha ||
        fresh.observation.sourceId !== repairTarget.sourceId ||
        fresh.observation.metadata.isCrossRepository !== false ||
        fresh.observation.metadata.headBranch !== repairTarget.sourceBranch
      )
        throw new Error('The PR target changed before repair execution.');
      appendAutomationRunEvent(run.id, 'system', 'Starting opted-in current-head PR repair.', {
        feedbackDisposition: 'accepted',
        repoId: repairTarget.repoId,
        pullRequestNumber: repairTarget.pullRequestNumber,
        observedHead: repairTarget.headSha,
        headBranch: repairTarget.sourceBranch,
        sourceId: repairTarget.sourceId,
        feedbackBody: (
          run.triggerContext?.metadata?.feedback as Record<string, unknown> | undefined
        )?.body,
        feedbackUrl: (run.triggerContext?.metadata?.feedback as Record<string, unknown> | undefined)
          ?.url,
        repairTarget,
        repairRounds: 1,
      });
    }
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

    let assistantMessage: string;
    let retainWorkflowWorktrees = false;
    let workflowOwnsDecision = false;
    automation = currentAutomationPolicy(automation);
    if (
      repairTarget &&
      !remotePublishingAllowed(
        automation,
        automationAccessMode(automation, getSettings().codexMode ?? 'on-request'),
      )
    )
      throw new Error('Remote publication authority changed before PR repair execution.');
    if (automation.workflowTemplateId) {
      validateAutomationInput(automation);
      const workflow = startWorkflowRun({
        templateId: automation.workflowTemplateId,
        workspaceId: automation.workspaceId,
        repoIds: automation.repoIds,
        kickoff: [
          buildAutomationInstructions(automation, preparedWorktrees, null),
          automation.prompt,
        ].join('\n\n'),
        permissionCeiling: automationAccessMode(
          automation,
          getSettings().codexMode ?? 'on-request',
        ),
        sourceAutomationRunId: run.id,
        trigger: {
          kind: run.triggerContext?.type ?? automation.watchEvent ?? run.trigger,
          ...(typeof run.triggerContext?.metadata?.headSha === 'string'
            ? { headSha: run.triggerContext.metadata.headSha }
            : {}),
        },
        executionPaths: preparedWorktrees.map((tree) => ({ id: tree.repoId, path: tree.path })),
      });
      appendAutomationRunEvent(run.id, 'system', `Workflow launched: ${workflow.templateName}`, {
        workflowRunId: workflow.id,
      });
      const result = await waitForWorkflowRun(workflow.id);
      retainWorkflowWorktrees = true;
      workflowOwnsDecision = result.status === 'paused';
      if (result.status === 'failed' || result.status === 'cancelled')
        throw new Error(`Workflow ${result.status}: ${result.error ?? result.id}`);
      assistantMessage = `Workflow ${result.status}: ${result.templateName}\n\nWorkflow run: ${result.id}\n\n${
        result.status === 'paused'
          ? 'Worktrees retained. Resolve decisions and resume from Workflows.'
          : result.nodeRuns
              .filter((node) => node.output)
              .map((node) => node.output)
              .join('\n\n')
              .slice(-24000)
      }`;
    } else {
      const loopConfig = getActiveLoopConfig(automation);
      ({ assistantMessage } = loopConfig
        ? await runLoopAutomation(automation, run.id, preparedWorktrees, loopConfig)
        : await runCodexAutomation(automation, run.id, preparedWorktrees));
    }
    const changedFileCount = await getChangedFileCount(preparedWorktrees);
    // Publication can leave a clean checkout after commits. Retain it for inspection.
    const keepWorktrees =
      retainWorkflowWorktrees || changedFileCount > 0 || automation.allowRemotePublishing;

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

    if (!workflowOwnsDecision && (assistantMessage.trim() || changedFileCount > 0)) {
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
    // A CLI may have committed/pushed even if its final response failed. Keep the
    // local commit identity so a subsequent observed own-head change cannot loop.
    if (repairTarget && preparedWorktrees[0]) {
      try {
        const localHead = await automationGit(preparedWorktrees[0].path, ['rev-parse', 'HEAD']);
        if (localHead !== repairTarget.headSha)
          appendAutomationRunEvent(
            run.id,
            'system',
            'Recorded repair commit for future observed head-change suppression. This is not a publication receipt.',
            {
              repairCommit: {
                sourceId: repairTarget.sourceId,
                repoId: repairTarget.repoId,
                headSha: localHead,
              },
            },
          );
      } catch {
        /* retained checkout can still be inspected manually */
      }
    }
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

async function processExternalWatchtowerSources(): Promise<void> {
  for (const automation of listExternalWatchtowerAutomations()) {
    if (!automation.watchEvent || !isExternalWatchtowerEvent(automation.watchEvent)) continue;
    try {
      const { repo, observation } = await observeExternalWatchtowerSource(automation);
      // Queue each transition before advancing the cursor so a crash cannot silently lose it.
      for (const event of buildExternalWatchtowerEvents(automation, repo, observation)) {
        enqueueWatchtowerEvent(automation.id, event);
      }
      updateWatchtowerState(automation.id, watchtowerStateFromObservation(observation));
    } catch (error) {
      updateWatchtowerState(automation.id, {
        ...automation.watchState,
        observedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const pending of listPendingWatchtowerEvents()) {
    const run = claimPendingWatchtowerEvent(pending.id);
    if (run) void executeAutomationRun(run);
  }
}

async function processSchedulerTick(): Promise<void> {
  if (schedulerTickInFlight) return;
  schedulerTickInFlight = true;
  try {
    await processDueAutomations();
    processDueDojoReviews();
    await processExternalWatchtowerSources();
  } finally {
    schedulerTickInFlight = false;
  }
}

function startSchedulerLoop(): void {
  if (schedulerTimer) return;
  void processSchedulerTick();
  schedulerTimer = setInterval(() => {
    void processSchedulerTick();
  }, 30_000);
}

export function shutdownAutomationRuntime(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerTickInFlight = false;
}

export function initializeAutomationRuntime(): void {
  if (isAutomationDaemonMode()) {
    markStaleAutomationRunsFailed('Automation daemon restarted while a run was still active.');
    markStaleDojoReportsFailed(
      'schedule',
      'Automation daemon restarted while a Dojo review was running. Run a new review to retry.',
    );
    startSchedulerLoop();
  } else {
    markStaleDojoReportsFailed(
      'manual',
      'Mezair restarted while a manual Dojo review was running. Run a new review to retry.',
    );
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
  const nextRunAt =
    input.enabled && (input.triggerMode ?? 'schedule') === 'schedule'
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
  const nextRunAt =
    input.enabled && (input.triggerMode ?? 'schedule') === 'schedule'
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

function isOwnPublishedHead(automation: AutomationDefinition, event: WatchtowerEvent): boolean {
  if (event.type !== 'pull_request.head_changed' || typeof event.metadata?.headSha !== 'string')
    return false;
  return listAutomationRuns(automation.id)
    .slice(0, 50)
    .some((run) =>
      listAutomationRunEvents(run.id).some((entry) => {
        const commit = entry.metadata?.repairCommit as Record<string, unknown> | undefined;
        return (
          commit?.sourceId === event.sourceId &&
          commit.repoId === automation.watchTarget?.repoId &&
          commit.headSha === event.metadata!.headSha
        );
      }),
    );
}

/** A paused workflow may later commit in its retained checkout after this wrapper returned. */
async function isRetainedWorkflowHead(
  automation: AutomationDefinition,
  event: WatchtowerEvent,
): Promise<boolean> {
  if (event.type !== 'pull_request.head_changed' || typeof event.metadata?.headSha !== 'string')
    return false;
  for (const prior of listAutomationRuns(automation.id).slice(0, 50)) {
    if (
      prior.triggerContext?.sourceId !== event.sourceId ||
      prior.triggerContext.metadata?.headSha === event.metadata.headSha
    )
      continue;
    for (const tree of prior.worktrees) {
      if (!tree.kept || !tree.path || tree.repoId !== automation.watchTarget?.repoId) continue;
      try {
        if ((await automationGit(tree.path, ['rev-parse', 'HEAD'])) === event.metadata.headSha)
          return true;
      } catch {
        /* missing retained checkouts cannot establish provenance */
      }
    }
  }
  return false;
}

export function triggerWatchtowerEvent(event: WatchtowerEvent): AutomationRun[] {
  if (event.metadata?.sourceAutomationRunId) return [];
  const runs: AutomationRun[] = [];
  for (const automation of listWatchtowerAutomations(event.workspaceId, event.type)) {
    if (
      isPrFeedbackEvent(event.type) &&
      (!matchesRepairTarget(automation, event) || isOwnPublishedHead(automation, event))
    )
      continue;
    if (
      event.repoIds.length > 0 &&
      !automation.repoIds.some((repoId) => event.repoIds.includes(repoId))
    ) {
      continue;
    }
    try {
      const run = createAutomationRun(automation, 'watchtower', event);
      runs.push(run);
      void executeAutomationRun(run);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('already has an active run'))) {
        console.error(`[Watchtower] Failed to start ${automation.name}:`, error);
      }
    }
  }
  return runs;
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
  if (previewBuild) return getAutomationDaemonStatus();
  if (isAutomationDaemonMode()) {
    return getAutomationDaemonStatus();
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return getAutomationDaemonStatus();
  }

  const factories = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM factory_definitions WHERE json_extract(record_json,'$.activatedAt') IS NOT NULL",
    )
    .get() as { n: number };
  return countEnabledAutomations() + countEnabledDojoConfigs() + factories.n > 0
    ? installAutomationDaemon()
    : uninstallAutomationDaemon();
}
