// Surface lifecycle core: publish / patch / complete / supersede / feedback.
// Kind handlers build on these; the agent never writes intents directly.
// Spec: docs/plans/inline-artifacts-and-canvas-tools.md §5.2–§5.5.
//
// Owned by the surface-contract workstream. The signatures below are the
// contract other kinds code against; keep them stable.

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  AGENT_UI_PROTOCOL_VERSION,
  type AgentUIIntentBinding,
  type AgentUISurfaceIntent,
} from '../../shared/agent-ui-intents.js';
import { getSurfaceKind } from '../../shared/surfaces/registry.js';
import type { JsonSchema, SurfaceKindDefinition } from '../../shared/surfaces/types.js';
import {
  AgentToolError,
  textResult,
  type AgentToolCallResult,
  type AgentToolDefinition,
  type AgentToolProvider,
  type AgentToolSessionContext,
} from '../agent-tools/dispatch.js';
import { getDb } from '../db/database.js';
import {
  getAgentUIIntentRecord,
  listAgentUISurfaces,
  upsertAgentUIIntent,
} from '../services/agent-ui-intent.service.js';
import {
  broadcastAgentUIIntent,
  deliverStructuredAgentFeedback,
  getCodexSession,
  listActiveCodexSessions,
} from '../services/codex-session.service.js';
import { askAgentQuestion } from '../services/agent-question.service.js';
import { listSurfaceComments } from './comments.js';
import { formatSchemaErrors, validateJsonSchema } from './validate.js';

export interface PublishSurfaceInput<T = unknown> {
  surfaceKind: string;
  title: string;
  key?: string;
  data: T;
  streaming?: boolean;
}

export interface SurfaceRecord {
  intent: AgentUISurfaceIntent;
  binding?: AgentUIIntentBinding;
}

const MAX_TITLE_LENGTH = 200;

/** Validates `data` against the kind schema, persists the intent, broadcasts it into the session's turn. */
export function publishSurface<T>(
  ctx: AgentToolSessionContext,
  input: PublishSurfaceInput<T>,
): AgentUISurfaceIntent {
  const threadId = ctx.appThreadId;
  if (!threadId) throw new AgentToolError('Surfaces need a saved chat thread.', 'unavailable');
  const definition = requireSurfaceKind(input.surfaceKind);
  assertSurfaceData(definition, input.data);
  const title = normaliseTitle(input.title);
  const key = input.key?.trim() || undefined;
  const now = new Date().toISOString();
  const intent: AgentUISurfaceIntent = {
    protocolVersion: AGENT_UI_PROTOCOL_VERSION,
    id: `surface:${randomUUID()}`,
    kind: 'surface',
    revision: 1,
    scope: {
      threadId,
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      ...providerThreadScope(threadId),
    },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: definition.kind,
      title,
      ...(key ? { key } : {}),
      streaming: input.streaming === true,
      digest: definition.digest(input.data),
      data: input.data,
    },
    createdAt: now,
    updatedAt: now,
  };
  const saved = upsertAgentUIIntent({
    intent,
    binding: { provider: ctx.provider, sessionId: ctx.sessionId },
  }) as AgentUISurfaceIntent;
  broadcastAgentUIIntent(saved, ctx.sessionId);
  if (key) supersedePrevious(threadId, key, saved.id);
  return saved;
}

/**
 * Applies `update` to the current data when `baseRevision` matches (else
 * throws AgentToolError 'conflict'), re-validates, persists and broadcasts.
 * Pass `baseRevision: undefined` for trusted main-process updates (actions).
 */
export function patchSurface<T>(
  surfaceId: string,
  baseRevision: number | undefined,
  update: (data: T) => T,
  options?: { title?: string; streaming?: boolean },
): AgentUISurfaceIntent {
  const record = requireSurfaceRecord(surfaceId);
  const current = record.intent;
  if (baseRevision !== undefined && baseRevision !== current.revision) {
    throw new AgentToolError(
      `Surface revision ${baseRevision} is stale; current revision is ${current.revision}. Re-read the surface and retry.`,
      'conflict',
    );
  }
  const definition = requireSurfaceKind(current.payload.surfaceKind);
  const data = update(structuredClone(current.payload.data) as T);
  assertSurfaceData(definition, data);
  const next: AgentUISurfaceIntent = {
    ...current,
    revision: current.revision + 1,
    payload: {
      ...current.payload,
      title: options?.title !== undefined ? normaliseTitle(options.title) : current.payload.title,
      streaming: options?.streaming ?? current.payload.streaming,
      digest: definition.digest(data),
      data,
    },
    updatedAt: new Date().toISOString(),
  };
  const saved = upsertAgentUIIntent({
    intent: next,
    binding: record.binding,
  }) as AgentUISurfaceIntent;
  broadcastAgentUIIntent(saved, record.binding?.sessionId);
  return saved;
}

