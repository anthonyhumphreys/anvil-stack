import { randomUUID } from 'node:crypto';
import type {
  AgentUIIntent,
  AgentUIIntentBinding,
  AgentUIIntentPresentationPatch,
  AgentUIIntentRecord,
  AgentUIIntentValidationResult,
  AgentUIPlanIntent,
  AgentUIPlanPatch,
  AgentUIPlanPatchOperation,
  AgentUIQuestionIntent,
  AgentUIQuestionResolution,
  AgentUIAnswerValue,
} from '../../shared/agent-ui-intents.js';
import { AGENT_UI_PROTOCOL_VERSION } from '../../shared/agent-ui-intents.js';
import type { ChatPlanSnapshot } from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface AgentUIIntentRow {
  id: string;
  intent_json: string;
  binding_json: string | null;
}

export class AgentUIIntentConflictError extends Error {
  constructor(
    message: string,
    readonly currentRevision: number,
  ) {
    super(message);
    this.name = 'AgentUIIntentConflictError';
  }
}

export function validateAgentUIIntent(value: unknown): AgentUIIntentValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['Intent must be an object.'] };

  if (value.protocolVersion !== AGENT_UI_PROTOCOL_VERSION) {
    errors.push(`Unsupported protocolVersion: ${String(value.protocolVersion)}.`);
  }
  if (!isNonEmptyString(value.id)) errors.push('Intent id is required.');
  if (value.kind !== 'plan' && value.kind !== 'question') {
    errors.push(`Unsupported intent kind: ${String(value.kind)}.`);
  }
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) {
    errors.push('Intent revision must be a positive integer.');
  }
  if (!isRecord(value.scope) || !isNonEmptyString(value.scope.threadId)) {
    errors.push('Intent scope.threadId is required.');
  }
  if (
    value.lifecycle !== 'pending' &&
    value.lifecycle !== 'presented' &&
    value.lifecycle !== 'resolved' &&
    value.lifecycle !== 'dismissed' &&
    value.lifecycle !== 'expired'
  ) {
    errors.push(`Invalid intent lifecycle: ${String(value.lifecycle)}.`);
  }
  if (
    !isRecord(value.presentation) ||
    typeof value.presentation.collapsed !== 'boolean' ||
    typeof value.presentation.hidden !== 'boolean'
  ) {
    errors.push('Intent presentation must contain collapsed and hidden booleans.');
  }
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    errors.push('Intent timestamps must be ISO date strings.');
  }

  if (value.kind === 'plan') validatePlanPayload(value.payload, errors);
  if (value.kind === 'question') validateQuestionPayload(value.payload, errors);
  return { ok: errors.length === 0, errors };
}

export function upsertAgentUIIntent(record: AgentUIIntentRecord): AgentUIIntent {
  assertValidIntent(record.intent);
  const db = getDb();
  const existing = getAgentUIIntentRecord(record.intent.id);
  if (existing && record.intent.revision < existing.intent.revision) {
    throw new AgentUIIntentConflictError(
      `Intent ${record.intent.id} is newer than the supplied update.`,
      existing.intent.revision,
    );
  }

  const intent = mergeIntentUpdate(existing?.intent, record.intent);
  const binding = record.binding ?? existing?.binding;
  db.prepare(
    `INSERT INTO agent_ui_intents (
       id, thread_id, workspace_id, run_id, kind, protocol_version, revision,
       lifecycle, intent_json, binding_json, created_at, updated_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id,
       workspace_id = excluded.workspace_id,
       run_id = excluded.run_id,
       kind = excluded.kind,
       protocol_version = excluded.protocol_version,
       revision = excluded.revision,
       lifecycle = excluded.lifecycle,
       intent_json = excluded.intent_json,
       binding_json = excluded.binding_json,
       updated_at = excluded.updated_at,
       resolved_at = excluded.resolved_at`,
  ).run(
    intent.id,
    intent.scope.threadId,
    intent.scope.workspaceId ?? null,
    intent.scope.runId ?? null,
    intent.kind,
    intent.protocolVersion,
    intent.revision,
    intent.lifecycle,
    JSON.stringify(intent),
    binding ? JSON.stringify(binding) : null,
    intent.createdAt,
    intent.updatedAt,
    intent.resolvedAt ?? null,
  );
  recordIntentEvent(intent.id, 'agent', existing ? 'updated' : 'created', intent);
  if (intent.kind === 'plan') syncCompatibleThreadPlan(intent);
  return intent;
}

