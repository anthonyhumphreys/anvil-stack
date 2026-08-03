import { app } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm } from './llm.service.js';
import {
  createReview,
  createFinding,
  updateReviewScopeRef,
  updateReviewStatus,
  updateReviewVerification,
} from './code-review-persistence.service.js';
import {
  getLatestCommitDiff,
  getCommitRangeDiff,
  getBranchDiff,
  resolveGitRef,
  type GitDiffFile,
} from './code-review-git.service.js';
import { parseGitHubRemoteUrl, resolvePullRequestForReview } from './code-review-pr.service.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import type {
  CodeReviewMode,
  CodeReviewScopeRef,
  CodeReviewScopeType,
  CodeReviewVerification,
  CodeReviewVerificationStep,
} from '../../shared/types.js';
import { getSettings } from './settings.service.js';
import { addWorktree, fetchRef, fetchRemote, removeWorktree } from './git.service.js';
import { detectScripts } from './run-detection.service.js';
import { listSavedCommands } from './run-persistence.service.js';
import { getDefaultShell } from '../utils/shell.js';

const activeReviewIds = new Set<string>();

// ---------------------------------------------------------------------------
// Finding parsing
// ---------------------------------------------------------------------------

interface ReviewFinding {
  severity: string;
  category: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  description: string;
  suggestion?: string;
}

function parseFindingsResponse(text: string): ReviewFinding[] {
  if (!text || !text.trim()) {
    console.warn('[CodeReview] LLM returned empty response, no findings to parse');
    return [];
  }
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);

  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      const findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
      return findings.map((f: Record<string, unknown>) => ({
        severity: String(f.severity ?? 'suggestion').toLowerCase(),
        category: String(f.category ?? 'General'),
        filePath: f.filePath ? String(f.filePath) : undefined,
        lineStart: typeof f.lineStart === 'number' ? f.lineStart : undefined,
        lineEnd: typeof f.lineEnd === 'number' ? f.lineEnd : undefined,
        description: String(f.description ?? ''),
        suggestion: f.suggestion ? String(f.suggestion) : undefined,
      }));
    } catch {
      // Try next candidate
    }
  }

  console.warn('[CodeReview] Failed to parse findings JSON from LLM response');
  return [];
}

// ---------------------------------------------------------------------------
// Main review function
// ---------------------------------------------------------------------------

export interface RunReviewOptions {
  reviewId: string;
  repoId: string;
  repoPath: string;
  remoteUrl?: string;
  mode: CodeReviewMode;
  scopeType: CodeReviewScopeType;
  scopeRef?: CodeReviewScopeRef;
  repoContext: string;
  sendProgress: (message: string, percent: number) => void;
}

function getReviewRubricConfig(mode: CodeReviewMode): {
  customRubric: string;
  templateName: string;
  rubricUsed: string;
} {
  const settings = getSettings();
  const customRubric =
    mode === 'quick_glance'
      ? (settings.codeReviewQuickGlanceRubric ?? '')
      : (settings.codeReviewSeniorDevRubric ?? '');

  const templateName = mode === 'quick_glance' ? 'code-review-quick.md' : 'code-review-senior.md';

  return {
    customRubric,
    templateName,
    rubricUsed: customRubric || templateName,
  };
}

interface ReviewScopeResolution {
  diffFiles: GitDiffFile[];
  scopeDescription: string;
  verificationTargetRef?: string;
}

interface VerificationCandidate {
  label: string;
  command: string;
}

interface ShellCommandResult {
  exitCode: number | null;
  signal?: string;
  timedOut?: boolean;
  durationMs: number;
  outputSnippet?: string;
}

function buildReviewWorktreePath(reviewId: string): string {
  return path.join(app.getPath('userData'), 'code-review-worktrees', reviewId);
}

function sanitiseBranchName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/\/+/g, '/');
}

function buildReviewBranchName(reviewId: string): string {
  return `anvil/review/${sanitiseBranchName(reviewId).slice(0, 24)}`;
}

function buildVerificationOutputSnippet(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(-4000);
}

function scoreVerificationCandidate(candidate: VerificationCandidate): number {
  const value = `${candidate.label} ${candidate.command}`.toLowerCase();
  if (/\b(test|unit|integration|spec)\b/.test(value)) return 5;
  if (/\b(lint|eslint|check|verify)\b/.test(value)) return 4;
  if (/\b(build|compile|typecheck|tsc)\b/.test(value)) return 2;
  if (/\b(dev|start|serve|watch)\b/.test(value)) return -1;
  return 0;
}

