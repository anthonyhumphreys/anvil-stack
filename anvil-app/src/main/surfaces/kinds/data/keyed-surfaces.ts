// Tracks the latest surface per logical key within a thread so domain tools
// (deps_audit after deps_list, a rerun of security_findings…) patch the live
// surface instead of stacking copies. In-memory: after a restart the next
// publish simply supersedes the earlier instance by key.
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents.js';
import type { AgentToolSessionContext } from '../../../agent-tools/dispatch.js';
import { getSurface } from '../../core.js';

const latestByKey = new Map<string, string>();

function slot(ctx: AgentToolSessionContext, key: string): string {
  return `${ctx.appThreadId ?? ctx.sessionId}|${key}`;
}

export function rememberKeyedSurface(
  ctx: AgentToolSessionContext,
  key: string,
  surfaceId: string,
): void {
  latestByKey.set(slot(ctx, key), surfaceId);
}

/** Live (not superseded) surface for `key` in this thread, if still fresh enough. */
export function findKeyedSurface(
  ctx: AgentToolSessionContext,
  key: string,
  maxAgeMs = 30 * 60_000,
  now = Date.now(),
): AgentUISurfaceIntent | null {
  const surfaceId = latestByKey.get(slot(ctx, key));
  if (!surfaceId) return null;
  let intent: AgentUISurfaceIntent | null;
  try {
    intent = getSurface(surfaceId);
  } catch {
    intent = null;
  }
  if (!intent || intent.payload.supersededBy || intent.payload.key !== key) {
    latestByKey.delete(slot(ctx, key));
    return null;
  }
  if (ctx.appThreadId && intent.scope.threadId !== ctx.appThreadId) return null;
  const updated = Date.parse(intent.updatedAt);
  if (Number.isFinite(updated) && now - updated > maxAgeMs) return null;
  return intent;
}

export function resetKeyedSurfacesForTests(): void {
  latestByKey.clear();
}

/** A surface owned by this session's thread and of the expected kind, else null. */
export function getOwnedSurface(
  ctx: AgentToolSessionContext,
  surfaceId: string,
  surfaceKind: string,
): AgentUISurfaceIntent | null {
  const intent = getSurface(surfaceId);
  if (!intent || intent.payload.surfaceKind !== surfaceKind) return null;
  if (ctx.appThreadId && intent.scope.threadId !== ctx.appThreadId) return null;
  return intent;
}
