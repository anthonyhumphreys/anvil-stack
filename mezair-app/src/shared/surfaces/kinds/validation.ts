import type { ReviewSnapshot, WorkItemReference } from '../../change-review-types.js';
import type { JsonSchema, SurfaceKindDefinition } from '../types.js';

export type ValidationStatus = 'unchecked' | 'running' | 'passed' | 'failed' | 'blocked';
export interface ValidationCriterion {
  id: string;
  text: string;
  method: 'command' | 'browser' | 'manual' | 'inspection';
  instruction: string;
  command?: string;
  basis?: 'work-item' | 'request' | 'inferred';
  result?: {
    status: ValidationStatus;
    summary: string;
    evidence: string;
    provenance: 'runner-observed' | 'agent-reported';
    recordedAt: string;
  };
}
export interface ValidationSource {
  kind: 'prompt' | 'work-item';
  text: string;
  workItemRef?: WorkItemReference;
  workItemTitle?: string;
}
export interface ValidationSurfaceData {
  repoId: string;
  repoName: string;
  source: ValidationSource;
  request?: string;
  snapshot: ReviewSnapshot;
  criteriaVersion: string;
  criteria: ValidationCriterion[];
  freshness: 'current' | 'stale' | 'unknown';
  freshnessDetail?: string;
  legacyReviewId?: string;
  history?: { id: string; outcome: string; recordedAt: string; summary: string }[];
  /** Main-resolved workflow identity. Never supplied by the agent. */
  workflowRunId?: string;
}

const text = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });
export const validationCriterionSchema: JsonSchema = {
  type: 'object',
  required: ['id', 'text', 'method', 'instruction'],
  properties: {
    id: text(100),
    text: text(2000),
    method: { type: 'string', enum: ['command', 'browser', 'manual', 'inspection'] },
    instruction: text(4000),
    command: text(2000),
    basis: { type: 'string', enum: ['work-item', 'request', 'inferred'] },
    result: {
      type: 'object',
      required: ['status', 'summary', 'evidence', 'provenance', 'recordedAt'],
      properties: {
        status: { type: 'string', enum: ['unchecked', 'running', 'passed', 'failed', 'blocked'] },
        summary: text(4000),
        evidence: { type: 'string', maxLength: 16000 },
        provenance: { type: 'string', enum: ['runner-observed', 'agent-reported'] },
        recordedAt: text(100),
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
export const workItemReferenceSchema: JsonSchema = {
  type: 'object',
  required: ['connectionId', 'provider', 'id'],
  properties: {
    connectionId: text(200),
    provider: { type: 'string', enum: ['ado', 'jira', 'linear', 'github'] },
    id: text(2048),
  },
  additionalProperties: false,
};
export const validationSurfaceSchema: JsonSchema = {
  type: 'object',
  required: [
    'repoId',
    'repoName',
    'source',
    'snapshot',
    'criteriaVersion',
    'criteria',
    'freshness',
  ],
  properties: {
    repoId: text(200),
    repoName: text(300),
    request: { type: 'string', maxLength: 60000 },
    criteriaVersion: text(100),
    source: {
      type: 'object',
      required: ['kind', 'text'],
      properties: {
        kind: { type: 'string', enum: ['prompt', 'work-item'] },
        text: { type: 'string', maxLength: 60000 },
        workItemRef: workItemReferenceSchema,
        workItemTitle: text(500),
      },
      additionalProperties: false,
    },
    snapshot: {
      type: 'object',
      required: ['head', 'tree', 'capturedAt'],
      properties: { head: text(100), tree: text(100), capturedAt: text(100) },
      additionalProperties: false,
    },
    criteria: { type: 'array', maxItems: 30, items: validationCriterionSchema },
    freshness: { type: 'string', enum: ['current', 'stale', 'unknown'] },
    freshnessDetail: text(2000),
    legacyReviewId: text(200),
    workflowRunId: text(200),
    history: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        required: ['id', 'outcome', 'recordedAt', 'summary'],
        properties: {
          id: text(200),
          outcome: text(100),
          recordedAt: text(100),
          summary: text(2000),
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export function validationSummary(data: ValidationSurfaceData): string {
  if (data.freshness !== 'current') return 'Evidence needs refreshing';
  const statuses = data.criteria.map((criterion) => criterion.result?.status ?? 'unchecked');
  if (statuses.includes('running')) return 'Validation running';
  if (statuses.includes('failed')) return 'Validation found failures';
  if (statuses.includes('blocked')) return 'Validation is blocked';
  if (statuses.length && statuses.every((status) => status === 'passed'))
    return 'All criteria passed';
  return 'Ready to validate';
}

export function validationWorkflowPrompt(data: ValidationSurfaceData): string {
  return [
    'Validate the current implementation against the following expectations. This workflow step explicitly requests validation.',
    data.source.workItemRef
      ? `Use this workflow run's linked work item when present; otherwise refresh acceptance criteria from ${JSON.stringify(data.source.workItemRef)}. Read fresh criteria before planning.`
      : `Original request:\n${data.source.text}`,
    ...data.criteria.map(
      (criterion) =>
        `- ${criterion.text}\n  Check: ${criterion.instruction}${criterion.command ? `\n  Command: ${criterion.command}` : ''}`,
    ),
    'Use validation_context, then validation_publish. Ask a conversational question only for material ambiguity. Run command checks with validation_run and record other evidence with validation_record. Follow the current session permissions. Keep unsupported or unobserved behaviour unchecked or blocked. Do not infer human acceptance or reuse results from a previous source snapshot.',
  ].join('\n\n');
}

export const validationSurfaceKind: SurfaceKindDefinition<ValidationSurfaceData> = {
  kind: 'validation',
  label: 'Validation',
  schema: validationSurfaceSchema,
  actions: {
    run: {
      label: 'Run validation',
      semantics: {
        type: 'agent-message',
        template:
          'Run the saved validation plan using validation_run. Check the current snapshot first. Honour existing permissions.',
      },
      targets: 'none',
    },
    retry: {
      label: 'Rerun failures',
      semantics: {
        type: 'agent-message',
        template:
          'Rerun only failed or blocked checks from this validation plan. Use validation_run with the matching criterionIds; preserve successful evidence if its snapshot and criteria are still current.',
      },
      targets: 'none',
    },
    revise: {
      label: 'Adjust checks',
      semantics: {
        type: 'agent-message',
        template:
          'Help me refine this validation plan in conversation. Ask what I want to change, then use validation_context and validation_publish with surfaceId and baseRevision to revise it. Do not run checks yet.',
      },
      targets: 'none',
    },
    refresh: {
      label: 'Refresh evidence',
      semantics: { type: 'mezair-command', command: 'validation.refresh' },
      targets: 'none',
    },
    save_workflow: {
      label: 'Save as workflow',
      semantics: { type: 'mutation', command: 'validation.save-workflow', approval: true },
      targets: 'none',
    },
    cancel: {
      label: 'Stop validation',
      semantics: { type: 'mezair-command', command: 'validation.cancel' },
      targets: 'none',
    },
  },
  anchors: ['surface', 'row'],
  digest: (data) =>
    [
      validationSummary(data),
      `${data.repoName} · ${data.criteria.length} criteria · ${data.source.kind}`,
      ...data.criteria.map(
        (criterion) =>
          `- [${data.freshness === 'current' ? (criterion.result?.status ?? 'unchecked') : 'stale'}] ${criterion.text}`,
      ),
    ].join('\n'),
  feature: 'codereview',
  wide: true,
  shareable: false,
};