export function getAgentUIIntent(id: string): AgentUIIntent | null {
  return getAgentUIIntentRecord(id)?.intent ?? null;
}

export function getAgentUIIntentRecord(id: string): AgentUIIntentRecord | null {
  const row = getDb()
    .prepare('SELECT id, intent_json, binding_json FROM agent_ui_intents WHERE id = ?')
    .get(id) as AgentUIIntentRow | undefined;
  if (!row) return null;
  const intent = parseIntent(row.intent_json);
  if (!intent) return null;
  return {
    intent,
    binding: parseBinding(row.binding_json),
  };
}

export function listAgentUIIntents(
  threadId: string,
  options: { includeInactive?: boolean } = {},
): AgentUIIntent[] {
  ensureLegacyPlanIntent(threadId);
  const rows = getDb()
    .prepare(
      `SELECT id, intent_json, binding_json
       FROM agent_ui_intents
       WHERE thread_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(threadId) as AgentUIIntentRow[];
  return rows.flatMap((row) => {
    const intent = parseIntent(row.intent_json);
    if (!intent) return [];
    if (
      !options.includeInactive &&
      (intent.lifecycle === 'resolved' ||
        intent.lifecycle === 'dismissed' ||
        intent.lifecycle === 'expired')
    ) {
      return [];
    }
    return [intent];
  });
}

export function updateAgentUIIntentPresentation(
  id: string,
  patch: AgentUIIntentPresentationPatch,
): AgentUIIntent {
  const record = requireIntentRecord(id);
  const now = new Date().toISOString();
  const intent: AgentUIIntent = {
    ...record.intent,
    revision: record.intent.revision + 1,
    presentation: {
      collapsed: patch.collapsed ?? record.intent.presentation.collapsed,
      hidden: patch.hidden ?? record.intent.presentation.hidden,
    },
    updatedAt: now,
  };
  persistIntent(intent, record.binding);
  recordIntentEvent(id, 'user', 'presentation_changed', patch);
  return intent;
}

export function dismissAgentUIIntent(id: string): AgentUIIntent {
  const record = requireIntentRecord(id);
  const now = new Date().toISOString();
  const intent: AgentUIIntent = {
    ...record.intent,
    revision: record.intent.revision + 1,
    lifecycle: 'dismissed',
    presentation: { ...record.intent.presentation, hidden: true },
    updatedAt: now,
    resolvedAt: now,
    ...(record.intent.kind === 'plan'
      ? {
          payload: {
            ...record.intent.payload,
            lifecycle: 'archived' as const,
          },
        }
      : {}),
  } as AgentUIIntent;
  persistIntent(intent, record.binding);
  recordIntentEvent(id, 'user', 'dismissed', { id });
  clearCompatibleThreadPlan(intent);
  return intent;
}

export function restoreAgentUIIntent(id: string): AgentUIIntent {
  const record = requireIntentRecord(id);
  if (record.intent.kind !== 'plan') throw new Error(`Intent ${id} is not a plan.`);
  const now = new Date().toISOString();
  const planLifecycle = record.intent.payload.steps.every((step) => step.status === 'done')
    ? ('completed' as const)
    : ('active' as const);
  const intent: AgentUIPlanIntent = {
    ...record.intent,
    revision: record.intent.revision + 1,
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    updatedAt: now,
    resolvedAt: undefined,
    payload: { ...record.intent.payload, lifecycle: planLifecycle },
  };
  persistIntent(intent, record.binding);
  recordIntentEvent(id, 'user', 'restored', { id });
  syncCompatibleThreadPlan(intent);
  return intent;
}

export function patchAgentUIPlan(id: string, patch: AgentUIPlanPatch): AgentUIPlanIntent {
  validateAgentUIPlanPatch(patch);
  const record = requireIntentRecord(id);
  if (record.intent.kind !== 'plan') throw new Error(`Intent ${id} is not a plan.`);
  if (patch.planId !== record.intent.payload.planId)
    throw new Error('Plan patch targets another plan.');
  if (patch.baseRevision !== record.intent.revision) {
    throw new AgentUIIntentConflictError(
      `Plan revision ${patch.baseRevision} is stale; current revision is ${record.intent.revision}.`,
      record.intent.revision,
    );
  }
  if (!patch.operationId.trim() || patch.operations.length === 0) {
    throw new Error('Plan patch requires an operationId and at least one operation.');
  }

  const previousLifecycle = record.intent.payload.lifecycle;
  const payload = structuredClone(record.intent.payload);
  for (const operation of patch.operations) applyPlanOperation(payload, operation);
  if (payload.lifecycle !== 'archived') {
    payload.lifecycle =
      payload.steps.length > 0 && payload.steps.every((step) => step.status === 'done')
        ? 'completed'
        : 'active';
  }
  const now = new Date().toISOString();
  const intent: AgentUIPlanIntent = {
    ...record.intent,
    revision: record.intent.revision + 1,
    lifecycle: payload.lifecycle === 'archived' ? 'dismissed' : 'presented',
    presentation: {
      collapsed:
        previousLifecycle !== 'completed' && payload.lifecycle === 'completed'
          ? true
          : record.intent.presentation.collapsed,
      hidden: payload.lifecycle === 'archived' ? true : record.intent.presentation.hidden,
    },
    payload,
    updatedAt: now,
    resolvedAt: payload.lifecycle === 'archived' ? now : undefined,
  };
  assertValidIntent(intent);
  persistIntent(intent, record.binding);
  recordIntentEvent(id, patch.actor, 'plan_patch', patch);
  syncCompatibleThreadPlan(intent);
  return intent;
}

export function validateAgentUIQuestionResolution(
  intent: AgentUIQuestionIntent,
  resolution: AgentUIQuestionResolution,
): void {
  if (!isRecord(resolution)) throw new Error('Question response must be an object.');
  if (
    resolution.action !== 'submit' &&
    resolution.action !== 'skip' &&
    resolution.action !== 'cancel'
  ) {
    throw new Error('Question response has an unsupported action.');
  }
  if (!isRecord(resolution.answers) || !isIsoDate(resolution.answeredAt)) {
    throw new Error('Question response requires answers and an answeredAt timestamp.');
  }
  if (resolution.intentId !== intent.id)
    throw new Error('Question response targets another intent.');
  if (
    intent.lifecycle === 'resolved' ||
    intent.lifecycle === 'dismissed' ||
    intent.lifecycle === 'expired'
  ) {
    throw new Error('Question is no longer awaiting an answer.');
  }
  if (resolution.action !== 'submit') {
    const blocksCancellation = intent.payload.questions.some(
      (question) => question.required && !question.allowCancel,
    );
    if (blocksCancellation)
      throw new Error('This required question cannot be skipped or cancelled.');
    return;
  }

  for (const question of intent.payload.questions) {
    const answer = resolution.answers[question.id];
    if (question.required && !hasAnswer(answer)) {
      throw new Error(`Question ${question.id} requires an answer.`);
    }
    if (answer === undefined || answer === null) continue;
    validateAnswer(question.kind, question.options?.map((option) => option.value) ?? [], answer);
  }
}

function validateAgentUIPlanPatch(patch: AgentUIPlanPatch): void {
  if (!isRecord(patch)) throw new Error('Plan patch must be an object.');
  if (
    !isNonEmptyString(patch.planId) ||
    !Number.isInteger(patch.baseRevision) ||
    patch.baseRevision < 0 ||
    !isNonEmptyString(patch.operationId) ||
    (patch.actor !== 'agent' && patch.actor !== 'user') ||
    !Array.isArray(patch.operations) ||
    patch.operations.length === 0
  ) {
    throw new Error('Plan patch metadata is invalid.');
  }
  const operationTypes = new Set([
    'set_plan_metadata',
    'add_phase',
    'update_phase',
    'remove_phase',
    'add_step',
    'update_step',
    'move_step',
    'remove_step',
    'set_step_status',
    'archive_plan',
  ]);
  for (const operation of patch.operations as unknown[]) {
    if (
      !isRecord(operation) ||
      !isNonEmptyString(operation.type) ||
      !operationTypes.has(operation.type)
    ) {
      throw new Error('Plan patch contains an unsupported operation.');
    }
    if (
      operation.type === 'set_step_status' &&
      operation.status !== 'todo' &&
      operation.status !== 'in_progress' &&
      operation.status !== 'blocked' &&
      operation.status !== 'done'
    ) {
      throw new Error('Plan patch contains an invalid step status.');
    }
    if (
      (operation.type === 'update_step' || operation.type === 'update_phase') &&
      (!isRecord(operation.changes) || 'id' in operation.changes)
    ) {
      throw new Error('Plan patch changes cannot replace stable IDs.');
    }
  }
}

export function recordAgentUIQuestionResolution(
  intent: AgentUIQuestionIntent,
  resolution: AgentUIQuestionResolution,
): AgentUIQuestionIntent {
  validateAgentUIQuestionResolution(intent, resolution);
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM agent_ui_intent_responses WHERE intent_id = ?')
    .get(intent.id) as { id: string } | undefined;
  if (existing) return requireIntentRecord(intent.id).intent as AgentUIQuestionIntent;

  const safeAnswers = Object.fromEntries(
    intent.payload.questions.map((question) => [
      question.id,
      question.sensitive ? '[redacted]' : (resolution.answers[question.id] ?? null),
    ]),
  );
  const now = new Date().toISOString();
  const resolved: AgentUIQuestionIntent = {
    ...intent,
    revision: intent.revision + 1,
    lifecycle: resolution.action === 'submit' ? 'resolved' : 'dismissed',
    presentation: { ...intent.presentation, collapsed: true },
    updatedAt: now,
    resolvedAt: now,
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_ui_intent_responses (id, intent_id, action, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      intent.id,
      resolution.action,
      JSON.stringify({ ...resolution, answers: safeAnswers }),
      now,
    );
    persistIntent(resolved, requireIntentRecord(intent.id).binding);
    recordIntentEvent(intent.id, 'user', 'resolved', {
      action: resolution.action,
      answers: safeAnswers,
    });
  });
  tx();
  return resolved;
}

export function expireAgentUIIntentsForSession(sessionId: string): AgentUIIntent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, intent_json, binding_json FROM agent_ui_intents
       WHERE lifecycle IN ('pending', 'presented') AND binding_json IS NOT NULL`,
    )
    .all() as AgentUIIntentRow[];
  return rows.flatMap((row) => {
    const record = parseRow(row);
    if (!record || record.binding?.sessionId !== sessionId || record.intent.kind !== 'question')
      return [];
    const now = new Date().toISOString();
    const expired: AgentUIIntent = {
      ...record.intent,
      revision: record.intent.revision + 1,
      lifecycle: 'expired',
      updatedAt: now,
      resolvedAt: now,
    };
    persistIntent(expired, record.binding);
    recordIntentEvent(expired.id, 'agent', 'expired', { sessionId });
    return [expired];
  });
}

