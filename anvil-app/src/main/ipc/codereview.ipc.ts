import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import {
  getReview,
  getRunningReview,
  listReviews,
  getFindings,
  getFinding,
  dismissFinding,
  linkFindingToPullRequestComment,
  linkFindingToWorkItem,
} from '../services/code-review-persistence.service.js';
import {
  createPendingCodeReview,
  isCodeReviewActive,
  runCodeReview,
} from '../services/code-review.service.js';
import {
  getScopeChangeSummary,
  listRecentCommits,
  listBranches,
  summarizeDiffFiles,
} from '../services/code-review-git.service.js';
import {
  listPullRequests,
  postCommentToPullRequest,
  postFindingCommentToPullRequest,
  resolvePullRequestForReview,
} from '../services/code-review-pr.service.js';
import { getDb } from '../db/database.js';
import { loadPromptTemplate } from '../utils/prompt-templates.js';
import { callLlm } from '../services/llm.service.js';
import type {
  CodeReviewMode,
  CodeReviewVerification,
  CodeReviewScopeRef,
  CodeReviewScopeType,
} from '../../shared/types.js';
import { notifyIfUnfocused } from '../services/notification.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson<T>(json: string | undefined | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerCodeReviewHandlers(): void {
  // codereview:run
  ipcMain.handle(
    'codereview:run',
    async (
      _event,
      repoId: string,
      mode: CodeReviewMode,
      scopeType: CodeReviewScopeType,
      scopeRef?: CodeReviewScopeRef,
    ) => {
      const win = BrowserWindow.getAllWindows()[0];
      const sendProgress = (message: string, percent: number): void => {
        win?.webContents.send('codereview:progress', { repoId, message, percent });
      };

      const existingReview = getRunningReview(repoId, isCodeReviewActive);
      if (existingReview) {
        return existingReview;
      }

      const db = getDb();

      // Get repo info
      const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as
        | { name: string; path: string; remote_url: string | null }
        | undefined;
      if (!repo) throw new Error(`Repo not found: ${repoId}`);

      // Build repo context from summary if available
      const summaryRow = db
        .prepare('SELECT * FROM repo_summaries WHERE repo_id = ?')
        .get(repoId) as Record<string, string> | undefined;

      let repoContext = `Repository: ${repo.name}`;
      if (summaryRow) {
        const frameworks = safeParseJson(summaryRow.frameworks, []);
        const patterns = safeParseJson(summaryRow.patterns, []);
        repoContext = `Repository: ${repo.name}\nFrameworks: ${frameworks.join(', ')}\nPatterns: ${patterns.join(', ')}\nOverview: ${summaryRow.overview || 'N/A'}`;
      }

      const reviewId = createPendingCodeReview({
        repoId,
        mode,
        scopeType,
        scopeRef,
      });

      void runCodeReview({
        reviewId,
        repoId,
        repoPath: repo.path,
        remoteUrl: repo.remote_url ?? undefined,
        mode,
        scopeType,
        scopeRef,
        repoContext,
        sendProgress,
      })
        .then(() => {
          const modeLabel = mode === 'quick_glance' ? 'Quick glance' : 'Senior dev review';
          notifyIfUnfocused('Code Review Complete', `${modeLabel} finished for ${repo.name}.`);
        })
        .catch((err) => {
          console.error(`[CodeReview IPC] Review failed for repo ${repoId}:`, err);
        });

      return getReview(reviewId);
    },
  );

  // codereview:get
  ipcMain.handle('codereview:get', async (_event, reviewId: string) => {
    return getReview(reviewId);
  });

  // codereview:get-running
  ipcMain.handle('codereview:get-running', async (_event, repoId: string) => {
    return getRunningReview(repoId, isCodeReviewActive);
  });

  // codereview:list
  ipcMain.handle('codereview:list', async (_event, repoId: string) => {
    getRunningReview(repoId, isCodeReviewActive);
    return listReviews(repoId);
  });

  // codereview:get-findings
  ipcMain.handle('codereview:get-findings', async (_event, reviewId: string) => {
    return getFindings(reviewId);
  });

  // codereview:fix-prompt
  ipcMain.handle('codereview:fix-prompt', async (_event, findingId: string) => {
    const finding = getFinding(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);

    const review = getReview(finding.reviewId);
    if (!review) throw new Error(`Review not found for finding: ${findingId}`);

    const repoContext = getRepoContext(review.repoId);
    const prompt = loadPromptTemplate('code-review-fix.md', {
      reviewMode: review.mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review',
      reviewScope: formatScopeLabel(review.scopeType, review.scopeRef),
      severity: finding.severity,
      category: finding.category,
      location: formatFindingLocation(finding.filePath, finding.lineStart, finding.lineEnd),
      description: finding.description,
      suggestion: finding.suggestion ?? 'No explicit suggestion was provided in the review.',
      repoName: repoContext.name,
      architectureSummary: repoContext.overview,
      relevantModules: repoContext.modules,
    });

    return callLlm(prompt, 4096, 0.4, 3, { taskClass: 'prompt-draft' });
  });

  // codereview:fix-prompt-bulk
  ipcMain.handle('codereview:fix-prompt-bulk', async (_event, findingIds: string[]) => {
    const findings = findingIds
      .map((findingId) => getFinding(findingId))
      .filter((finding): finding is NonNullable<typeof finding> => finding != null);
    if (findings.length === 0) {
      throw new Error('Select at least one finding to generate a fix prompt.');
    }

    const review = getReview(findings[0].reviewId);
    if (!review) throw new Error(`Review not found for finding: ${findings[0].id}`);
    if (findings.some((finding) => finding.reviewId !== review.id)) {
      throw new Error('Bulk fix prompts can only include findings from one review.');
    }

    const repoContext = getRepoContext(review.repoId);
    const findingList = findings
      .map((finding, index) =>
        [
          `${index + 1}. [${finding.severity}] ${finding.category}`,
          `Location: ${formatFindingLocation(finding.filePath, finding.lineStart, finding.lineEnd)}`,
          `Finding: ${finding.description}`,
          `Suggested Fix: ${finding.suggestion ?? 'No explicit suggestion was provided.'}`,
        ].join('\n'),
      )
      .join('\n\n');

    const prompt = [
      'Generate a Codex CLI prompt for fixing these code review findings in one coherent pass.',
      'The prompt should be self-contained and should ask Codex to preserve unrelated changes.',
      '',
      `Review Mode: ${review.mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review'}`,
      `Review Scope: ${formatScopeLabel(review.scopeType, review.scopeRef)}`,
      `Repository: ${repoContext.name}`,
      `Architecture: ${repoContext.overview}`,
      `Relevant Modules:\n${repoContext.modules}`,
      '',
      'Findings:',
      findingList,
      '',
      'Include the root problems, files to inspect, implementation steps, tests or validation, and expected behaviour.',
      'Output ONLY the prompt text. No preamble.',
    ].join('\n');

    return callLlm(prompt, 8192, 0.4, 3, { taskClass: 'long-context' });
  });

  // codereview:dismiss-finding
  ipcMain.handle('codereview:dismiss-finding', async (_event, findingId: string) => {
    dismissFinding(findingId);
  });

  // codereview:post-finding-to-pr
  ipcMain.handle('codereview:post-finding-to-pr', async (_event, findingId: string) => {
    const finding = getFinding(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);

    if (finding.pullRequestComment) {
      return finding.pullRequestComment;
    }

    const review = getReview(finding.reviewId);
    if (!review) throw new Error(`Review not found for finding: ${findingId}`);
    if (review.scopeType !== 'pull_request' || !review.scopeRef?.pullRequest?.id) {
      throw new Error('This finding is not associated with a pull request review.');
    }

    const db = getDb();
    const repo = db.prepare('SELECT remote_url FROM repos WHERE id = ?').get(review.repoId) as
      | { remote_url: string | null }
      | undefined;
    if (!repo?.remote_url) {
      throw new Error('The reviewed repository does not have a supported remote URL.');
    }

    const comment = await postFindingCommentToPullRequest(
      repo.remote_url,
      review.scopeRef.pullRequest,
      finding,
    );
    linkFindingToPullRequestComment(findingId, comment);
    return comment;
  });

  // codereview:post-review-to-pr
  ipcMain.handle('codereview:post-review-to-pr', async (_event, reviewId: string) => {
    const review = getReview(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    if (review.scopeType !== 'pull_request' || !review.scopeRef?.pullRequest?.id) {
      throw new Error('This review is not associated with a pull request.');
    }

    const findings = getFindings(reviewId);
    const db = getDb();
    const repo = db
      .prepare('SELECT name, remote_url FROM repos WHERE id = ?')
      .get(review.repoId) as { name: string; remote_url: string | null } | undefined;
    if (!repo?.remote_url) {
      throw new Error('The reviewed repository does not have a supported remote URL.');
    }

    const markdown = generateMarkdownReport(review, findings, repo.name || 'Unknown');
    return postCommentToPullRequest(repo.remote_url, review.scopeRef.pullRequest, markdown);
  });

  // codereview:create-work-item
  ipcMain.handle('codereview:create-work-item', async (_event, findingId: string) => {
    const finding = getFinding(findingId);
    if (!finding) throw new Error(`Finding not found: ${findingId}`);

    // TODO: Integrate with work item providers (ADO, Linear, Jira)
    const wiId = `WI-${Date.now()}`;
    linkFindingToWorkItem(findingId, wiId);
    return wiId;
  });

  // codereview:create-work-items-bulk
  ipcMain.handle('codereview:create-work-items-bulk', async (_event, findingIds: string[]) => {
    const results: string[] = [];
    for (const fid of findingIds) {
      const finding = getFinding(fid);
      if (!finding) continue;
      const wiId = `WI-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      linkFindingToWorkItem(fid, wiId);
      results.push(wiId);
    }
    return results;
  });

  // codereview:export-report
  ipcMain.handle('codereview:export-report', async (_event, reviewId: string) => {
    const review = getReview(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);

    const findings = getFindings(reviewId);

    const db = getDb();
    const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(review.repoId) as
      | { name: string }
      | undefined;

    const markdown = generateMarkdownReport(review, findings, repo?.name || 'Unknown');

    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: `code-review-${review.repoId.substring(0, 8)}-${new Date().toISOString().split('T')[0]}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, markdown, 'utf-8');
      return result.filePath;
    }

    return '';
  });

  // codereview:list-commits
  ipcMain.handle('codereview:list-commits', async (_event, repoId: string) => {
    const db = getDb();
    const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
      | { path: string }
      | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return listRecentCommits(repo.path);
  });

  // codereview:list-branches
  ipcMain.handle('codereview:list-branches', async (_event, repoId: string) => {
    const db = getDb();
    const repo = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
      | { path: string }
      | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return listBranches(repo.path);
  });

  // codereview:list-pull-requests
  ipcMain.handle('codereview:list-pull-requests', async (_event, repoId: string) => {
    const db = getDb();
    const repo = db.prepare('SELECT remote_url FROM repos WHERE id = ?').get(repoId) as
      | { remote_url: string | null }
      | undefined;
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return listPullRequests(repo.remote_url);
  });

  ipcMain.handle('codereview:get-change-summary', async (_event, reviewId: string) => {
    const review = getReview(reviewId);
    if (!review) throw new Error(`Code review not found: ${reviewId}`);

    const repo = getDb()
      .prepare('SELECT path, remote_url FROM repos WHERE id = ?')
      .get(review.repoId) as { path: string; remote_url: string | null } | undefined;
    if (!repo) throw new Error(`Repo not found: ${review.repoId}`);

    if (review.scopeType === 'pull_request') {
      const pullRequestId = review.scopeRef?.pullRequest?.id;
      if (!pullRequestId) throw new Error('Pull request scope is missing its pull request ID.');
      const resolution = await resolvePullRequestForReview(
        repo.path,
        repo.remote_url,
        pullRequestId,
      );
      return {
        ...summarizeDiffFiles(resolution.diffFiles),
        currentCommitSha: resolution.pullRequest.sourceCommitSha,
      };
    }

    return getScopeChangeSummary(repo.path, review.scopeType, review.scopeRef);
  });
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function generateMarkdownReport(
  review: {
    id: string;
    repoId: string;
    mode: CodeReviewMode;
    scopeType: CodeReviewScopeType;
    scopeRef?: CodeReviewScopeRef;
    summary?: string;
    verification?: CodeReviewVerification;
    startedAt: string;
    completedAt?: string;
  },
  findings: Array<{
    severity: string;
    category: string;
    filePath?: string;
    lineStart?: number;
    lineEnd?: number;
    description: string;
    suggestion?: string;
    dismissed: boolean;
  }>,
  repoName: string,
): string {
  const modeLabel = review.mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review';
  const lines: string[] = [
    `# Code Review Report — ${repoName}`,
    '',
    `**Review ID:** ${review.id}`,
    `**Date:** ${review.completedAt || review.startedAt}`,
    `**Mode:** ${modeLabel}`,
    `**Scope:** ${formatScopeLabel(review.scopeType, review.scopeRef)}`,
    '',
    '## Summary',
    '',
    review.summary || 'No summary available.',
    '',
    '## Verification',
    '',
    review.verification?.summary || 'Branch-local verification was not run.',
    '',
  ];

  if (review.verification?.steps.length) {
    for (const step of review.verification.steps) {
      lines.push(
        `- **${step.label}** \`${step.command}\` — ${step.status}${
          step.exitCode !== undefined ? ` (exit ${step.exitCode})` : ''
        }`,
      );
      if (step.outputSnippet) {
        lines.push('', '```text', step.outputSnippet, '```', '');
      }
    }
  }

  lines.push('## Findings', '');

  const activeFindings = findings.filter((f) => !f.dismissed);
  const severityOrder = ['critical', 'major', 'minor', 'suggestion', 'nitpick'];
  const grouped = new Map<string, typeof activeFindings>();

  for (const f of activeFindings) {
    const cat = f.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(f);
  }

  const sortedCategories = [...grouped.entries()].sort((a, b) => {
    const aMax = Math.min(...a[1].map((f) => severityOrder.indexOf(f.severity)));
    const bMax = Math.min(...b[1].map((f) => severityOrder.indexOf(f.severity)));
    return aMax - bMax;
  });

  for (const [category, catFindings] of sortedCategories) {
    lines.push(`### ${category}`, '');

    for (const f of catFindings) {
      const sevBadge = f.severity.toUpperCase();
      const location = f.filePath
        ? f.lineStart
          ? `\`${f.filePath}:${f.lineStart}${f.lineEnd ? '-' + f.lineEnd : ''}\``
          : `\`${f.filePath}\``
        : '';
      lines.push(`#### [${sevBadge}] ${f.description.split('\n')[0]}`);
      if (location) lines.push(`- **Location:** ${location}`);
      lines.push('', f.description, '');
      if (f.suggestion) {
        lines.push('**Suggestion:**', '', f.suggestion, '');
      }
    }
  }

  if (activeFindings.length === 0) {
    lines.push('No active findings.', '');
  }

  lines.push('---', `*Generated by Anvil Code Review*`);

  return lines.join('\n');
}