async function selectVerificationCommands(
  repoId: string,
  repoPath: string,
): Promise<VerificationCandidate[]> {
  const saved = listSavedCommands(repoId).map((command) => ({
    label: command.label,
    command: command.command,
  }));
  const detected = (await detectScripts(repoId, repoPath)).map((command) => ({
    label: command.label,
    command: command.command,
  }));

  const byCommand = new Map<string, VerificationCandidate>();
  for (const candidate of [...saved, ...detected]) {
    if (!candidate.command.trim()) continue;
    if (!byCommand.has(candidate.command)) {
      byCommand.set(candidate.command, candidate);
    }
  }

  return [...byCommand.values()]
    .map((candidate) => ({ candidate, score: scoreVerificationCandidate(candidate) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

async function runShellCommandInWorktree(
  worktreePath: string,
  command: string,
): Promise<ShellCommandResult> {
  const shell = getDefaultShell();
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  const startedAt = Date.now();
  const timeoutMs = 10 * 60_000;

  return await new Promise<ShellCommandResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let forceSettleTimer: NodeJS.Timeout | undefined;
    const child = spawn(shell, shellArgs, {
      cwd: worktreePath,
      env: process.env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let output = '';
    const timeout = setTimeout(() => {
      timedOut = true;
      append(Buffer.from(`\nCommand timed out after ${Math.round(timeoutMs / 1000)} seconds.\n`));
      killProcessTree(child.pid, 'SIGTERM');
      sigkillTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 2_000);
      sigkillTimer.unref();
      forceSettleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          durationMs: Date.now() - startedAt,
          outputSnippet: buildVerificationOutputSnippet(output),
        });
      }, 7_000);
      forceSettleTimer.unref();
    }, timeoutMs);

    const clearTimers = () => {
      clearTimeout(timeout);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
    };

    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 12_000) {
        output = output.slice(-12_000);
      }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (error) => {
      clearTimers();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal: signal ?? undefined,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputSnippet: buildVerificationOutputSnippet(output),
      });
    });
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }

    process.kill(-pid, signal);
  } catch {
    // Process already exited or could not be signalled. The close/error handlers
    // still own the final review state.
  }
}

async function resolveVerificationStartPoint(
  repoPath: string,
  remoteUrl: string | undefined,
  scopeType: CodeReviewScopeType,
  scopeRef: CodeReviewScopeRef | undefined,
  verificationTargetRef: string | undefined,
): Promise<string | null> {
  if (!verificationTargetRef) {
    return null;
  }

  if (
    scopeType === 'latest_commit' ||
    scopeType === 'full_codebase' ||
    scopeType === 'commit_range'
  ) {
    return resolveGitRef(repoPath, verificationTargetRef) ?? verificationTargetRef;
  }

  await fetchRemote(repoPath).catch(() => undefined);

  if (
    scopeType === 'pull_request' &&
    scopeRef?.pullRequest?.id &&
    parseGitHubRemoteUrl(remoteUrl ?? '')
  ) {
    const localRef = `refs/anvil/review-pr-${scopeRef.pullRequest.id}`;
    try {
      await fetchRef(repoPath, 'origin', `pull/${scopeRef.pullRequest.id}/head`, localRef);
      return localRef;
    } catch {
      // Fall back to local ref resolution below.
    }
  }

  return resolveGitRef(repoPath, verificationTargetRef);
}

