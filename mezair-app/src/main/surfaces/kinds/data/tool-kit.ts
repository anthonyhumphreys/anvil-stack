// Small helpers shared by the findings, dependencies, pipeline and data
// surface handlers: argument validation, repo lookup, digest results and
// agent-message rendering.
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents.js';
import type { JsonSchema, SurfaceActionResult } from '../../../../shared/surfaces/types.js';
import { getDb } from '../../../db/database.js';
import {
  AgentToolError,
  textResult,
  type AgentToolCallResult,
} from '../../../agent-tools/dispatch.js';
import { formatSchemaErrors, validateJsonSchema } from '../../validate.js';

export interface RepoRecord {
  id: string;
  name: string;
  path: string;
}

/** Repo row for an in-scope repo id. Call assertRepoInScope first. */
export function getRepoRecord(repoId: string): RepoRecord {
  const row = getDb().prepare('SELECT id, name, path FROM repos WHERE id = ?').get(repoId) as
    RepoRecord | undefined;
  if (!row) throw new AgentToolError(`Repository not found: ${repoId}`, 'not-found');
  return row;
}

/** Validates tool arguments at the trust boundary. */
export function parseToolArgs<T>(schema: JsonSchema, args: Record<string, unknown>): T {
  const errors = validateJsonSchema(schema, args ?? {});
  if (errors.length > 0) {
    throw new AgentToolError(`Invalid arguments: ${formatSchemaErrors(errors)}`, 'invalid-params');
  }
  return args as T;
}

/** Tool result: the digest plus ids. Never the payload (§5.5). */
export function surfaceToolResult(
  intent: AgentUISurfaceIntent,
  extra: Record<string, unknown> = {},
  note?: string,
): AgentToolCallResult {
  const lines = [
    intent.payload.digest,
    `surfaceId: ${intent.id} · revision ${intent.revision}${intent.payload.streaming ? ' · streaming' : ''}`,
  ];
  if (note) lines.push(note);
  return textResult(lines.join('\n'), {
    surfaceId: intent.id,
    revision: intent.revision,
    ...extra,
  });
}

export function errorResult(message: string): AgentToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Replace `{name}` placeholders. Unknown names are left blank. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '');
}

export function actionError(error: string): SurfaceActionResult {
  return { ok: false, error };
}

export function actionOk(message: string): SurfaceActionResult {
  return { ok: true, message };
}

export function requireTargets(targetIds: readonly string[] | undefined): string[] {
  return Array.from(new Set((targetIds ?? []).filter((id) => typeof id === 'string' && id)));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