export function getSurface(surfaceId: string): AgentUISurfaceIntent | null {
  return getSurfaceRecord(surfaceId)?.intent ?? null;
}

export function getSurfaceRecord(surfaceId: string): SurfaceRecord | null {
  const record = getAgentUIIntentRecord(surfaceId);
  if (!record || record.intent.kind !== 'surface') return null;
  return { intent: record.intent, binding: record.binding };
}

/** Like getSurface, but enforces that the surface belongs to the calling session's thread. */
export function requireSurfaceInScope(
  ctx: AgentToolSessionContext,
  surfaceId: unknown,
): AgentUISurfaceIntent {
  if (typeof surfaceId !== 'string' || !surfaceId.trim()) {
    throw new AgentToolError('surfaceId is required.', 'invalid-params');
  }
  const intent = getSurface(surfaceId);
  if (!intent) throw new AgentToolError(`Surface not found: ${surfaceId}`, 'not-found');
  if (!ctx.appThreadId || intent.scope.threadId !== ctx.appThreadId) {
    throw new AgentToolError('Surface belongs to another thread.', 'forbidden');
  }
  return intent;
}

/**
 * Sends structured feedback (surface action, anchored comment) to the agent
 * session that owns the surface: steer when a turn is active and supported,
 * prompt when ready, queue otherwise. Returns false when no live session.
 */
export async function deliverSurfaceFeedback(surfaceId: string, message: string): Promise<boolean> {
  const record = getSurfaceRecord(surfaceId);
  if (!record) return false;
  const sessionId = resolveSurfaceSessionId(record);
  if (!sessionId) return false;
  const payload = JSON.stringify({
    type: 'anvil.surface.feedback',
    surfaceId,
    surfaceKind: record.intent.payload.surfaceKind,
    title: record.intent.payload.title,
    message,
  });
  return deliverStructuredAgentFeedback(sessionId, payload);
}

/** Shared question lifecycle; kept here for existing surface action callers. */
export { resolveAnvilOwnedQuestion } from '../services/agent-question.service.js';

export async function requestUserApproval(
  ctx: AgentToolSessionContext,
  request: { title: string; detail: string; consequences?: string },
  signal?: AbortSignal,
  options?: { keepAcrossTurns?: boolean },
): Promise<boolean> {
  if (!ctx.appThreadId) return false;
  const context = [request.detail.trim(), request.consequences?.trim()]
    .filter(Boolean)
    .join('\n\n');
  const result = await askAgentQuestion(
    ctx,
    {
      title: normaliseTitle(request.title),
      questions: [
        {
          id: 'approve',
          kind: 'approval',
          question: normaliseTitle(request.title),
          ...(context ? { context } : {}),
          required: true,
          allowCancel: true,
        },
      ],
    },
    signal,
    options,
  );
  return result.status === 'answered' && result.answers.approve === true;
}

// ---------------------------------------------------------------------------
// Tool helpers shared by kind tool providers
// ---------------------------------------------------------------------------

export function validateToolArgs(tool: AgentToolDefinition, args: Record<string, unknown>): void {
  const errors = validateJsonSchema(tool.inputSchema, args, 'args');
  if (errors.length > 0) {
    throw new AgentToolError(`Invalid arguments: ${formatSchemaErrors(errors)}`, 'invalid-params');
  }
}

/** Compact tool result: digest text plus ids, never the full payload. */
export function surfaceResult(
  intent: AgentUISurfaceIntent,
  extra: Record<string, unknown> = {},
): AgentToolCallResult {
  return textResult(
    `${intent.payload.digest}\n(surfaceId: ${intent.id}, revision: ${intent.revision})`,
    { surfaceId: intent.id, revision: intent.revision, ...extra },
  );
}