async function runReviewVerification(opts: {
  reviewId: string;
  repoId: string;
  repoPath: string;
  remoteUrl?: string;
  scopeType: CodeReviewScopeType;
  scopeRef?: CodeReviewScopeRef;
  verificationTargetRef?: string;
  sendProgress: (message: string, percent: number) => void;
}): Promise<CodeReviewVerification> {
  const {
    reviewId,
    repoId,
    repoPath,
    remoteUrl,
    scopeType,
    scopeRef,
    verificationTargetRef,
    sendProgress,
  } = opts;

  if (!verificationTargetRef) {
    return {
      status: 'not_run',
      summary:
        'This review scope could not be mapped to an executable git ref for branch-local verification.',
      steps: [],
    };
  }

  sendProgress('Preparing disposable review worktree...', 8);
  const startPoint = await resolveVerificationStartPoint(
    repoPath,
    remoteUrl,
    scopeType,
    scopeRef,
    verificationTargetRef,
  );

  if (!startPoint) {
    return {
      status: 'not_run',
      summary: `Branch-local verification was skipped because the review ref "${verificationTargetRef}" could not be resolved locally.`,
      targetRef: verificationTargetRef,
      steps: [],
    };
  }

  const worktreePath = buildReviewWorktreePath(reviewId);
  const branchName = buildReviewBranchName(reviewId);

  try {
    await addWorktree(repoPath, worktreePath, branchName, startPoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      summary: `Branch-local verification could not prepare a disposable worktree: ${message}`,
      targetRef: startPoint,
      steps: [
        {
          label: 'verification worktree preparation',
          command: 'prepare disposable review worktree',
          status: 'failed',
          durationMs: 0,
          outputSnippet: message,
        },
      ],
    };
  }

  let commands: VerificationCandidate[];
  try {
    commands = await selectVerificationCommands(repoId, worktreePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      summary: `Branch-local verification could not discover runnable commands: ${message}`,
      targetRef: startPoint,
      worktreePath,
      worktreeKept: true,
      steps: [
        {
          label: 'verification command discovery',
          command: 'detect verification commands',
          status: 'failed',
          durationMs: 0,
          outputSnippet: message,
        },
      ],
    };
  }

  if (commands.length === 0) {
    await removeWorktree(repoPath, worktreePath).catch(() => undefined);
    return {
      status: 'not_run',
      summary:
        'No suitable branch-local verification commands were configured or detected for this repository.',
      targetRef: startPoint,
      steps: [],
    };
  }

  const steps: CodeReviewVerificationStep[] = [];
  let keepWorktree = false;

  try {
    for (let index = 0; index < commands.length; index += 1) {
      const candidate = commands[index];
      sendProgress(
        `Running ${candidate.label} in disposable review worktree...`,
        Math.round(9 + ((index + 1) / commands.length) * 9),
      );
      const result = await runShellCommandInWorktree(worktreePath, candidate.command);
      const passed = result.exitCode === 0;
      steps.push({
        label: candidate.label,
        command: candidate.command,
        status: passed ? 'passed' : 'failed',
        exitCode: result.exitCode ?? undefined,
        durationMs: result.durationMs,
        outputSnippet: result.timedOut
          ? `Timed out after ${Math.round(result.durationMs / 1000)} seconds.${result.outputSnippet ? `\n\n${result.outputSnippet}` : ''}`
          : result.outputSnippet,
      });

      if (!passed) {
        keepWorktree = true;
        break;
      }
    }
  } catch (error) {
    keepWorktree = true;
    steps.push({
      label: 'verification bootstrap',
      command: 'prepare review worktree',
      status: 'failed',
      durationMs: 0,
      outputSnippet: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!keepWorktree) {
      await removeWorktree(repoPath, worktreePath).catch(() => undefined);
    }
  }

  const passedCount = steps.filter((step) => step.status === 'passed').length;
  const failedCount = steps.filter((step) => step.status === 'failed').length;
  const status: CodeReviewVerification['status'] =
    failedCount === 0 ? 'passed' : passedCount > 0 ? 'partial' : 'failed';

  const summary =
    status === 'passed'
      ? `Ran ${steps.length} branch-local verification command${steps.length === 1 ? '' : 's'} in a disposable review worktree against ${startPoint}; all passed.`
      : `Ran ${steps.length} branch-local verification command${steps.length === 1 ? '' : 's'} in a disposable review worktree against ${startPoint}; ${failedCount} failed.`;

  return {
    status,
    summary,
    targetRef: startPoint,
    worktreePath: keepWorktree ? worktreePath : undefined,
    worktreeKept: keepWorktree,
    steps,
  };
}

function formatVerificationContext(verification: CodeReviewVerification): string {
  const lines = ['Verification summary:', verification.summary ?? `Status: ${verification.status}`];
  for (const step of verification.steps) {
    lines.push(
      `- ${step.label}: ${step.status}${step.exitCode !== undefined ? ` (exit ${step.exitCode})` : ''}`,
    );
  }
  return lines.join('\n');
}

function formatStepExit(step: CodeReviewVerificationStep): string {
  if (step.exitCode !== undefined) return `exit code ${step.exitCode}`;
  return 'no exit code';
}

export function buildVerificationExceptionResult(error: unknown): CodeReviewVerification {
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 'failed',
    summary: `Branch-local verification failed to run, but the code review continued: ${message}`,
    steps: [
      {
        label: 'verification runner',
        command: 'run branch-local verification',
        status: 'failed',
        durationMs: 0,
        outputSnippet: message,
      },
    ],
  };
}

