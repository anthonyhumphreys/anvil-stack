// Main-process handler for the Review surface (spec §8.1): review_context /
// review_publish / review_patch tools, user actions, and sharing.

import {
  AgentToolError,
  assertRepoInScope,
  textResult,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolProvider,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import type { JsonSchema } from '../../../shared/surfaces/types.js';
import { REVIEW_SCOPE_TYPES, reviewScopeSchema } from '../../../shared/surfaces/kinds/review.js';
import {
  REVIEW_DECISIONS,
  REVIEW_FINDING_STATUSES,
  REVIEW_SEVERITIES,
  buildReviewDigest,
  describeReviewScope,
} from '../../../shared/surfaces/kinds/review/model.js';
import { normalizeReviewPath } from '../../../shared/surfaces/kinds/review/diff.js';
import type {
  ReviewScopeType,
  ReviewSurfaceData,
} from '../../../shared/surfaces/kinds/review/types.js';
import { getSurface, patchSurface, publishSurface } from '../core.js';
import type { MainSurfaceHandler } from '../types.js';
import { executeReviewAction } from './review/actions.js';
import {
  REVIEW_PATCH_OPS,
  ReviewInputError,
  applyReviewOps,
  buildReviewSurfaceData,
  opsNeedDiff,
} from './review/build.js';
import { buildReviewContextResult } from './review/context.js';
import {
  getReviewRepo,
  loadReviewDiff,
  scopeToRequest,
  type LoadedReviewDiff,
  type ReviewScopeRequest,
} from './review/scope-diff.js';
import { buildReviewSnapshot, redactReviewData } from './review/snapshot.js';

const findingInputSchema: JsonSchema = {
  type: 'object',
  description: 'One anchored finding. Lines are new-file line numbers inside a changed hunk.',
  required: ['severity', 'title', 'rationale', 'filePath', 'lineStart'],
  properties: {
    id: { type: 'string', description: 'Stable id (defaults to f1, f2…)' },
    severity: { type: 'string', enum: REVIEW_SEVERITIES },
    category: { type: 'string', description: 'e.g. Bug Risk, Security, Performance, Testing' },
    title: { type: 'string', description: 'One-line claim' },
    rationale: { type: 'string', description: 'Why it matters, in plain prose' },
    filePath: { type: 'string', description: 'Repo-relative path from the diff' },
    lineStart: { type: 'integer', minimum: 1 },
    lineEnd: { type: 'integer', minimum: 1 },
    suggestion: { type: 'string' },
    suggestedPatch: {
      type: 'string',
      description: 'Unified diff touching only filePath, applicable with git apply',
    },
    chapterId: { type: 'string' },
  },
};

const chapterInputSchema: JsonSchema = {
  type: 'object',
  required: ['title', 'files'],
  properties: {
    id: { type: 'string', description: 'Stable id (defaults to c1, c2…)' },
    title: {
      type: 'string',
      description: 'Narrative headline, e.g. "Token refresh moves to the gateway"',
    },
    summary: { type: 'string', description: 'Two or three sentences on what changed and why' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Repo-relative paths in this chapter',
    },
  },
};

const riskInputSchema: JsonSchema = {
  type: 'object',
  required: ['title', 'severity'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    severity: { type: 'string', enum: REVIEW_SEVERITIES },
    chapterId: { type: 'string' },
  },
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'review_context',
    title: 'Review context',
    description:
      'Start here for any code review ("review my changes", "review PR #42"). Returns the diff for the scope, a change summary, the review rubric and any PR context. Then write the review yourself and publish it with review_publish.',
    feature: 'codereview',
    requiresThread: false,
    inputSchema: {
      type: 'object',
      required: ['repoId', 'scope'],
      properties: {
        repoId: { type: 'string' },
        scope: {
          type: 'string',
          enum: REVIEW_SCOPE_TYPES,
          description:
            'turn: files edited in the latest turn · working-tree: all uncommitted changes · pull-request · commit-range',
        },
        pullRequestId: { type: 'string', description: 'Required for pull-request' },
        baseRef: { type: 'string', description: 'Required for commit-range' },
        headRef: { type: 'string', description: 'commit-range head (defaults to HEAD)' },
        maxBytes: {
          type: 'integer',
          minimum: 4000,
          maximum: 400000,
          description: 'Diff budget (default 120000)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only include these paths in the diff',
        },
      },
    },
  },
  {
    name: 'review_publish',
    title: 'Publish review',
    description:
      'Render your review as a native Review surface in the reply: verdict, chapters (the change told as a narrative), risks and anchored findings. Findings must be pinned to changed lines; unanchored claims are rejected. Returns {surfaceId, revision, digest}.',
    feature: 'codereview',
    inputSchema: {
      type: 'object',
      required: ['scope', 'chapters', 'findings'],
      properties: {
        scope: { ...reviewScopeSchema, description: 'The scope object returned by review_context' },
        verdict: {
          type: 'object',
          description: 'Omit decision to let Mezair compute it from severities',
          properties: {
            decision: { type: 'string', enum: REVIEW_DECISIONS },
            summary: { type: 'string', description: 'One sentence sign-off' },
          },
        },
        chapters: { type: 'array', items: chapterInputSchema, maxItems: 40 },
        findings: { type: 'array', items: findingInputSchema, maxItems: 500 },
        risks: { type: 'array', items: riskInputSchema, maxItems: 10 },
        streaming: { type: 'boolean', description: 'More findings will follow via review_patch' },
      },
    },
  },
  {
    name: 'review_patch',
    title: 'Update review',
    description:
      'Update a published Review in place: add_finding, set_status, update_finding, link_fix (after fixing findings), set_verdict, add_chapter, set_risks. Pass complete: true to end streaming. A stale baseRevision is a conflict.',
    feature: 'codereview',
    inputSchema: {
      type: 'object',
      required: ['surfaceId', 'baseRevision', 'ops'],
      properties: {
        surfaceId: { type: 'string' },
        baseRevision: { type: 'integer', minimum: 0 },
        ops: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            required: ['op'],
            properties: {
              op: { type: 'string', enum: REVIEW_PATCH_OPS },
              finding: findingInputSchema,
              findingId: { type: 'string' },
              findingIds: { type: 'array', items: { type: 'string' } },
              status: { type: 'string', enum: REVIEW_FINDING_STATUSES },
              reason: { type: 'string' },
              changes: { type: 'object' },
              surfaceId: { type: 'string', description: 'link_fix: surface whose diff fixed it' },
              note: { type: 'string' },
              decision: { type: 'string', enum: REVIEW_DECISIONS },
              summary: { type: 'string' },
              chapter: chapterInputSchema,
              risks: { type: 'array', items: riskInputSchema },
            },
          },
        },
        complete: { type: 'boolean', description: 'Ends streaming' },
      },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseScopeType(value: unknown): ReviewScopeType {
  if (typeof value !== 'string' || !(REVIEW_SCOPE_TYPES as readonly string[]).includes(value)) {
    throw new AgentToolError(
      `scope must be one of ${REVIEW_SCOPE_TYPES.join(', ')}`,
      'invalid-params',
    );
  }
  return value as ReviewScopeType;
}

function toToolError(error: unknown): never {
  if (error instanceof ReviewInputError) throw new AgentToolError(error.message, 'invalid-params');
  throw error;
}

function reviewTitle(diff: LoadedReviewDiff): string {
  const scope = diff.scope;
  if (scope.type === 'pull-request') {
    return `Review · PR #${scope.pullRequestId}${scope.title ? ` ${scope.title}` : ''}`;
  }
  return `Review · ${scope.title ?? describeReviewScope(scope)}`;
}

async function handleContext(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  const repoId = assertRepoInScope(ctx, args.repoId);
  const request: ReviewScopeRequest = {
    type: parseScopeType(args.scope),
    repoId,
    pullRequestId: optionalString(args.pullRequestId),
    baseRef: optionalString(args.baseRef),
    headRef: optionalString(args.headRef),
  };
  const diff = await loadReviewDiff(ctx, request, { fresh: true });
  const files = Array.isArray(args.files)
    ? args.files
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => normalizeReviewPath(entry, diff.repo.path))
    : undefined;
  return buildReviewContextResult(diff, {
    maxBytes: typeof args.maxBytes === 'number' ? args.maxBytes : undefined,
    files,
  });
}