function getRepoContext(repoId: string): { name: string; overview: string; modules: string } {
  const db = getDb();
  const repo = db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
    | { name: string }
    | undefined;

  const summary = db
    .prepare('SELECT overview FROM repo_summaries WHERE repo_id = ?')
    .get(repoId) as { overview: string } | undefined;

  const modules = db
    .prepare('SELECT path, purpose FROM module_summaries WHERE repo_id = ?')
    .all(repoId) as Array<{ path: string; purpose: string | null }>;

  return {
    name: repo?.name ?? 'Unknown',
    overview: summary?.overview ?? 'No summary available',
    modules:
      modules
        .map((module) => `${module.path}: ${module.purpose ?? 'No description available'}`)
        .join('\n') || 'None',
  };
}

function formatScopeLabel(scopeType: CodeReviewScopeType, scopeRef?: CodeReviewScopeRef): string {
  if (scopeType === 'pull_request' && scopeRef?.pullRequest?.id) {
    const title = scopeRef.pullRequest.title?.trim();
    return title
      ? `Pull request #${scopeRef.pullRequest.id}: ${title}`
      : `Pull request #${scopeRef.pullRequest.id}`;
  }

  if (scopeType === 'commit_range' && scopeRef?.fromSha && scopeRef?.toSha) {
    return `Commit range ${scopeRef.fromSha.slice(0, 8)}..${scopeRef.toSha.slice(0, 8)}`;
  }

  if (scopeType === 'branch_diff' && scopeRef?.baseBranch && scopeRef?.compareBranch) {
    return `Branch diff ${scopeRef.baseBranch}..${scopeRef.compareBranch}`;
  }

  return scopeType.replace(/_/g, ' ');
}

function formatFindingLocation(filePath?: string, lineStart?: number, lineEnd?: number): string {
  if (!filePath) return 'Not specified';
  if (!lineStart) return filePath;
  if (lineEnd && lineEnd !== lineStart) {
    return `${filePath}:${lineStart}-${lineEnd}`;
  }
  return `${filePath}:${lineStart}`;
}
