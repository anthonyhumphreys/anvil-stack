// In-memory stand-in for src/main/surfaces/core.ts used by the findings,
// dependencies, pipeline and data handler tests. Mirrors the contract:
// schema validation on publish/patch, digest from the kind, revision checks.
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents.js';
import { getSurfaceKind } from '../../../../shared/surfaces/registry.js';
import { AgentToolError, type AgentToolSessionContext } from '../../../agent-tools/dispatch.js';
import type { PublishSurfaceInput } from '../../core.js';
import { formatSchemaErrors, validateJsonSchema } from '../../validate.js';

const store = new Map<string, AgentUISurfaceIntent>();
export const fakeCoreState = {
  delivered: [] as Array<{ surfaceId: string; message: string }>,
  deliverResult: true,
  counter: 0,
};

function validate(kind: string, data: unknown): string {
  const definition = getSurfaceKind(kind);
  if (!definition) throw new Error(`Unknown kind ${kind}`);
  const errors = validateJsonSchema(definition.schema, JSON.parse(JSON.stringify(data)));
  if (errors.length > 0) {
    throw new AgentToolError(
      `Invalid ${kind} payload: ${formatSchemaErrors(errors)}`,
      'invalid-params',
    );
  }
  return definition.digest(data);
}

export function publishSurface<T>(
  ctx: AgentToolSessionContext,
  input: PublishSurfaceInput<T>,
): AgentUISurfaceIntent {
  const digest = validate(input.surfaceKind, input.data);
  fakeCoreState.counter += 1;
  const now = new Date().toISOString();
  for (const existing of store.values()) {
    if (input.key && existing.payload.key === input.key && !existing.payload.supersededBy) {
      existing.payload.supersededBy = `surface-${fakeCoreState.counter}`;
    }
  }
  const intent: AgentUISurfaceIntent = {
    protocolVersion: 1,
    id: `surface-${fakeCoreState.counter}`,
    kind: 'surface',
    revision: 1,
    scope: { threadId: ctx.appThreadId ?? 'thread', workspaceId: ctx.workspaceId },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: input.surfaceKind,
      title: input.title,
      ...(input.key ? { key: input.key } : {}),
      streaming: input.streaming ?? false,
      digest,
      data: JSON.parse(JSON.stringify(input.data)),
    },
    createdAt: now,
    updatedAt: now,
  };
  store.set(intent.id, intent);
  return intent;
}

export function patchSurface<T>(
  surfaceId: string,
  baseRevision: number | undefined,
  update: (data: T) => T,
  options?: { title?: string; streaming?: boolean },
): AgentUISurfaceIntent {
  const current = store.get(surfaceId);
  if (!current) throw new AgentToolError(`Surface not found: ${surfaceId}`, 'not-found');
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    throw new AgentToolError('Stale baseRevision', 'conflict');
  }
  const data = update(JSON.parse(JSON.stringify(current.payload.data)) as T);
  const digest = validate(current.payload.surfaceKind, data);
  const next: AgentUISurfaceIntent = {
    ...current,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    payload: {
      ...current.payload,
      ...(options?.title ? { title: options.title } : {}),
      ...(options?.streaming !== undefined ? { streaming: options.streaming } : {}),
      digest,
      data: JSON.parse(JSON.stringify(data)),
    },
  };
  store.set(surfaceId, next);
  return next;
}

export function getSurface(surfaceId: string): AgentUISurfaceIntent | null {
  return store.get(surfaceId) ?? null;
}

export async function deliverSurfaceFeedback(surfaceId: string, message: string): Promise<boolean> {
  fakeCoreState.delivered.push({ surfaceId, message });
  return fakeCoreState.deliverResult;
}

export async function requestUserApproval(): Promise<boolean> {
  return true;
}

export function resetFakeCore(): void {
  store.clear();
  fakeCoreState.delivered = [];
  fakeCoreState.deliverResult = true;
  fakeCoreState.counter = 0;
}

export function testContext(
  overrides: Partial<AgentToolSessionContext> = {},
): AgentToolSessionContext {
  return {
    sessionId: 'session-1',
    appThreadId: 'thread-1',
    workspaceId: 'ws-1',
    repoIds: ['repo-1'],
    provider: 'codex',
    mode: 'on-request',
    features: ['security', 'dependencies', 'cicd'],
    ...overrides,
  };
}

export function textOf(
  result: { content: Array<{ type: string; text?: string }> } | undefined,
): string {
  return (result?.content ?? []).map((part) => part.text ?? '').join('\n');
}