function parsePublishScope(ctx: AgentToolSessionContext, raw: unknown): ReviewScopeRequest {
  if (!isRecord(raw)) {
    throw new AgentToolError(
      'scope must be the object returned by review_context',
      'invalid-params',
    );
  }
  const repoId = assertRepoInScope(ctx, raw.repoId);
  const type = parseScopeType(raw.type);
  return {
    type,
    repoId,
    pullRequestId: optionalString(raw.pullRequestId),
    ref: type === 'commit-range' ? optionalString(raw.ref) : undefined,
    baseRef: optionalString(raw.baseRef),
    headRef: optionalString(raw.headRef),
    title: optionalString(raw.title),
  };
}

async function handlePublish(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  const request = parsePublishScope(ctx, args.scope);
  const diff = await loadReviewDiff(ctx, request);
  if (diff.files.length === 0) {
    throw new AgentToolError(
      `There are no changes in the ${describeReviewScope(diff.scope)} to review. Tell the user instead of publishing.`,
      'invalid-params',
    );
  }
  let data: ReviewSurfaceData;
  try {
    data = buildReviewSurfaceData(
      {
        verdict: args.verdict,
        chapters: args.chapters,
        findings: args.findings,
        risks: args.risks,
      },
      { scope: diff.scope, files: diff.files, repoPath: diff.repo.path, notes: diff.notes },
    );
  } catch (error) {
    toToolError(error);
  }
  const intent = publishSurface<ReviewSurfaceData>(ctx, {
    surfaceKind: 'review',
    title: reviewTitle(diff),
    key: diff.key,
    data,
    streaming: args.streaming === true,
  });
  const digest = buildReviewDigest(data);
  return textResult(`Published review ${intent.id} (revision ${intent.revision}).\n${digest}`, {
    surfaceId: intent.id,
    revision: intent.revision,
    digest,
  });
}