/** Builds a provider from tool definitions plus handlers; args are validated first. */
export function createToolProvider(
  id: string,
  entries: Array<{
    tool: AgentToolDefinition;
    handler: (
      ctx: AgentToolSessionContext,
      args: Record<string, unknown>,
    ) => Promise<AgentToolCallResult> | AgentToolCallResult;
  }>,
): AgentToolProvider {
  const byName = new Map(entries.map((entry) => [entry.tool.name, entry]));
  return {
    id,
    tools: () => entries.map((entry) => entry.tool),
    async call(ctx, name, args) {
      const entry = byName.get(name);
      if (!entry) return undefined;
      validateToolArgs(entry.tool, args ?? {});
      return entry.handler(ctx, args ?? {});
    },
  };
}

/** Merges several providers under one id (first owner of a tool name wins). */
export function combineToolProviders(
  id: string,
  providers: readonly AgentToolProvider[],
): AgentToolProvider {
  return {
    id,
    tools: (ctx) => providers.flatMap((provider) => provider.tools(ctx)),
    async call(ctx, name, args) {
      for (const provider of providers) {
        const result = await provider.call(ctx, name, args);
        if (result) return result;
      }
      return undefined;
    },
  };
}

export interface SurfaceToolsOptions<T> {
  publishTool?: {
    name?: string;
    description: string;
    /** Logical identity so later publishes supersede earlier ones. */
    key?: (data: T, ctx: AgentToolSessionContext) => string | undefined;
    /** Hydrate or check data (e.g. resolve anchors) before validation. */
    prepare?: (ctx: AgentToolSessionContext, data: T) => T | Promise<T>;
    mutation?: boolean;
  };
  patchTool?: {
    name?: string;
    description: string;
    /** Schema for kind-defined patch operations; omit to only allow whole-data replacement. */
    operations?: JsonSchema;
    apply?: (data: T, operations: unknown[], ctx: AgentToolSessionContext) => T;
  };
}

/**
 * Generates `<kind>_publish` / `<kind>_patch` tools whose input schemas derive
 * from the kind's registered payload schema.
 */
export function defineSurfaceTools<T>(
  surfaceKind: string,
  options: SurfaceToolsOptions<T>,
): AgentToolProvider {
  const definition = requireSurfaceKind(surfaceKind);
  const entries: Parameters<typeof createToolProvider>[1] = [];
  const { publishTool, patchTool } = options;
  if (publishTool) {
    entries.push({
      tool: {
        name: publishTool.name ?? `${surfaceKind}_publish`,
        title: `Publish ${definition.label}`,
        description: publishTool.description,
        feature: definition.feature,
        mutation: publishTool.mutation,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
            data: definition.schema,
            streaming: {
              type: 'boolean',
              description: 'True when more items will follow via the patch tool.',
            },
          },
          required: ['title', 'data'],
          additionalProperties: false,
        },
      },
      handler: async (ctx, args) => {
        let data = args.data as T;
        if (publishTool.prepare) data = await publishTool.prepare(ctx, data);
        const intent = publishSurface(ctx, {
          surfaceKind,
          title: String(args.title),
          key: publishTool.key?.(data, ctx),
          data,
          streaming: args.streaming === true,
        });
        return surfaceResult(intent);
      },
    });
  }
  if (patchTool) {
    const properties: Record<string, JsonSchema> = {
      surfaceId: { type: 'string', minLength: 1 },
      baseRevision: { type: 'integer', minimum: 1 },
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
      streaming: { type: 'boolean' },
      data: { ...definition.schema, description: 'Replaces the whole payload.' },
    };
    if (patchTool.operations)
      properties.operations = { type: 'array', items: patchTool.operations };
    entries.push({
      tool: {
        name: patchTool.name ?? `${surfaceKind}_patch`,
        title: `Update ${definition.label}`,
        description: patchTool.description,
        feature: definition.feature,
        inputSchema: {
          type: 'object',
          properties,
          required: ['surfaceId', 'baseRevision'],
          additionalProperties: false,
        },
      },
      handler: (ctx, args) => {
        const current = requireSurfaceInScope(ctx, args.surfaceId);
        if (current.payload.surfaceKind !== surfaceKind) {
          throw new AgentToolError(`Surface is not a ${definition.label}.`, 'invalid-params');
        }
        const operations = Array.isArray(args.operations) ? args.operations : [];
        if (operations.length > 0 && !patchTool.apply) {
          throw new AgentToolError(
            'This surface only accepts whole-data updates.',
            'invalid-params',
          );
        }
        const intent = patchSurface<T>(
          current.id,
          Number(args.baseRevision),
          (data) => {
            let next = args.data !== undefined ? (args.data as T) : data;
            if (operations.length > 0 && patchTool.apply) {
              next = patchTool.apply(next, operations, ctx);
            }
            return next;
          },
          {
            title: typeof args.title === 'string' ? args.title : undefined,
            streaming: typeof args.streaming === 'boolean' ? args.streaming : undefined,
          },
        );
        return surfaceResult(intent);
      },
    });
  }
  return createToolProvider(`surface:${surfaceKind}`, entries);
}

