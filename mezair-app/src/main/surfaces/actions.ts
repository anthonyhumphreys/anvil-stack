// Surface action loop (§5.3): a user action becomes structured agent input or
// a main-process command, by the action's declared semantics.
import type { SurfaceActionRequest, SurfaceActionResult } from '../../shared/surfaces/types.js';
import { getSurfaceKind } from '../../shared/surfaces/registry.js';
import { recordIntentEvent } from '../services/agent-ui-intent.service.js';
import { deliverSurfaceFeedback, getSurfaceRecord, resolveSurfaceSessionId } from './core.js';
import { getMainSurfaceHandler } from './index.js';
import type { SurfaceActionContext } from './types.js';

const MAX_TARGETS = 200;
const MAX_NOTE_LENGTH = 10_000;

export async function runSurfaceAction(input: SurfaceActionRequest): Promise<SurfaceActionResult> {
  const request = normaliseRequest(input);
  if (!request) return { ok: false, error: 'Invalid surface action request.' };
  const record = getSurfaceRecord(request.surfaceId);
  if (!record) return { ok: false, error: 'This surface no longer exists.' };
  const { intent } = record;
  const definition = getSurfaceKind(intent.payload.surfaceKind);
  const spec = definition?.actions[request.action];
  if (!definition || !spec) return { ok: false, error: `Unknown action: ${request.action}.` };

  const targetCount = request.targetIds?.length ?? 0;
  if (spec.targets === 'none' && targetCount > 0) {
    return { ok: false, error: `${spec.label} does not take a selection.` };
  }
  if (spec.targets === 'one' && targetCount !== 1) {
    return { ok: false, error: `${spec.label} needs exactly one selected item.` };
  }
  if (spec.targets === 'many' && targetCount === 0) {
    return { ok: false, error: `${spec.label} needs at least one selected item.` };
  }

  const context: SurfaceActionContext = {
    intent,
    sessionId: resolveSurfaceSessionId(record) ?? undefined,
  };
  let result: SurfaceActionResult;
  try {
    const handler = getMainSurfaceHandler(intent.payload.surfaceKind);
    result = handler?.executeAction
      ? await handler.executeAction(context, request)
      : await runDefaultSurfaceAction(context, request);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    recordIntentEvent(intent.id, 'user', 'surface_action', {
      action: request.action,
      targetIds: request.targetIds ?? [],
      hasNote: Boolean(request.note),
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    console.error('[Surfaces] Failed to record surface action:', error);
  }
  return result;
}

/**
 * Default execution by semantics. Handlers with their own executeAction can
 * delegate here for actions they do not special-case.
 */
export async function runDefaultSurfaceAction(
  context: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  const definition = getSurfaceKind(context.intent.payload.surfaceKind);
  const spec = definition?.actions[request.action];
  if (!spec) return { ok: false, error: `Unknown action: ${request.action}.` };
  if (spec.semantics.type !== 'agent-message') {
    return { ok: false, error: `${spec.label} is not available for this surface yet.` };
  }
  const message = fillActionTemplate(spec.semantics.template, {
    title: context.intent.payload.title,
    targets: request.targetIds ?? [],
    note: request.note,
  });
  const delivered = await deliverSurfaceFeedback(
    context.intent.id,
    `User action "${spec.label}" (${request.action}): ${message}`,
  );
  return delivered
    ? { ok: true, message: 'Sent to the agent.' }
    : { ok: false, error: 'The agent session for this thread is not running.' };
}

export function fillActionTemplate(
  template: string,
  values: { title: string; targets: readonly string[]; note?: string },
): string {
  const targets = values.targets.join(', ');
  const note = values.note?.trim() ?? '';
  let message = template
    .replaceAll('{title}', values.title)
    .replaceAll('{targets}', targets || 'the whole surface')
    .replaceAll('{note}', note);
  if (targets && !template.includes('{targets}')) message += `\nTargets: ${targets}`;
  if (note && !template.includes('{note}')) message += `\nUser note: ${note}`;
  return message.trim();
}

function normaliseRequest(input: SurfaceActionRequest): SurfaceActionRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  if (typeof input.surfaceId !== 'string' || !input.surfaceId.trim()) return null;
  if (typeof input.action !== 'string' || !input.action.trim()) return null;
  if (input.targetIds !== undefined) {
    if (
      !Array.isArray(input.targetIds) ||
      input.targetIds.length > MAX_TARGETS ||
      input.targetIds.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      return null;
    }
  }
  if (input.note !== undefined && typeof input.note !== 'string') return null;
  return {
    surfaceId: input.surfaceId.trim(),
    action: input.action.trim(),
    ...(input.targetIds?.length ? { targetIds: [...new Set(input.targetIds)] } : {}),
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, MAX_NOTE_LENGTH) } : {}),
  };
}