export function expireAgentUIIntentForRequest(
  sessionId: string,
  requestId: string | number,
): AgentUIIntent | null {
  const rows = getDb()
    .prepare(
      `SELECT id, intent_json, binding_json FROM agent_ui_intents
       WHERE lifecycle IN ('pending', 'presented') AND binding_json IS NOT NULL`,
    )
    .all() as AgentUIIntentRow[];
  const record = rows
    .map(parseRow)
    .find(
      (candidate) =>
        candidate?.intent.kind === 'question' &&
        candidate.binding?.sessionId === sessionId &&
        candidate.binding.requestId === requestId,
    );
  if (!record || record.intent.kind !== 'question') return null;
  const now = new Date().toISOString();
  const expired: AgentUIQuestionIntent = {
    ...record.intent,
    revision: record.intent.revision + 1,
    lifecycle: 'expired',
    updatedAt: now,
    resolvedAt: now,
  };
  persistIntent(expired, record.binding);
  recordIntentEvent(expired.id, 'agent', 'expired', { sessionId, requestId });
  return expired;
}

function mergeIntentUpdate(
  current: AgentUIIntent | undefined,
  incoming: AgentUIIntent,
): AgentUIIntent {
  if (!current) return incoming;
  if (current.kind !== incoming.kind) throw new Error('Intent kind cannot change.');
  const planCompleted =
    incoming.kind === 'plan' &&
    current.kind === 'plan' &&
    current.payload.lifecycle !== 'completed' &&
    incoming.payload.lifecycle === 'completed';
  return {
    ...incoming,
    createdAt: current.createdAt,
    presentation: {
      collapsed: planCompleted ? true : current.presentation.collapsed,
      hidden: current.presentation.hidden,
    },
  } as AgentUIIntent;
}