export function buildVerificationFindings(verification: CodeReviewVerification): ReviewFinding[] {
  if (verification.status !== 'failed' && verification.status !== 'partial') return [];

  const failedSteps = verification.steps.filter((step) => step.status === 'failed');
  if (failedSteps.length === 0) return [];

  return failedSteps.map((step) => {
    const output = step.outputSnippet?.trim();
    const outputContext = output ? `\n\nVerification output:\n${output}` : '';
    const worktreeContext = verification.worktreePath
      ? ` The disposable review worktree was kept at ${verification.worktreePath}.`
      : '';

    return {
      severity: 'major',
      category: 'Verification',
      description: `Branch-local verification failed: ${step.label} ran "${step.command}" and returned ${formatStepExit(step)}. The code review completed, but this change should not be treated as verified until the failing check is fixed.`,
      suggestion: `Fix or intentionally update the failing verification command, then rerun the code review.${worktreeContext}${outputContext}`,
    };
  });
}

function persistReviewFindings(reviewId: string, findings: ReviewFinding[]): void {
  for (const finding of findings) {
    createFinding({
      reviewId,
      severity: finding.severity as 'critical' | 'major' | 'minor' | 'suggestion' | 'nitpick',
      category: finding.category,
      filePath: finding.filePath,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      description: finding.description,
      suggestion: finding.suggestion,
    });
  }
}

export function createPendingCodeReview(input: {
  repoId: string;
  mode: CodeReviewMode;
  scopeType: CodeReviewScopeType;
  scopeRef?: CodeReviewScopeRef;
}): string {
  const { rubricUsed } = getReviewRubricConfig(input.mode);
  return createReview({
    repoId: input.repoId,
    mode: input.mode,
    scopeType: input.scopeType,
    scopeRef: input.scopeRef,
    rubricUsed,
  });
}

export function isCodeReviewActive(reviewId: string): boolean {
  return activeReviewIds.has(reviewId);
}

