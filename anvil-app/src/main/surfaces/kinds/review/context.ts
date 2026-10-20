// review_context: the diff, change summary, rubric and PR context the session
// agent needs to write the review itself (spec §7, §8.1).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentToolCallResult } from '../../../agent-tools/dispatch.js';
import { loadPromptTemplate } from '../../../utils/prompt-templates.js';
import { parseGitHubRemoteUrl } from '../../../services/code-review-pr.service.js';
import { getLatestPullRequestVisualisation } from '../../../services/pull-request-visualisation-persistence.service.js';
import { describeReviewScope } from '../../../../shared/surfaces/kinds/review/model.js';
import type { LoadedReviewDiff } from './scope-diff.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CONTEXT_BYTES = 120_000;
export const MAX_CONTEXT_BYTES = 400_000;

const FALLBACK_RUBRIC = `- **Architecture & Design** — appropriate abstractions and separation of responsibility.
- **Bug Risk** — edge cases, races, off-by-one, null/undefined, wrong assumptions.
- **Performance** — N+1 queries, expensive loops, leaks, missing caching.
- **Security** — input validation, injection, auth gaps, sensitive data exposure.
- **Error Handling** — errors caught, surfaced and handled gracefully.
- **Testing** — missing cases for edge and error paths.
- **Maintainability** — naming, magic numbers, undocumented complexity.
- **API Design** — clean contracts; breaking changes handled.
- **Concurrency** — async correctness, promise handling.
- **Dependencies** — justified, without known vulnerabilities.`;

/** The focus areas from prompts/code-review-senior.md (the prompt's I/O format doesn't apply here). */
export function loadReviewRubric(): string {
  try {
    const template = loadPromptTemplate('code-review-senior.md', {});
    const match = /## Default Focus Areas[^\n]*\n([\s\S]*?)(?=\n## )/.exec(template);
    return match?.[1]?.trim() || FALLBACK_RUBRIC;
  } catch {
    return FALLBACK_RUBRIC;
  }
}

export const PUBLISH_GUIDE = `- Write it like a senior engineer's review, not a linter dump: a verdict sentence, then the change told as 2–6 chapters (numbered narrative: what moved and why), then findings.
- Severity: critical (data loss, security hole, outage) · high (likely bug or regression) · medium (should fix before merge) · low (worth doing) · info (observation).
- Every finding needs filePath + lineStart/lineEnd: new-file line numbers inside a changed hunk (from the @@ headers below; old-file lines for deleted files). Unanchored claims are rejected.
- Optional per finding: suggestion (prose), suggestedPatch (unified diff touching only that file, applicable with git apply), chapterId.
- Omit verdict.decision to let Anvil compute it from severities; if you set it, it must agree with them.
- Large reviews: review_publish with streaming: true and the chapters first, then review_patch add_finding as you go, then review_patch with complete: true.
- When you fix findings later, call review_patch with link_fix for each one.`;

interface GithubReviewComment {
  id: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  in_reply_to_id?: number;
  user?: { login?: string };
}

async function loadGithubReviewComments(diff: LoadedReviewDiff): Promise<string[]> {
  const spec = diff.repo.remoteUrl ? parseGitHubRemoteUrl(diff.repo.remoteUrl) : null;
  if (!spec || !diff.scope.pullRequestId) return [];
  const args = ['api'];
  if (spec.host !== 'github.com') args.push('--hostname', spec.host);
  args.push(
    `repos/${spec.owner}/${spec.repo}/pulls/${diff.scope.pullRequestId}/comments?per_page=100`,
  );
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const comments = JSON.parse(stdout) as GithubReviewComment[];
    return comments.slice(0, 40).map((comment) => {
      const line = comment.line ?? comment.original_line;
      const where = comment.path ? `${comment.path}${line ? `:${line}` : ''}` : 'general';
      const body = (comment.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const reply = comment.in_reply_to_id ? ' (reply)' : '';
      return `- ${where} · @${comment.user?.login ?? 'unknown'}${reply}: ${body}`;
    });
  } catch {
    return [];
  }
}