function persistIntent(intent: AgentUIIntent, binding?: AgentUIIntentBinding): void {
  assertValidIntent(intent);
  getDb()
    .prepare(
      `UPDATE agent_ui_intents SET
         workspace_id = ?, run_id = ?, revision = ?, lifecycle = ?, intent_json = ?,
         binding_json = ?, updated_at = ?, resolved_at = ?
       WHERE id = ?`,
    )
    .run(
      intent.scope.workspaceId ?? null,
      intent.scope.runId ?? null,
      intent.revision,
      intent.lifecycle,
      JSON.stringify(intent),
      binding ? JSON.stringify(binding) : null,
      intent.updatedAt,
      intent.resolvedAt ?? null,
      intent.id,
    );
}

function recordIntentEvent(
  intentId: string,
  actor: 'agent' | 'user',
  eventType: string,
  payload: unknown,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_ui_intent_events
       (id, intent_id, actor, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      intentId,
      actor,
      eventType,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
}

function applyPlanOperation(
  payload: AgentUIPlanIntent['payload'],
  operation: AgentUIPlanPatchOperation,
): void {
  switch (operation.type) {
    case 'set_plan_metadata':
      if (operation.title !== undefined) payload.title = requireText(operation.title, 'Plan title');
      if (operation.description !== undefined)
        payload.description = operation.description.trim() || undefined;
      return;
    case 'add_phase':
      if (payload.phases.some((phase) => phase.id === operation.phase.id)) {
        throw new Error(`Phase ${operation.phase.id} already exists.`);
      }
      payload.phases.splice(clampIndex(operation.index, payload.phases.length), 0, operation.phase);
      return;
    case 'update_phase': {
      const phase = requireItem(payload.phases, operation.phaseId, 'phase');
      Object.assign(phase, operation.changes);
      phase.title = requireText(phase.title, 'Phase title');
      return;
    }
    case 'remove_phase':
      payload.phases = payload.phases.filter((phase) => phase.id !== operation.phaseId);
      payload.steps = payload.steps.map((step) =>
        step.phaseId === operation.phaseId ? { ...step, phaseId: undefined } : step,
      );
      return;
    case 'add_step':
      if (payload.steps.some((step) => step.id === operation.step.id)) {
        throw new Error(`Step ${operation.step.id} already exists.`);
      }
      payload.steps.splice(clampIndex(operation.index, payload.steps.length), 0, operation.step);
      return;
    case 'update_step': {
      const step = requireItem(payload.steps, operation.stepId, 'step');
      Object.assign(step, operation.changes);
      step.title = requireText(step.title, 'Step title');
      return;
    }
    case 'move_step': {
      const currentIndex = payload.steps.findIndex((step) => step.id === operation.stepId);
      if (currentIndex < 0) throw new Error(`Unknown step: ${operation.stepId}.`);
      const [step] = payload.steps.splice(currentIndex, 1);
      step.phaseId = operation.phaseId;
      payload.steps.splice(clampIndex(operation.index, payload.steps.length), 0, step);
      return;
    }
    case 'remove_step':
      payload.steps = payload.steps.filter((step) => step.id !== operation.stepId);
      for (const step of payload.steps) {
        step.dependsOn = step.dependsOn?.filter((dependency) => dependency !== operation.stepId);
      }
      return;
    case 'set_step_status':
      requireItem(payload.steps, operation.stepId, 'step').status = operation.status;
      return;
    case 'archive_plan':
      payload.lifecycle = 'archived';
      return;
  }
}

function ensureLegacyPlanIntent(threadId: string): void {
  const existing = getDb()
    .prepare("SELECT id FROM agent_ui_intents WHERE thread_id = ? AND kind = 'plan' LIMIT 1")
    .get(threadId);
  if (existing) return;
  const row = getDb()
    .prepare('SELECT workspace_id, active_plan_json FROM chat_threads WHERE id = ?')
    .get(threadId) as { workspace_id: string | null; active_plan_json: string | null } | undefined;
  if (!row?.active_plan_json) return;
  let plan: ChatPlanSnapshot;
  try {
    plan = JSON.parse(row.active_plan_json) as ChatPlanSnapshot;
  } catch {
    return;
  }
  if (!Array.isArray(plan.steps)) return;
  const now = plan.updatedAt || new Date().toISOString();
  const intent: AgentUIPlanIntent = {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id: `plan:${threadId}`,
    kind: 'plan',
    revision: 1,
    scope: { threadId, workspaceId: row.workspace_id ?? undefined },
    lifecycle: 'presented',
    presentation: {
      collapsed: plan.steps.length > 0 && plan.steps.every((step) => step.status === 'completed'),
      hidden: false,
    },
    payload: {
      planId: `plan:${threadId}`,
      title: 'Implementation plan',
      description: plan.explanation,
      lifecycle:
        plan.steps.length > 0 && plan.steps.every((step) => step.status === 'completed')
          ? 'completed'
          : 'active',
      phases: [],
      steps: plan.steps.map((step, index) => ({
        id: `step:${index + 1}`,
        title: step.step,
        status:
          step.status === 'completed'
            ? 'done'
            : step.status === 'in_progress'
              ? 'in_progress'
              : 'todo',
      })),
    },
    createdAt: now,
    updatedAt: now,
  };
  upsertAgentUIIntent({ intent });
}

function syncCompatibleThreadPlan(intent: AgentUIPlanIntent): void {
  if (intent.payload.lifecycle === 'archived') {
    clearCompatibleThreadPlan(intent);
    return;
  }
  const snapshot: ChatPlanSnapshot = {
    explanation: intent.payload.description,
    steps: intent.payload.steps.map((step) => ({
      step: step.title,
      status:
        step.status === 'done'
          ? 'completed'
          : step.status === 'in_progress' || step.status === 'blocked'
            ? 'in_progress'
            : 'pending',
    })),
    updatedAt: intent.updatedAt,
  };
  getDb()
    .prepare(
      `UPDATE chat_threads SET active_plan_json = ?, active_plan_updated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(snapshot), intent.updatedAt, intent.updatedAt, intent.scope.threadId);
}

function clearCompatibleThreadPlan(intent: AgentUIIntent): void {
  if (intent.kind !== 'plan') return;
  getDb()
    .prepare(
      `UPDATE chat_threads SET active_plan_json = NULL, active_plan_updated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(intent.updatedAt, intent.updatedAt, intent.scope.threadId);
}

function requireIntentRecord(id: string): AgentUIIntentRecord {
  const record = getAgentUIIntentRecord(id);
  if (!record) throw new Error(`Agent UI intent not found: ${id}.`);
  return record;
}

function parseRow(row: AgentUIIntentRow): AgentUIIntentRecord | null {
  const intent = parseIntent(row.intent_json);
  return intent ? { intent, binding: parseBinding(row.binding_json) } : null;
}

function parseIntent(value: string): AgentUIIntent | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return validateAgentUIIntent(parsed).ok ? (parsed as AgentUIIntent) : null;
  } catch {
    return null;
  }
}