export async function runCodeReview(opts: RunReviewOptions): Promise<string> {
  const {
    reviewId,
    repoId,
    repoPath,
    remoteUrl,
    mode,
    scopeType,
    scopeRef,
    repoContext,
    sendProgress,
  } = opts;

  const { customRubric, templateName } = getReviewRubricConfig(mode);
  const llmConcurrency = getSettings().llmProvider === 'codex' ? 1 : 3;
  activeReviewIds.add(reviewId);

  try {
    sendProgress('Gathering code to review...', 5);

    let scopeResolution: ReviewScopeResolution;

    switch (scopeType) {
      case 'latest_commit':
        scopeResolution = {
          diffFiles: getLatestCommitDiff(repoPath),
          scopeDescription: 'Latest commit',
          verificationTargetRef: 'HEAD',
        };
        break;
      case 'commit_range':
        scopeResolution = {
          diffFiles: getCommitRangeDiff(
            repoPath,
            scopeRef?.fromSha ?? 'HEAD~5',
            scopeRef?.toSha ?? 'HEAD',
          ),
          scopeDescription: `Commits ${scopeRef?.fromSha?.substring(0, 7)}..${scopeRef?.toSha?.substring(0, 7)}`,
          verificationTargetRef: scopeRef?.toSha ?? 'HEAD',
        };
        break;
      case 'branch_diff':
        scopeResolution = {
          diffFiles: getBranchDiff(
            repoPath,
            scopeRef?.baseBranch ?? 'main',
            scopeRef?.compareBranch ?? 'HEAD',
          ),
          scopeDescription: `${scopeRef?.baseBranch} → ${scopeRef?.compareBranch}`,
          verificationTargetRef: scopeRef?.compareBranch ?? 'HEAD',
        };
        break;
      case 'pull_request': {
        const pullRequestId = scopeRef?.pullRequest?.id;
        if (!pullRequestId) {
          throw new Error('Pull request scope requires a pull request ID.');
        }

        const resolution = await resolvePullRequestForReview(repoPath, remoteUrl, pullRequestId);
        updateReviewScopeRef(reviewId, {
          pullRequest: {
            id: resolution.pullRequest.id,
            title: resolution.pullRequest.title,
            url: resolution.pullRequest.url,
            sourceBranch: resolution.pullRequest.sourceBranch,
            targetBranch: resolution.pullRequest.targetBranch,
            sourceCommitSha: resolution.pullRequest.sourceCommitSha,
            provider: resolution.pullRequest.provider,
          },
        });
        scopeResolution = {
          diffFiles: resolution.diffFiles,
          scopeDescription: resolution.pullRequest.title
            ? `PR #${resolution.pullRequest.id} — ${resolution.pullRequest.title}`
            : `PR #${resolution.pullRequest.id}`,
          verificationTargetRef: resolution.pullRequest.sourceBranch,
        };
        break;
      }
      case 'full_codebase':
        scopeResolution = {
          diffFiles: [],
          scopeDescription: 'Full codebase',
          verificationTargetRef: 'HEAD',
        };
        break;
      default:
        scopeResolution = {
          diffFiles: [],
          scopeDescription: 'Unknown scope',
        };
    }

    if (scopeType === 'full_codebase') {
      scopeResolution = {
        diffFiles: getLatestCommitDiff(repoPath),
        scopeDescription: 'Full codebase (latest changes)',
        verificationTargetRef: 'HEAD',
      };
    }

    const { diffFiles, scopeDescription, verificationTargetRef } = scopeResolution;

    let verification: CodeReviewVerification;
    try {
      verification = await runReviewVerification({
        reviewId,
        repoId,
        repoPath,
        remoteUrl,
        scopeType,
        scopeRef,
        verificationTargetRef,
        sendProgress,
      });
    } catch (error) {
      verification = buildVerificationExceptionResult(error);
    }
    updateReviewVerification(reviewId, verification);

    const verificationFindings = buildVerificationFindings(verification);

    if (diffFiles.length === 0) {
      const summary =
        verificationFindings.length > 0
          ? `${verification.summary ?? 'Branch-local verification failed.'} Found ${verificationFindings.length} verification finding(s).`
          : verification.status === 'not_run'
            ? 'No changes found to review.'
            : `No changes found to review. ${verification.summary ?? ''}`.trim();
      persistReviewFindings(reviewId, verificationFindings);
      updateReviewStatus(reviewId, 'completed', summary);
      sendProgress('No changes found', 100);
      return reviewId;
    }

    const allFindings: ReviewFinding[] = [...verificationFindings];
    const totalFiles = diffFiles.length;

    let completedFiles = 0;
    const progressPercent = () => Math.round(10 + (80 * completedFiles) / totalFiles);
    const reviewResults = await mapWithConcurrency(diffFiles, llmConcurrency, async (file) => {
      const baseMessage = `Reviewing ${file.filePath}...`;
      sendProgress(baseMessage, progressPercent());

      try {
        const rubricSection = customRubric ? `## Custom Review Rubric\n\n${customRubric}` : '';
        const prompt = loadPromptTemplate(templateName, {
          filePath: file.filePath,
          scope: scopeDescription,
          repoContext:
            verification.status === 'not_run'
              ? repoContext
              : `${repoContext}\n\n${formatVerificationContext(verification)}`,
          customRubric: rubricSection,
          code: file.diff,
        });

        const maxTokens = mode === 'quick_glance' ? 2048 : 4096;
        const response = await callLlm(prompt, maxTokens, 0.2, 2, {
          cwd: repoPath,
          taskClass: 'code-review',
          onProgress: (detail) => sendProgress(`${baseMessage} ${detail}`, progressPercent()),
        });
        return parseFindingsResponse(response);
      } catch (err) {
        console.error(`[CodeReview] Error reviewing ${file.filePath}:`, err);
        return [];
      } finally {
        completedFiles += 1;
        sendProgress(
          `Reviewed ${completedFiles} of ${totalFiles} file${totalFiles === 1 ? '' : 's'}...`,
          progressPercent(),
        );
      }
    });
    allFindings.push(...reviewResults.flat());

    // Deduplication
    sendProgress('Aggregating findings...', 92);
    const seen = new Set<string>();
    const deduped = allFindings.filter((f) => {
      const key = `${f.category}:${f.filePath}:${f.description.substring(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Persist findings
    persistReviewFindings(reviewId, deduped);

    // Summary
    sendProgress('Generating summary...', 96);
    const counts = { critical: 0, major: 0, minor: 0, suggestion: 0, nitpick: 0 };
    for (const f of deduped) {
      const sev = f.severity as keyof typeof counts;
      if (sev in counts) counts[sev]++;
    }

    const modeLabel = mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review';
    const summaryText =
      `${modeLabel} completed. Scope: ${scopeDescription}. ` +
      `Reviewed ${totalFiles} file(s). Found ${deduped.length} finding(s): ` +
      `${counts.critical} critical, ${counts.major} major, ` +
      `${counts.minor} minor, ${counts.suggestion} suggestion(s), ${counts.nitpick} nitpick(s). ` +
      (verification.summary ?? 'Branch-local verification was not run.');

    updateReviewStatus(reviewId, 'completed', summaryText);
    sendProgress('Review complete', 100);

    return reviewId;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    updateReviewStatus(reviewId, 'failed', `Review failed: ${errorMsg}`);
    sendProgress('Review failed', 0);
    throw err;
  } finally {
    activeReviewIds.delete(reviewId);
  }
}