function chapterSeed(diff: LoadedReviewDiff): string[] {
  if (diff.scope.type !== 'pull-request' || !diff.scope.pullRequestId) return [];
  try {
    const visualisation = getLatestPullRequestVisualisation(diff.repo.id, diff.scope.pullRequestId);
    if (!visualisation || visualisation.status !== 'ready') return [];
    return visualisation.chapters.map(
      (chapter, index) => `${index + 1}. ${chapter.title} — ${chapter.summary}`,
    );
  } catch {
    return [];
  }
}

function statusLetter(status: string): string {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : status === 'renamed' ? 'R' : 'M';
}

export interface BuildContextOptions {
  maxBytes?: number;
  files?: string[];
}

export async function buildReviewContextResult(
  diff: LoadedReviewDiff,
  options: BuildContextOptions = {},
): Promise<AgentToolCallResult> {
  const budget = Math.min(
    Math.max(options.maxBytes ?? DEFAULT_CONTEXT_BYTES, 4_000),
    MAX_CONTEXT_BYTES,
  );
  const wanted = options.files?.length ? new Set(options.files) : null;
  const totals = diff.files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const scopeArg = JSON.stringify(diff.scope);
  const lines: string[] = [
    `# Review context — ${diff.repo.name} · ${describeReviewScope(diff.scope)}`,
    '',
    `Pass this exact object as \`scope\` to review_publish: ${scopeArg}`,
    `Surface key: ${diff.key}`,
    '',
    '## Change summary',
    `${diff.files.length} files · +${totals.additions} −${totals.deletions}`,
    ...diff.files
      .slice(0, 300)
      .map(
        (file) =>
          `- ${statusLetter(file.status)} ${file.previousPath ? `${file.previousPath} → ` : ''}${file.path} (+${file.additions} −${file.deletions})${file.binary ? ' [binary]' : ''}`,
      ),
  ];
  if (diff.files.length > 300) lines.push(`- … ${diff.files.length - 300} more files`);
  if (diff.files.length === 0) {
    lines.push(
      '',
      'There are no changes in this scope. Tell the user rather than publishing an empty review.',
    );
  }
  if (diff.notes.length) lines.push('', '## Notes', ...diff.notes.map((note) => `- ${note}`));

  if (diff.pullRequest) {
    const pr = diff.pullRequest;
    lines.push(
      '',
      '## Pull request',
      `#${pr.id} ${pr.title}${pr.author ? ` · by ${pr.author}` : ''} · ${pr.sourceBranch} → ${pr.targetBranch} · ${pr.state}${pr.isDraft ? ' (draft)' : ''}`,
    );
    if (pr.description) lines.push('', pr.description.slice(0, 2_000));
  }
  const seed = chapterSeed(diff);
  if (seed.length) lines.push('', '## Chapter seed (from the last PR visualisation)', ...seed);
  const threads = await loadGithubReviewComments(diff);
  if (threads.length) lines.push('', '## Existing PR review comments', ...threads);

  lines.push('', '## Rubric', loadReviewRubric(), '', '## How to publish', PUBLISH_GUIDE);

  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const diffParts: string[] = [];
  for (const file of diff.files) {
    if (wanted && !wanted.has(file.path)) continue;
    const raw = diff.rawByPath.get(file.path) ?? '';
    if (!raw) continue;
    if (used + raw.length > budget && included.length > 0) {
      omitted.push(file.path);
      continue;
    }
    if (raw.length > budget) {
      diffParts.push(`${raw.slice(0, budget)}\n… [diff for ${file.path} truncated]\n`);
      used += budget;
    } else {
      diffParts.push(raw);
      used += raw.length;
    }
    included.push(file.path);
  }
  lines.push(
    '',
    `## Diff (${included.length} of ${wanted ? wanted.size : diff.files.length} files, ${Math.round(used / 1024)} KB)`,
    '```diff',
    diffParts.join('').trimEnd(),
    '```',
  );
  if (omitted.length) {
    lines.push(
      '',
      `Omitted to stay within the ${Math.round(budget / 1024)} KB budget (${omitted.length} file${omitted.length === 1 ? '' : 's'}): ${omitted.slice(0, 60).join(', ')}`,
      'Read them with review_context again, passing `files: [...]` (and maxBytes if needed).',
    );
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      scope: diff.scope,
      key: diff.key,
      stats: { files: diff.files.length, ...totals },
      files: diff.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
      includedFiles: included,
      omittedFiles: omitted,
      truncated: omitted.length > 0,
    },
  };
}