function parseBinding(value: string | null): AgentUIIntentBinding | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isNonEmptyString(parsed.provider)) return undefined;
    return parsed as unknown as AgentUIIntentBinding;
  } catch {
    return undefined;
  }
}

function assertValidIntent(intent: AgentUIIntent): void {
  const result = validateAgentUIIntent(intent);
  if (!result.ok) throw new Error(`Invalid Agent UI intent: ${result.errors.join(' ')}`);
}

function validatePlanPayload(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('Plan payload must be an object.');
    return;
  }
  if (!isNonEmptyString(value.planId) || !isNonEmptyString(value.title)) {
    errors.push('Plan planId and title are required.');
  }
  if (
    value.lifecycle !== 'active' &&
    value.lifecycle !== 'completed' &&
    value.lifecycle !== 'archived'
  ) {
    errors.push(`Invalid plan lifecycle: ${String(value.lifecycle)}.`);
  }
  if (!Array.isArray(value.phases) || !Array.isArray(value.steps)) {
    errors.push('Plan phases and steps must be arrays.');
    return;
  }
  const phaseIds = new Set<string>();
  for (const phase of value.phases) {
    if (!isRecord(phase) || !isNonEmptyString(phase.id) || !isNonEmptyString(phase.title)) {
      errors.push('Every plan phase requires an id and title.');
      continue;
    }
    if (phaseIds.has(phase.id)) errors.push(`Duplicate plan phase id: ${phase.id}.`);
    phaseIds.add(phase.id);
  }
  const stepIds = new Set<string>();
  for (const step of value.steps) {
    if (!isRecord(step) || !isNonEmptyString(step.id) || !isNonEmptyString(step.title)) {
      errors.push('Every plan step requires an id and title.');
      continue;
    }
    if (stepIds.has(step.id)) errors.push(`Duplicate plan step id: ${step.id}.`);
    stepIds.add(step.id);
    if (
      step.status !== 'todo' &&
      step.status !== 'in_progress' &&
      step.status !== 'blocked' &&
      step.status !== 'done'
    ) {
      errors.push(`Invalid status for step ${step.id}.`);
    }
    if (step.phaseId !== undefined && !phaseIds.has(String(step.phaseId))) {
      errors.push(`Step ${step.id} references unknown phase ${String(step.phaseId)}.`);
    }
  }
  for (const step of value.steps) {
    if (!isRecord(step) || !Array.isArray(step.dependsOn)) continue;
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(String(dependency))) {
        errors.push(`Step ${String(step.id)} references unknown dependency ${String(dependency)}.`);
      }
    }
  }
}