// ---------------------------------------------------------------------------
// Generic surface tools (provider id 'surfaces')
// ---------------------------------------------------------------------------

const MAX_READ_CHARS = 60_000;

export const surfaceToolProvider: AgentToolProvider = createToolProvider('surfaces', [
  {
    tool: {
      name: 'surface_read',
      title: 'Read surface',
      description:
        'Read the full data of a surface you published (tool results only return digests). Use `select` with a dot path (e.g. "findings.3" or "findings.<id>") to fetch one part.',
      inputSchema: {
        type: 'object',
        properties: {
          surfaceId: { type: 'string', minLength: 1 },
          select: { type: 'string', maxLength: 500 },
        },
        required: ['surfaceId'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const intent = requireSurfaceInScope(ctx, args.surfaceId);
      const selected =
        typeof args.select === 'string' && args.select.trim()
          ? selectPath(intent.payload.data, args.select)
          : intent.payload.data;
      if (selected === undefined) {
        throw new AgentToolError(`Nothing at "${String(args.select)}".`, 'not-found');
      }
      const json = JSON.stringify(selected, null, 2) ?? 'null';
      const text =
        json.length > MAX_READ_CHARS
          ? `${json.slice(0, MAX_READ_CHARS)}\n… truncated (${json.length} chars); narrow with select.`
          : json;
      return textResult(
        `${intent.payload.title} (${intent.payload.surfaceKind}, revision ${intent.revision})\n${text}`,
        { surfaceId: intent.id, revision: intent.revision },
      );
    },
  },
  {
    tool: {
      name: 'surface_comments',
      title: 'List surface comments',
      description:
        'List anchored comments the user left on a surface (default: open ones). Resolve them through the kind’s patch tool or by addressing them in your reply.',
      inputSchema: {
        type: 'object',
        properties: {
          surfaceId: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['open', 'resolved', 'all'] },
        },
        required: ['surfaceId'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const intent = requireSurfaceInScope(ctx, args.surfaceId);
      const status = args.status === 'all' ? undefined : ((args.status as string) ?? 'open');
      const comments = listSurfaceComments(intent.id).filter(
        (comment) => !status || comment.status === status,
      );
      if (comments.length === 0) return textResult('No matching comments.', { comments: [] });
      const lines = comments.map((comment) => {
        const anchor = describeAnchorShort(comment.anchor);
        return `- [${comment.id}] (${comment.status}) ${anchor ? `${anchor}: ` : ''}${comment.body}`;
      });
      return textResult(lines.join('\n'), {
        comments: comments.map(({ id, anchor, body, status: commentStatus }) => ({
          id,
          anchor,
          body,
          status: commentStatus,
        })),
      });
    },
  },
  {
    tool: {
      name: 'surface_complete',
      title: 'Finish streaming a surface',
      description: 'Mark a surface published with streaming: true as complete.',
      inputSchema: {
        type: 'object',
        properties: { surfaceId: { type: 'string', minLength: 1 } },
        required: ['surfaceId'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const intent = requireSurfaceInScope(ctx, args.surfaceId);
      return surfaceResult(
        patchSurface(intent.id, undefined, (data) => data, { streaming: false }),
      );
    },
  },
  {
    tool: {
      name: 'anvil_skill_get',
      title: 'Get an Anvil skill',
      get description() {
        const names = listSkillNames();
        return `Fetch Anvil's craft guidance for a domain task (review rubric, DPIA, diagrams…) before doing it.${
          names.length ? ` Available: ${names.join(', ')}.` : ''
        }`;
      },
      requiresThread: false,
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: (_ctx, args) => {
      const name = String(args.name).trim().replace(/\.md$/, '');
      if (!listSkillNames().includes(name)) {
        throw new AgentToolError(
          `Unknown skill "${name}". Available: ${listSkillNames().join(', ')}.`,
          'not-found',
        );
      }
      return textResult(readFileSync(path.join(promptsDir(), `${name}.md`), 'utf-8'));
    },
  },
]);

export function describeAnchorShort(anchor: {
  type: string;
  label?: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  targetId?: string;
}): string {
  if (anchor.type === 'surface') return anchor.label ?? '';
  const lines =
    anchor.lineStart !== undefined
      ? `:${anchor.lineStart}${anchor.lineEnd && anchor.lineEnd !== anchor.lineStart ? `-${anchor.lineEnd}` : ''}`
      : '';
  const location = anchor.filePath ? `${anchor.filePath}${lines}` : '';
  return [anchor.label, location, anchor.targetId && !anchor.label ? anchor.targetId : '']
    .filter(Boolean)
    .join(' ');
}

function selectPath(data: unknown, select: string): unknown {
  let current: unknown = data;
  for (const segment of select
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current =
        index >= 0
          ? current[index]
          : current.find(
              (item) =>
                typeof item === 'object' &&
                item !== null &&
                (item as Record<string, unknown>).id === segment,
            );
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

let cachedSkillNames: string[] | null = null;

function promptsDir(): string {
  return process.env.ELECTRON_RENDERER_URL
    ? path.join(process.cwd(), 'prompts')
    : path.join(app.getAppPath(), 'prompts');
}

export function listSkillNames(): string[] {
  if (cachedSkillNames) return cachedSkillNames;
  try {
    const dir = promptsDir();
    cachedSkillNames = existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith('.md'))
          .map((file) => file.slice(0, -3))
          .filter((name) => /^[a-z0-9-]+$/.test(name))
          .sort()
      : [];
  } catch {
    cachedSkillNames = [];
  }
  return cachedSkillNames;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function requireSurfaceKind(surfaceKind: string): SurfaceKindDefinition {
  const definition = getSurfaceKind(surfaceKind);
  if (!definition) {
    throw new AgentToolError(`Unknown surface kind: ${surfaceKind}`, 'invalid-params');
  }
  return definition;
}

function requireSurfaceRecord(surfaceId: string): SurfaceRecord {
  const record = getSurfaceRecord(surfaceId);
  if (!record) throw new AgentToolError(`Surface not found: ${surfaceId}`, 'not-found');
  return record;
}

function assertSurfaceData(definition: SurfaceKindDefinition, data: unknown): void {
  const errors = validateJsonSchema(definition.schema, data, 'data');
  if (errors.length > 0) {
    throw new AgentToolError(
      `Invalid ${definition.label} data: ${formatSchemaErrors(errors)}`,
      'invalid-params',
    );
  }
}

function normaliseTitle(title: string): string {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) throw new AgentToolError('A title is required.', 'invalid-params');
  return trimmed.slice(0, MAX_TITLE_LENGTH);
}

function providerThreadScope(threadId: string): { providerThreadId?: string } {
  try {
    const row = getDb()
      .prepare('SELECT provider_thread_id FROM chat_threads WHERE id = ?')
      .get(threadId) as { provider_thread_id: string | null } | undefined;
    return row?.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {};
  } catch {
    return {};
  }
}

function supersedePrevious(threadId: string, key: string, supersededBy: string): void {
  for (const previous of listAgentUISurfaces(threadId, { key })) {
    if (previous.id === supersededBy) continue;
    const record = getSurfaceRecord(previous.id);
    if (!record) continue;
    try {
      const updated = upsertAgentUIIntent({
        intent: {
          ...record.intent,
          revision: record.intent.revision + 1,
          payload: { ...record.intent.payload, streaming: false, supersededBy },
          updatedAt: new Date().toISOString(),
        },
        binding: record.binding,
      });
      broadcastAgentUIIntent(updated, record.binding?.sessionId);
    } catch (error) {
      console.error(`[Surfaces] Could not supersede ${previous.id}:`, error);
    }
  }
}

/** Live session for a surface: its bound session, else any live session on the same thread. */
export function resolveSurfaceSessionId(record: SurfaceRecord): string | null {
  const bound = record.binding?.sessionId;
  if (bound && getCodexSession(bound)) return bound;
  const fallback = listActiveCodexSessions().find(
    (session) => session.appThreadId === record.intent.scope.threadId,
  );
  return fallback?.id ?? null;
}