async function handlePatch(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): Promise<AgentToolCallResult> {
  const surfaceId = optionalString(args.surfaceId);
  if (!surfaceId) throw new AgentToolError('surfaceId is required', 'invalid-params');
  const intent = getSurface(surfaceId);
  if (!intent || intent.payload.surfaceKind !== 'review') {
    throw new AgentToolError(`No review surface ${surfaceId}`, 'not-found');
  }
  if (ctx.appThreadId && intent.scope.threadId !== ctx.appThreadId) {
    throw new AgentToolError('That review belongs to another thread.', 'forbidden');
  }
  const current = intent.payload.data as ReviewSurfaceData;
  assertRepoInScope(ctx, current.scope.repoId);
  if (typeof args.baseRevision !== 'number' || !Number.isInteger(args.baseRevision)) {
    throw new AgentToolError(
      'baseRevision must be the integer revision you last saw',
      'invalid-params',
    );
  }
  const ops = Array.isArray(args.ops) ? args.ops : null;
  if (!ops) throw new AgentToolError('ops must be an array', 'invalid-params');
  const complete = args.complete === true;
  if (ops.length === 0 && !complete) {
    throw new AgentToolError('Pass at least one op, or complete: true', 'invalid-params');
  }

  let diffContext: Parameters<typeof applyReviewOps>[2];
  if (opsNeedDiff(ops)) {
    const diff = await loadReviewDiff(ctx, scopeToRequest(current.scope));
    diffContext = { scope: current.scope, files: diff.files, repoPath: diff.repo.path };
  }
  let updated;
  try {
    updated = patchSurface<ReviewSurfaceData>(
      surfaceId,
      args.baseRevision,
      (data) => applyReviewOps(data, ops, diffContext),
      complete ? { streaming: false } : undefined,
    );
  } catch (error) {
    toToolError(error);
  }
  const digest = buildReviewDigest(updated.payload.data as ReviewSurfaceData);
  return textResult(`Updated review ${updated.id} (revision ${updated.revision}).\n${digest}`, {
    surfaceId: updated.id,
    revision: updated.revision,
    digest,
  });
}

export const reviewToolProvider: AgentToolProvider = {
  id: 'review',
  tools: () => TOOLS,
  async call(ctx, name, args) {
    switch (name) {
      case 'review_context':
        return handleContext(ctx, args);
      case 'review_publish':
        return handlePublish(ctx, args);
      case 'review_patch':
        return handlePatch(ctx, args);
      default:
        return undefined;
    }
  },
};

function repoPathFor(data: ReviewSurfaceData): string | undefined {
  try {
    return getReviewRepo(data.scope.repoId).path;
  } catch {
    return undefined;
  }
}

export const reviewSurfaceHandler: MainSurfaceHandler = {
  kind: 'review',
  toolProvider: reviewToolProvider,
  executeAction: executeReviewAction,
  share: {
    redact: (data) => {
      const review = data as ReviewSurfaceData;
      return redactReviewData(review, repoPathFor(review));
    },
    snapshot: (data, title, options) =>
      buildReviewSnapshot(data as ReviewSurfaceData, title, options),
  },
};
