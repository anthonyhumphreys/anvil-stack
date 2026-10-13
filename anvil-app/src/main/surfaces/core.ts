// Surface lifecycle core: publish / patch / complete / supersede / feedback.
// Kind handlers build on these; the agent never writes intents directly.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §5.2–§5.5.
//
// Owned by the surface-contract workstream. The signatures below are the
// contract other kinds code against; keep them stable.

import type { AgentUISurfaceIntent } from '../../shared/agent-ui-intents.js';
import type { AgentToolSessionContext } from '../agent-tools/dispatch.js';

export interface PublishSurfaceInput<T = unknown> {
  surfaceKind: string;
  title: string;
  key?: string;
  data: T;
  streaming?: boolean;
}

/** Validates `data` against the kind schema, persists the intent, broadcasts it into the session's turn. */
export function publishSurface<T>(
  _ctx: AgentToolSessionContext,
  _input: PublishSurfaceInput<T>,
): AgentUISurfaceIntent {
  throw new Error('publishSurface not implemented');
}

/**
 * Applies `update` to the current data when `baseRevision` matches (else
 * throws AgentToolError 'conflict'), re-validates, persists and broadcasts.
 * Pass `baseRevision: undefined` for trusted main-process updates (actions).
 */
export function patchSurface<T>(
  _surfaceId: string,
  _baseRevision: number | undefined,
  _update: (data: T) => T,
  _options?: { title?: string; streaming?: boolean },
): AgentUISurfaceIntent {
  throw new Error('patchSurface not implemented');
}

export function getSurface(_surfaceId: string): AgentUISurfaceIntent | null {
  throw new Error('getSurface not implemented');
}

/**
 * Sends structured feedback (surface action, anchored comment) to the agent
 * session that owns the surface: steer when a turn is active and supported,
 * prompt when ready, queue otherwise. Returns false when no live session.
 */
export async function deliverSurfaceFeedback(
  _surfaceId: string,
  _message: string,
): Promise<boolean> {
  throw new Error('deliverSurfaceFeedback not implemented');
}
