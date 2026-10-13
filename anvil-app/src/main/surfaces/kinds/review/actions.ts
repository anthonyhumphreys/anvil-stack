// User actions on a Review surface (spec §5.3, §8.1). The user's click (plus
// the renderer's confirm for mutations) is the approval; nothing here runs on
// the agent's behalf.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deliverSurfaceFeedback, getSurface, patchSurface } from '../../core.js';
import { postCommentToPullRequest } from '../../../services/code-review-pr.service.js';
import { getActiveProvider } from '../../../services/workitem-provider.js';
import type {
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../../../shared/surfaces/types.js';
import { parseUnifiedDiff } from '../../../../shared/surfaces/kinds/review/diff.js';
import {
  DECISION_LABEL,
  SEVERITY_LABEL,
  formatFindingLocation,
  isActiveFinding,
  reconcileVerdict,
  severityRank,
  verdictHeadline,
} from '../../../../shared/surfaces/kinds/review/model.js';
import type {
  ReviewFinding,
  ReviewFindingStatus,
  ReviewSurfaceData,
} from '../../../../shared/surfaces/kinds/review/types.js';
import type { SurfaceActionContext } from '../../types.js';
import { setFindingStatus } from './build.js';
import { getReviewRepo } from './scope-diff.js';

const execFileAsync = promisify(execFile);

function fail(error: string): SurfaceActionResult {
  return { ok: false, error };
}

function currentData(ctx: SurfaceActionContext, surfaceId: string): ReviewSurfaceData | null {
  const intent = getSurface(surfaceId) ?? ctx.intent;
  if (!intent || intent.payload.surfaceKind !== 'review') return null;
  return intent.payload.data as ReviewSurfaceData;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function buildAskFixMessage(
  surfaceId: string,
  findings: readonly ReviewFinding[],
  note?: string,
): string {
  const lines = [
    `The user asked you to fix ${plural(findings.length, 'review finding')} from Review ${surfaceId}:`,
    '',
  ];
  for (const finding of findings) {
    lines.push(
      `- ${finding.id} · ${SEVERITY_LABEL[finding.severity]} · ${formatFindingLocation(finding)} — ${finding.title}`,
    );
    if (finding.suggestion)
      lines.push(`  Suggestion: ${finding.suggestion.replace(/\s+/g, ' ').slice(0, 400)}`);
    if (finding.suggestedPatch)
      lines.push('  A suggested patch is attached to this finding (surface_read for detail).');
  }
  if (note?.trim()) lines.push('', `User note: ${note.trim()}`);
  lines.push(
    '',
    `When each fix is in, call review_patch on ${surfaceId} with { op: 'link_fix', findingIds: [...], note: '<one line on what changed>' }.`,
    'If you decide a finding should not be fixed, say why and leave it for the user to dismiss.',
  );
  return lines.join('\n');
}

export function buildPullRequestReviewBody(
  data: ReviewSurfaceData,
  findings: readonly ReviewFinding[],
): string {
  const lines = [
    `### Anvil review: ${verdictHeadline(data.verdict.decision, data.findings)}`,
    '',
    `**${DECISION_LABEL[data.verdict.decision]}** — ${data.verdict.summary}`,
    '',
    `${plural(data.stats.files, 'file')} · +${data.stats.additions} −${data.stats.deletions}`,
  ];
  if (data.chapters.length) {
    lines.push('', '#### The change');
    for (const chapter of data.chapters) {
      lines.push(
        `${chapter.index}. **${chapter.title}**${chapter.summary ? ` — ${chapter.summary}` : ''}`,
      );
    }
  }
  if (findings.length) {
    lines.push('', '#### Findings');
    const sorted = [...findings].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    );
    for (const finding of sorted) {
      lines.push(
        '',
        `- **${SEVERITY_LABEL[finding.severity]}** \`${formatFindingLocation(finding)}\` — ${finding.title}`,
        `  ${finding.rationale.replace(/\n+/g, ' ')}`,
      );
      if (finding.suggestion)
        lines.push(`  _Suggestion:_ ${finding.suggestion.replace(/\n+/g, ' ')}`);
    }
  }
  lines.push('', '_Posted from Anvil._');
  return lines.join('\n');
}

function resolveTargets(
  data: ReviewSurfaceData,
  request: SurfaceActionRequest,
): { findings: ReviewFinding[]; error?: string } {
  const ids = request.targetIds ?? [];
  const unknown = ids.filter((id) => !data.findings.some((finding) => finding.id === id));
  if (unknown.length) return { findings: [], error: `Unknown finding(s): ${unknown.join(', ')}` };
  return { findings: data.findings.filter((finding) => ids.includes(finding.id)) };
}

async function setStatuses(
  surfaceId: string,
  ids: string[],
  status: ReviewFindingStatus,
  extras: Parameters<typeof setFindingStatus>[3] = {},
): Promise<void> {
  patchSurface<ReviewSurfaceData>(surfaceId, undefined, (data) =>
    setFindingStatus(data, ids, status, extras),
  );
}

/** Normalises an agent-written patch so `git apply` accepts it. */
export function preparePatch(patch: string, filePath: string): string {
  let body = patch.replace(/\r\n/g, '\n');
  if (!/^--- /m.test(body)) body = `--- a/${filePath}\n+++ b/${filePath}\n${body}`;
  return body.endsWith('\n') ? body : `${body}\n`;
}

export async function applyPatchToWorkingTree(repoPath: string, patch: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'anvil-review-patch-'));
  const file = join(dir, 'suggested.patch');
  try {
    await writeFile(file, patch, 'utf-8');
    const run = (extra: string[]) =>
      execFileAsync('git', ['apply', ...extra, '--recount', '--whitespace=nowarn', file], {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    try {
      await run(['--check']);
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      throw new Error(
        `The suggested patch no longer applies cleanly${stderr ? `: ${stderr.split('\n')[0]}` : '.'} Ask the agent to fix it instead.`,
      );
    }
    await run([]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function executeReviewAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  const data = currentData(ctx, request.surfaceId);
  if (!data) return fail('This review is no longer available.');
  const { findings, error } = resolveTargets(data, request);
  if (error) return fail(error);
  const ids = findings.map((finding) => finding.id);

  try {
    switch (request.action) {
      case 'accept': {
        if (!ids.length) return fail('Select at least one finding to accept.');
        await setStatuses(request.surfaceId, ids, 'accepted');
        return { ok: true, message: `Accepted ${plural(ids.length, 'finding')}.` };
      }
      case 'dismiss': {
        if (!ids.length) return fail('Select at least one finding to dismiss.');
        const reason = request.note?.trim();
        if (!reason) return fail('Add a short reason so the agent learns from the dismissal.');
        await setStatuses(request.surfaceId, ids, 'dismissed', {
          dismissReason: reason.slice(0, 2000),
        });
        return { ok: true, message: `Dismissed ${plural(ids.length, 'finding')}.` };
      }
      case 'reopen': {
        if (!ids.length) return fail('Select at least one finding to reopen.');
        await setStatuses(request.surfaceId, ids, 'open');
        return { ok: true, message: `Reopened ${plural(ids.length, 'finding')}.` };
      }
      case 'ask_fix': {
        const targets = findings.filter((finding) => finding.status !== 'fixed');
        if (!targets.length) return fail('Select at least one unfixed finding.');
        const previous = new Map(targets.map((finding) => [finding.id, finding]));
        const targetIds = [...previous.keys()];
        await setStatuses(request.surfaceId, targetIds, 'fix-requested');
        let delivered = false;
        try {
          delivered = await deliverSurfaceFeedback(
            request.surfaceId,
            buildAskFixMessage(request.surfaceId, targets, request.note),
          );
        } catch {
          delivered = false;
        }
        if (!delivered) {
          // Restore exactly what was there (status and any dismiss reason).
          patchSurface<ReviewSurfaceData>(request.surfaceId, undefined, (current) => {
            const findings = current.findings.map((finding) => {
              const before = previous.get(finding.id);
              if (!before || finding.status !== 'fix-requested') return finding;
              const restored: ReviewFinding = { ...finding, status: before.status };
              if (before.dismissReason) restored.dismissReason = before.dismissReason;
              return restored;
            });
            return { ...current, findings, verdict: reconcileVerdict(current.verdict, findings) };
          });
          return fail(
            'The agent session for this review has ended. Start a new turn to ask for fixes.',
          );
        }
        return {
          ok: true,
          message: `Asked the agent to fix ${plural(targetIds.length, 'finding')}.`,
        };
      }
      case 'apply_patch': {
        if (findings.length !== 1) return fail('Apply one suggested patch at a time.');
        const [finding] = findings;
        if (!finding.suggestedPatch) return fail('This finding has no suggested patch.');
        const patch = preparePatch(finding.suggestedPatch, finding.filePath);
        const touched = parseUnifiedDiff(patch).map((file) => file.path);
        if (touched.some((path) => path !== finding.filePath)) {
          return fail(`The suggested patch touches files other than ${finding.filePath}.`);
        }
        const repo = getReviewRepo(data.scope.repoId);
        await applyPatchToWorkingTree(repo.path, patch);
        await setStatuses(request.surfaceId, ids, 'fixed', {
          fixNote: 'Applied the suggested patch to the working tree.',
        });
        return { ok: true, message: `Applied the patch to ${finding.filePath}.` };
      }
      case 'post_to_pr': {
        if (data.scope.type !== 'pull-request' || !data.scope.pullRequestId) {
          return fail(
            'This review is not attached to a pull request, so there is nowhere to post it.',
          );
        }
        const repo = getReviewRepo(data.scope.repoId);
        const posting = ids.length ? findings : data.findings.filter(isActiveFinding);
        const comment = await postCommentToPullRequest(
          repo.remoteUrl,
          { id: data.scope.pullRequestId },
          buildPullRequestReviewBody(data, posting),
        );
        const postedIds = posting.map((finding) => finding.id);
        patchSurface<ReviewSurfaceData>(request.surfaceId, undefined, (current) => ({
          ...current,
          findings: current.findings.map((finding) =>
            postedIds.includes(finding.id) && comment.url
              ? { ...finding, prCommentUrl: comment.url }
              : finding,
          ),
          prComments: [
            ...(current.prComments ?? []),
            {
              ...(comment.url ? { url: comment.url } : {}),
              postedAt: comment.postedAt,
              findingIds: postedIds,
            },
          ],
        }));
        return { ok: true, message: `Posted the review to PR #${data.scope.pullRequestId}.` };
      }
      case 'create_work_items': {
        if (!ids.length) return fail('Select the findings to turn into work items.');
        const provider = getActiveProvider();
        if (!provider) {
          return fail(
            'No work item provider is connected. Connect Azure DevOps, Linear or Jira in Settings.',
          );
        }
        const pending = findings.filter((finding) => !finding.workItem);
        if (!pending.length) return fail('Those findings already have work items.');
        const created = new Map<string, { id: string; title: string; url?: string }>();
        const failures: string[] = [];
        for (const finding of pending) {
          try {
            const item = await provider.createItem({
              title: `${SEVERITY_LABEL[finding.severity]}: ${finding.title}`.slice(0, 250),
              description: [
                `${formatFindingLocation(finding)} · ${finding.category}`,
                '',
                finding.rationale,
                ...(finding.suggestion ? ['', `Suggestion: ${finding.suggestion}`] : []),
                '',
                'Raised from an Anvil review.',
              ].join('\n'),
            });
            created.set(finding.id, { id: item.id, title: item.title, url: item.url });
          } catch (reason) {
            failures.push(
              `${finding.id}: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          }
        }
        if (created.size) {
          patchSurface<ReviewSurfaceData>(request.surfaceId, undefined, (current) => ({
            ...current,
            findings: current.findings.map((finding) => {
              const item = created.get(finding.id);
              return item ? { ...finding, workItem: item } : finding;
            }),
          }));
        }
        if (failures.length && !created.size)
          return fail(`Could not create work items: ${failures.join('; ')}`);
        return {
          ok: true,
          message: failures.length
            ? `Created ${plural(created.size, 'work item')}; ${failures.length} failed: ${failures.join('; ')}`
            : `Created ${plural(created.size, 'work item')}.`,
        };
      }
      default:
        return fail(`Unknown review action: ${request.action}`);
    }
  } catch (reason) {
    return fail(reason instanceof Error ? reason.message : String(reason));
  }
}
