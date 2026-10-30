// Findings surface handler (§8.3): security audit findings, agent-authored
// findings, and their actions (dismiss / ask fix / create work items).
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';
import type {
  SurfaceActionRequest,
  SurfaceActionResult,
  JsonSchema,
} from '../../../shared/surfaces/types.js';
import {
  FINDINGS_MAX_ITEMS,
  FINDING_STATUSES,
  findingLocation,
  findingSchema,
  findingsSurfaceKind,
  type FindingStatus,
  type FindingsSurfaceData,
  type SurfaceFinding,
} from '../../../shared/surfaces/kinds/findings.js';
import {
  AgentToolError,
  assertRepoInScope,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { deliverSurfaceFeedback, patchSurface, publishSurface } from '../core.js';
import {
  dismissFinding,
  getAudit,
  getFindings,
  getRunningAudit,
  linkFindingToWorkItem,
  listAudits,
} from '../../services/security-persistence.service.js';
import {
  createPendingSecurityAudit,
  runSecurityAudit,
} from '../../services/security-audit.service.js';
import {
  actionError,
  actionOk,
  errorMessage,
  errorResult,
  getRepoRecord,
  parseToolArgs,
  renderTemplate,
  requireTargets,
  surfaceToolResult,
} from './data/tool-kit.js';
import { getOwnedSurface, rememberKeyedSurface } from './data/keyed-surfaces.js';
import {
  NoWorkItemProviderError,
  createWorkItemsForDrafts,
  describeWorkItemBatch,
} from './data/work-items.js';
import { buildSecurityFindingsData } from './findings/map.js';
import { loadSecurityAuditInputs } from './findings/audit-inputs.js';
import { findingsSnapshot, redactFindings } from './findings/snapshot.js';

const KIND = 'findings';
const PROGRESS_PATCH_INTERVAL_MS = 1000;

export function securityFindingsKey(repoId: string): string {
  return `findings:security:${repoId}`;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const findingInputSchema: JsonSchema = {
  ...findingSchema,
  required: ['severity', 'title', 'detail'],
  description: 'A finding. Anchor code findings with filePath and lineStart/lineEnd.',
};

const securityFindingsInput: JsonSchema = {
  type: 'object',
  required: ['repoId'],
  properties: {
    repoId: { type: 'string', description: 'Repository id from this session.' },
    auditId: { type: 'string', description: 'Specific audit; defaults to the latest.' },
  },
  additionalProperties: false,
};

const securityAuditRunInput: JsonSchema = {
  type: 'object',
  required: ['repoId'],
  properties: { repoId: { type: 'string', description: 'Repository id from this session.' } },
  additionalProperties: false,
};

const findingsPublishInput: JsonSchema = {
  type: 'object',
  required: ['title', 'findings'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 },
    source: { type: 'string', enum: ['custom', 'ba', 'dependency-audit'], default: 'custom' },
    repoId: { type: 'string' },
    summary: { type: 'string', maxLength: 4000 },
    findings: { type: 'array', maxItems: FINDINGS_MAX_ITEMS, items: findingInputSchema },
    streaming: {
      type: 'boolean',
      description: 'True when more findings will follow via findings_patch.',
    },
  },
  additionalProperties: false,
};

const findingsPatchInput: JsonSchema = {
  type: 'object',
  required: ['surfaceId', 'baseRevision'],
  properties: {
    surfaceId: { type: 'string' },
    baseRevision: { type: 'integer', minimum: 1 },
    add: { type: 'array', maxItems: FINDINGS_MAX_ITEMS, items: findingInputSchema },
    statuses: {
      type: 'array',
      maxItems: FINDINGS_MAX_ITEMS,
      items: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: FINDING_STATUSES },
        },
        additionalProperties: false,
      },
    },
    summary: { type: 'string', maxLength: 4000 },
    complete: { type: 'boolean', description: 'End streaming.' },
  },
  additionalProperties: false,
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'security_findings',
    title: 'Show security findings',
    description:
      'Load the latest (or a specific) persisted security audit for a repo and show it as a Findings surface. Returns a digest and surfaceId.',
    inputSchema: securityFindingsInput,
    feature: 'security',
  },
  {
    name: 'security_audit_run',
    title: 'Run security audit',
    description:
      'Start a security audit of an indexed repo. Publishes a streaming Findings surface that updates as the audit progresses; call security_findings later to read results.',
    inputSchema: securityAuditRunInput,
    feature: 'security',
  },
  {
    name: 'findings_publish',
    title: 'Publish findings',
    description:
      'Show agent-authored findings (severity critical|high|medium|low|info) as a native Findings surface with dismiss / ask-fix / work-item actions. Prefer this over a prose list.',
    inputSchema: findingsPublishInput,
  },
  {
    name: 'findings_patch',
    title: 'Update findings',
    description:
      'Add findings to, or set finding statuses on, a Findings surface you published. baseRevision must match the current revision.',
    inputSchema: findingsPatchInput,
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

type FindingInput = Omit<SurfaceFinding, 'id' | 'status'> & {
  id?: string;
  status?: FindingStatus;
};

export function normalizeFindingInputs(
  inputs: readonly FindingInput[],
  existing: readonly SurfaceFinding[] = [],
): SurfaceFinding[] {
  const used = new Set(existing.map((finding) => finding.id));
  let counter = existing.length;
  return inputs.map((input) => {
    let id = input.id?.trim();
    if (!id || used.has(id)) {
      do {
        counter += 1;
        id = `f${counter}`;
      } while (used.has(id));
    }
    used.add(id);
    const lineStart = input.lineStart;
    const lineEnd =
      input.lineEnd && lineStart && input.lineEnd < lineStart ? undefined : input.lineEnd;
    return {
      ...input,
      id,
      status: input.status ?? 'open',
      ...(lineEnd ? { lineEnd } : {}),
    } as SurfaceFinding;
  });
}

function publishSecurityAudit(
  ctx: AgentToolSessionContext,
  data: FindingsSurfaceData,
  streaming: boolean,
) {
  const key = securityFindingsKey(data.repoId!);
  const intent = publishSurface<FindingsSurfaceData>(ctx, {
    surfaceKind: KIND,
    title: data.title,
    key,
    data,
    streaming,
  });
  rememberKeyedSurface(ctx, key, intent.id);
  return intent;
}

function securityFindingsTool(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): AgentToolCallResult {
  const input = parseToolArgs<{ repoId: string; auditId?: string }>(securityFindingsInput, args);
  const repoId = assertRepoInScope(ctx, input.repoId);
  const repo = getRepoRecord(repoId);
  let audit = input.auditId ? getAudit(input.auditId) : null;
  if (input.auditId) {
    if (!audit || audit.repoId !== repoId) {
      throw new AgentToolError(
        `Security audit not found for this repo: ${input.auditId}`,
        'not-found',
      );
    }
  } else {
    const audits = listAudits(repoId);
    audit = audits.find((candidate) => candidate.status === 'completed') ?? audits[0] ?? null;
  }
  if (!audit) {
    return errorResult(
      `No security audits exist for ${repo.name}. Call security_audit_run({repoId}) to start one.`,
    );
  }
  const data = buildSecurityFindingsData(audit, getFindings(audit.id), repo.name);
  const intent = publishSecurityAudit(ctx, data, audit.status === 'running');
  return surfaceToolResult(intent, { auditId: audit.id, auditStatus: audit.status });
}

function securityAuditRunTool(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): AgentToolCallResult {
  const input = parseToolArgs<{ repoId: string }>(securityAuditRunInput, args);
  const repoId = assertRepoInScope(ctx, input.repoId);
  const repo = getRepoRecord(repoId);
  const running = getRunningAudit(repoId);
  if (running) {
    return errorResult(
      `A security audit is already running for ${repo.name} (auditId ${running.id}, started ${running.startedAt}). Call security_findings({repoId, auditId}) once it completes.`,
    );
  }
  const inputs = loadSecurityAuditInputs(repoId);
  if (!inputs) {
    return errorResult(
      `${repo.name} has not been indexed yet, and the security audit needs its index summary. Ask the user to index the repository, then retry.`,
    );
  }
  const auditId = createPendingSecurityAudit(repoId, inputs.summary, inputs.languages);
  const audit = getAudit(auditId);
  const data: FindingsSurfaceData = {
    source: 'security-audit',
    repoId,
    title: `Security audit · ${repo.name}`,
    auditId,
    auditStatus: 'running',
    progress: { message: 'Starting audit…', percent: 0 },
    ...(audit?.scope.length ? { scope: audit.scope } : {}),
    findings: [],
  };
  const intent = publishSecurityAudit(ctx, data, true);
  startAuditRun(intent.id, auditId, repoId, repo.name, inputs);
  return surfaceToolResult(
    intent,
    { auditId, auditStatus: 'running' },
    'The audit runs in the background (often several minutes). The surface updates live; call security_findings({repoId, auditId}) to read the results.',
  );
}

function safePatch(
  surfaceId: string,
  update: (data: FindingsSurfaceData) => FindingsSurfaceData,
  streaming?: boolean,
) {
  try {
    patchSurface<FindingsSurfaceData>(
      surfaceId,
      undefined,
      update,
      streaming === undefined ? undefined : { streaming },
    );
  } catch (error) {
    console.warn(`[Surfaces] Findings patch failed for ${surfaceId}:`, errorMessage(error));
  }
}

function startAuditRun(
  surfaceId: string,
  auditId: string,
  repoId: string,
  repoName: string,
  inputs: NonNullable<ReturnType<typeof loadSecurityAuditInputs>>,
): void {
  let lastPatchAt = 0;
  const sendProgress = (message: string, percent: number) => {
    const now = Date.now();
    if (now - lastPatchAt < PROGRESS_PATCH_INTERVAL_MS && percent < 100) return;
    lastPatchAt = now;
    const clamped = Math.max(0, Math.min(100, percent));
    safePatch(surfaceId, (data) => ({
      ...data,
      progress: { message: message.slice(0, 500), percent: clamped },
    }));
  };
  void runSecurityAudit(auditId, repoId, inputs.summary, inputs.languages, sendProgress)
    .then(() => {
      const audit = getAudit(auditId);
      if (!audit) return;
      const next = buildSecurityFindingsData(audit, getFindings(auditId), repoName);
      safePatch(surfaceId, () => next, false);
    })
    .catch((error: unknown) => {
      safePatch(
        surfaceId,
        (data) => ({
          ...data,
          auditStatus: 'failed',
          summary: `Audit failed: ${errorMessage(error)}`.slice(0, 4000),
          progress: undefined,
        }),
        false,
      );
    });
}

function findingsPublishTool(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): AgentToolCallResult {
  const input = parseToolArgs<{
    title: string;
    source?: 'custom' | 'ba' | 'dependency-audit';
    repoId?: string;
    summary?: string;
    findings: FindingInput[];
    streaming?: boolean;
  }>(findingsPublishInput, args);
  const repoId = input.repoId === undefined ? undefined : assertRepoInScope(ctx, input.repoId);
  const data: FindingsSurfaceData = {
    source: input.source ?? 'custom',
    ...(repoId ? { repoId } : {}),
    title: input.title,
    ...(input.summary ? { summary: input.summary } : {}),
    findings: normalizeFindingInputs(input.findings),
  };
  const intent = publishSurface<FindingsSurfaceData>(ctx, {
    surfaceKind: KIND,
    title: input.title,
    data,
    streaming: input.streaming === true,
  });
  return surfaceToolResult(intent);
}

function findingsPatchTool(
  ctx: AgentToolSessionContext,
  args: Record<string, unknown>,
): AgentToolCallResult {
  const input = parseToolArgs<{
    surfaceId: string;
    baseRevision: number;
    add?: FindingInput[];
    statuses?: Array<{ id: string; status: FindingStatus }>;
    summary?: string;
    complete?: boolean;
  }>(findingsPatchInput, args);
  const owned = getOwnedSurface(ctx, input.surfaceId, KIND);
  if (!owned)
    throw new AgentToolError(`Findings surface not found: ${input.surfaceId}`, 'not-found');
  const current = owned.payload.data as FindingsSurfaceData;
  if (current.source === 'security-audit') {
    throw new AgentToolError(
      'Security audit surfaces are backed by the audit record; use security_findings to refresh them.',
      'forbidden',
    );
  }
  const statusById = new Map((input.statuses ?? []).map((entry) => [entry.id, entry.status]));
  const intent = patchSurface<FindingsSurfaceData>(
    input.surfaceId,
    input.baseRevision,
    (data) => {
      const updated = data.findings.map((finding) =>
        statusById.has(finding.id) ? { ...finding, status: statusById.get(finding.id)! } : finding,
      );
      return {
        ...data,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        findings: [...updated, ...normalizeFindingInputs(input.add ?? [], updated)],
      };
    },
    input.complete ? { streaming: false } : undefined,
  );
  return surfaceToolResult(intent);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function describeFindingsForAgent(findings: readonly SurfaceFinding[]): string {
  return findings
    .map((finding) => {
      const location = findingLocation(finding);
      const lines = [
        `- [${finding.severity}] ${finding.id}: ${finding.title}${location ? ` @ ${location}` : ''}`,
      ];
      if (finding.detail) lines.push(`  ${finding.detail.replace(/\s+/g, ' ').slice(0, 600)}`);
      if (finding.recommendation) {
        lines.push(
          `  Recommendation: ${finding.recommendation.replace(/\s+/g, ' ').slice(0, 400)}`,
        );
      }
      return lines.join('\n');
    })
    .join('\n');
}

function patchStatuses(
  surfaceId: string,
  ids: ReadonlySet<string>,
  update: (finding: SurfaceFinding) => SurfaceFinding,
): void {
  patchSurface<FindingsSurfaceData>(surfaceId, undefined, (data) => ({
    ...data,
    findings: data.findings.map((finding) => (ids.has(finding.id) ? update(finding) : finding)),
  }));
}

async function executeFindingsAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  const data = ctx.intent.payload.data as FindingsSurfaceData;
  const requested = new Set(requireTargets(request.targetIds));
  const targets = data.findings.filter((finding) => requested.has(finding.id));
  if (!(request.action in findingsSurfaceKind.actions)) {
    return actionError(`Unknown findings action: ${request.action}`);
  }
  if (targets.length === 0) return actionError('Select at least one finding.');
  const ids = new Set(targets.map((finding) => finding.id));

  if (request.action === 'dismiss') {
    if (data.source === 'security-audit') {
      for (const finding of targets) dismissFinding(finding.id);
    }
    patchStatuses(ctx.intent.id, ids, (finding) => ({ ...finding, status: 'dismissed' }));
    return actionOk(`Dismissed ${targets.length} finding${targets.length === 1 ? '' : 's'}.`);
  }

  if (request.action === 'ask_fix') {
    const semantics = findingsSurfaceKind.actions.ask_fix.semantics;
    const template = semantics.type === 'agent-message' ? semantics.template : '{targets}';
    const message = [
      renderTemplate(template, {
        title: ctx.intent.payload.title,
        targets: describeFindingsForAgent(targets),
      }),
      `(Findings surface ${ctx.intent.id}${data.repoId ? `, repo ${data.repoId}` : ''}.)`,
      request.note ? `User note: ${request.note}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const delivered = await deliverSurfaceFeedback(ctx.intent.id, message);
    if (!delivered) {
      return actionError('No live agent session for this thread. Reopen the thread and try again.');
    }
    patchStatuses(ctx.intent.id, ids, (finding) =>
      finding.status === 'open' ? { ...finding, status: 'fix-requested' } : finding,
    );
    return actionOk(
      `Asked the agent to fix ${targets.length} finding${targets.length === 1 ? '' : 's'}.`,
    );
  }

  // create_work_items
  const pending = targets.filter((finding) => !finding.workItemId);
  if (pending.length === 0) return actionError('The selected findings already have work items.');
  try {
    const batch = await createWorkItemsForDrafts(
      pending.map((finding) => {
        const location = findingLocation(finding);
        return {
          targetId: finding.id,
          title: `[${finding.severity.toUpperCase()}] ${finding.title}`,
          description: [
            finding.detail,
            location ? `Location: ${location}` : '',
            finding.category ? `Category: ${finding.category}` : '',
            finding.recommendation ? `Recommendation: ${finding.recommendation}` : '',
            finding.refs?.length ? `References: ${finding.refs.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        };
      }),
    );
    const createdById = new Map(batch.created.map((entry) => [entry.targetId, entry.workItemId]));
    if (data.source === 'security-audit') {
      for (const [findingId, workItemId] of createdById)
        linkFindingToWorkItem(findingId, workItemId);
    }
    if (createdById.size > 0) {
      patchStatuses(ctx.intent.id, new Set(createdById.keys()), (finding) => ({
        ...finding,
        workItemId: createdById.get(finding.id),
      }));
    }
    const message = describeWorkItemBatch(batch);
    return batch.created.length > 0 ? actionOk(message) : actionError(message);
  } catch (error) {
    if (error instanceof NoWorkItemProviderError) return actionError(error.message);
    return actionError(`Could not create work items: ${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function repoRootFor(repoId: string | undefined): string | undefined {
  if (!repoId) return undefined;
  try {
    return getRepoRecord(repoId).path;
  } catch {
    return undefined;
  }
}

export const findingsSurfaceHandler: MainSurfaceHandler = {
  kind: KIND,
  toolProvider: {
    id: 'surface:findings',
    tools: () => TOOLS,
    async call(ctx, name, args) {
      switch (name) {
        case 'security_findings':
          return securityFindingsTool(ctx, args);
        case 'security_audit_run':
          return securityAuditRunTool(ctx, args);
        case 'findings_publish':
          return findingsPublishTool(ctx, args);
        case 'findings_patch':
          return findingsPatchTool(ctx, args);
        default:
          return undefined;
      }
    },
  },
  executeAction: executeFindingsAction,
  share: {
    redact: (data) => {
      const findings = data as FindingsSurfaceData;
      return redactFindings(findings, repoRootFor(findings.repoId));
    },
    snapshot: (data, title) => findingsSnapshot(data as FindingsSurfaceData, title),
  },
};

/** Exposed for tests. */
export const FINDINGS_TOOL_NAMES = TOOLS.map((tool) => tool.name);