function validateQuestionPayload(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !Array.isArray(value.questions) || value.questions.length === 0) {
    errors.push('Question payload must contain at least one question.');
    return;
  }
  const ids = new Set<string>();
  for (const question of value.questions) {
    if (
      !isRecord(question) ||
      !isNonEmptyString(question.id) ||
      !isNonEmptyString(question.question)
    ) {
      errors.push('Every question requires an id and question text.');
      continue;
    }
    if (ids.has(question.id)) errors.push(`Duplicate question id: ${question.id}.`);
    ids.add(question.id);
    if (
      question.kind !== 'single_choice' &&
      question.kind !== 'multiple_choice' &&
      question.kind !== 'yes_no' &&
      question.kind !== 'free_text' &&
      question.kind !== 'approval'
    ) {
      errors.push(`Invalid question kind for ${question.id}.`);
    }
    if (typeof question.required !== 'boolean' || typeof question.allowCancel !== 'boolean') {
      errors.push(`Question ${question.id} must define required and allowCancel.`);
    }
    if (question.kind === 'single_choice' || question.kind === 'multiple_choice') {
      if (!Array.isArray(question.options) || question.options.length < 2) {
        errors.push(`Question ${question.id} requires at least two options.`);
      }
    }
    if (Array.isArray(question.options)) {
      const optionIds = new Set<string>();
      const values = new Set<string>();
      for (const option of question.options) {
        if (
          !isRecord(option) ||
          !isNonEmptyString(option.id) ||
          !isNonEmptyString(option.label) ||
          !isNonEmptyString(option.value)
        ) {
          errors.push(`Question ${question.id} has an invalid option.`);
          continue;
        }
        if (optionIds.has(option.id)) {
          errors.push(`Question ${question.id} has duplicate option id ${option.id}.`);
        }
        optionIds.add(option.id);
        if (values.has(option.value))
          errors.push(`Question ${question.id} has duplicate option value ${option.value}.`);
        values.add(option.value);
      }
      if (question.defaultValue !== undefined) {
        try {
          validateAnswer(
            String(question.kind),
            [...values],
            question.defaultValue as AgentUIAnswerValue,
          );
        } catch {
          errors.push(`Question ${question.id} has an invalid default value.`);
        }
      }
    } else if (question.defaultValue !== undefined) {
      try {
        validateAnswer(String(question.kind), [], question.defaultValue as AgentUIAnswerValue);
      } catch {
        errors.push(`Question ${question.id} has an invalid default value.`);
      }
    }
  }
}

function validateAnswer(kind: string, options: string[], answer: AgentUIAnswerValue): void {
  if (kind === 'multiple_choice') {
    if (!Array.isArray(answer) || answer.some((value) => !options.includes(value))) {
      throw new Error('Multiple-choice answer contains an unsupported value.');
    }
    return;
  }
  if (kind === 'yes_no' || kind === 'approval') {
    if (typeof answer !== 'boolean') throw new Error('This question requires a yes/no answer.');
    return;
  }
  if (typeof answer !== 'string') throw new Error('This question requires a text answer.');
  if (kind === 'single_choice' && !options.includes(answer)) {
    throw new Error('Single-choice answer is not one of the available options.');
  }
}

function hasAnswer(value: AgentUIAnswerValue | undefined): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'boolean';
}

function requireItem<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown ${label}: ${id}.`);
  return item;
}

function clampIndex(index: number | undefined, length: number): number {
  return Math.max(0, Math.min(index ?? length, length));
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
