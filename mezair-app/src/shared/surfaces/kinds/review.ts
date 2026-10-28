// Review surface kind (docs/plans/inline-artifacts-and-canvas-tools.md §8.1).
// Payload types and pure rules live under ./review/; this file is the
// registry entry: schema, actions, anchors and digest.

import type { JsonSchema, SurfaceKindDefinition } from '../types.js';
import {
  REVIEW_DECISIONS,
  REVIEW_FINDING_STATUSES,
  REVIEW_SEVERITIES,
  buildReviewDigest,
} from './review/model.js';
import type { ReviewSurfaceData } from './review/types.js';

export type * from './review/types.js';

const str = (description?: string, maxLength?: number): JsonSchema => ({
  type: 'string',
  ...(description ? { description } : {}),
  ...(maxLength ? { maxLength } : {}),
});
const int = (description?: string): JsonSchema => ({
  type: 'integer',
  minimum: 0,
  ...(description ? { description } : {}),
});

export const REVIEW_SCOPE_TYPES = ['turn', 'working-tree', 'pull-request', 'commit-range'] as const;

export const reviewScopeSchema: JsonSchema = {
  type: 'object',
  required: ['type', 'repoId'],
  properties: {
    type: { type: 'string', enum: REVIEW_SCOPE_TYPES },
    repoId: str(),
    ref: str('commit-range: base..head; pull-request: head ref'),
    pullRequestId: str(),
    title: str(undefined, 300),
  },
};

const severitySchema: JsonSchema = { type: 'string', enum: REVIEW_SEVERITIES };

export const reviewHunkSchema: JsonSchema = {
  type: 'object',
  required: ['header', 'lines'],
  properties: {
    header: str(),
    lines: { type: 'array', items: { type: 'string' } },
  },
};

const hunkMapSchema: JsonSchema = {
  type: 'object',
  additionalProperties: { type: 'array', items: reviewHunkSchema },
};

export const reviewFindingSchema: JsonSchema = {
  type: 'object',
  required: [
    'id',
    'severity',
    'category',
    'title',
    'rationale',
    'filePath',
    'lineStart',
    'lineEnd',
    'status',
  ],
  properties: {
    id: str(undefined, 80),
    severity: severitySchema,
    category: str(undefined, 80),
    title: str(undefined, 300),
    rationale: str(undefined, 8000),
    filePath: str(),
    lineStart: { type: 'integer', minimum: 1 },
    lineEnd: { type: 'integer', minimum: 1 },
    suggestion: str(undefined, 8000),
    suggestedPatch: str(undefined, 60_000),
    status: { type: 'string', enum: REVIEW_FINDING_STATUSES },
    dismissReason: str(undefined, 2000),
    fixedInSurfaceId: str(),
    fixNote: str(undefined, 2000),
    chapterId: str(),
    prCommentUrl: str(),
    workItem: {
      type: 'object',
      required: ['id'],
      properties: { id: str(), title: str(), url: str() },
    },
  },
};

export const reviewSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['scope', 'verdict', 'stats', 'risks', 'chapters', 'findings', 'files', 'hunks'],
  properties: {
    scope: reviewScopeSchema,
    verdict: {
      type: 'object',
      required: ['decision', 'summary'],
      properties: {
        decision: { type: 'string', enum: REVIEW_DECISIONS },
        summary: str(undefined, 600),
        source: { type: 'string', enum: ['agent', 'computed'] },
      },
    },
    stats: {
      type: 'object',
      required: ['files', 'additions', 'deletions'],
      properties: { files: int(), additions: int(), deletions: int() },
    },
    risks: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['id', 'title', 'severity'],
        properties: {
          id: str(),
          title: str(undefined, 300),
          chapterId: str(),
          severity: severitySchema,
        },
      },
    },
    chapters: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        required: ['id', 'index', 'title', 'summary', 'files'],
        properties: {
          id: str(),
          index: { type: 'integer', minimum: 1 },
          title: str(undefined, 300),
          summary: str(undefined, 4000),
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'additions', 'deletions'],
              properties: { path: str(), additions: int(), deletions: int() },
            },
          },
        },
      },
    },
    findings: { type: 'array', maxItems: 500, items: reviewFindingSchema },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'status', 'additions', 'deletions'],
        properties: {
          path: str(),
          previousPath: str(),
          status: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed'] },
          additions: int(),
          deletions: int(),
        },
      },
    },
    hunks: hunkMapSchema,
    fullDiff: hunkMapSchema,
    fullDiffOmitted: { type: 'boolean' },
    notes: { type: 'array', items: str() },
    prComments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['postedAt', 'findingIds'],
        properties: {
          url: str(),
          postedAt: str(),
          findingIds: { type: 'array', items: str() },
        },
      },
    },
  },
};

export type ReviewActionId =
  'accept' | 'dismiss' | 'reopen' | 'ask_fix' | 'apply_patch' | 'post_to_pr' | 'create_work_items';

export const REVIEW_ASK_FIX_TEMPLATE =
  'Please fix these review findings, then call review_patch with link_fix for each one you fixed:\n{{findings}}\n{{note}}';

export const reviewSurfaceKind: SurfaceKindDefinition<ReviewSurfaceData> = {
  kind: 'review',
  label: 'Review',
  schema: reviewSurfaceSchema,
  actions: {
    accept: {
      label: 'Accept',
      semantics: { type: 'mezair-command', command: 'review.accept' },
      shortcut: 'a',
      targets: 'many',
    },
    dismiss: {
      label: 'Dismiss',
      semantics: { type: 'mezair-command', command: 'review.dismiss' },
      shortcut: 'd',
      targets: 'many',
    },
    reopen: {
      label: 'Reopen',
      semantics: { type: 'mezair-command', command: 'review.reopen' },
      targets: 'many',
    },
    ask_fix: {
      label: 'Ask agent to fix',
      semantics: { type: 'agent-message', template: REVIEW_ASK_FIX_TEMPLATE },
      shortcut: 'f',
      targets: 'many',
    },
    apply_patch: {
      label: 'Apply suggested patch',
      semantics: { type: 'mutation', command: 'review.applyPatch', approval: true },
      targets: 'one',
    },
    post_to_pr: {
      label: 'Post to PR',
      semantics: { type: 'mutation', command: 'review.postToPullRequest', approval: true },
      targets: 'many',
    },
    create_work_items: {
      label: 'Create work items',
      semantics: { type: 'mutation', command: 'review.createWorkItems', approval: true },
      targets: 'many',
    },
  },
  anchors: ['surface', 'diff-range', 'finding', 'chapter'],
  digest: (payload) => buildReviewDigest(payload),
  feature: 'codereview',
  wide: true,
  shareable: true,
};
