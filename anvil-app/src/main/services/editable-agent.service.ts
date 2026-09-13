/**
 * User-defined (editable) agents: SQLite-backed, synced via the
 * `editable-agent` entity type, and surfaced as Persona objects so workflow
 * nodes, automations, and chat resolve them identically to compiled-in
 * personas. Builtin personas never appear here and are never synced.
 */
import { randomUUID } from 'node:crypto';
import type { EditableAgent, EditableAgentInput, Persona } from '../../shared/types.js';
import {
  SYNC_ENTITY_EDITABLE_AGENT,
  SYNC_ENTITY_SCHEMA_VERSIONS,
} from '../../shared/sync-mesh.js';
import { getDb } from '../db/database.js';
import { withSyncedEntityWrite } from './sync-persistence.service.js';

export type { EditableAgent, EditableAgentInput };

interface EditableAgentRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  colour: string;
  prompt_body: string;
  can_write_files: number;
  can_run_commands: number;
  can_read_files: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: EditableAgentRow): EditableAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    colour: row.colour,
    promptBody: row.prompt_body,
    capabilities: {
      canWriteFiles: row.can_write_files === 1,
      canRunCommands: row.can_run_commands === 1,
      canReadFiles: row.can_read_files === 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listEditableAgents(): EditableAgent[] {
  const rows = getDb()
    .prepare('SELECT * FROM editable_agents ORDER BY name')
    .all() as EditableAgentRow[];
  return rows.map(mapRow);
}

export function getEditableAgent(id: string): EditableAgent | null {
  const row = getDb()
    .prepare('SELECT * FROM editable_agents WHERE id = ?')
    .get(id) as EditableAgentRow | undefined;
  return row ? mapRow(row) : null;
}

export function editableAgentToPersona(agent: EditableAgent): Persona {
  return {
    id: agent.id,
    name: agent.name,
    icon: agent.icon,
    colour: agent.colour,
    description: agent.description,
    systemPromptTemplate: '',
    promptBody: agent.promptBody,
    editable: true,
    capabilities: { ...agent.capabilities },
  };
}

/** Canonical sync payload for one editable agent. */
export function editableAgentPayload(agent: EditableAgent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    colour: agent.colour,
    promptBody: agent.promptBody,
    capabilities: { ...agent.capabilities },
  };
}

export function saveEditableAgent(input: EditableAgentInput, agentId?: string): EditableAgent {
  const name = input.name.trim();
  if (!name) throw new Error('Agent name is required.');
  if (!input.promptBody.trim()) throw new Error('Agent prompt is required.');

  const existing = agentId ? getEditableAgent(agentId) : null;
  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  const description = input.description?.trim() ?? '';
  const icon = input.icon?.trim() || 'Bot';
  const colour = input.colour?.trim() || '#64748b';
  const canWrite = input.capabilities?.canWriteFiles !== false;
  const canRun = input.capabilities?.canRunCommands !== false;
  const canRead = input.capabilities?.canReadFiles !== false;

  getDb().transaction(() => {
    withSyncedEntityWrite(
      SYNC_ENTITY_EDITABLE_AGENT,
      id,
      SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_EDITABLE_AGENT],
      existing ? 'update' : 'create',
      () => ({
        id,
        name,
        description,
        icon,
        colour,
        promptBody: input.promptBody,
        capabilities: {
          canWriteFiles: canWrite,
          canRunCommands: canRun,
          canReadFiles: canRead,
        },
      }),
      () => {
        getDb()
          .prepare(
            `INSERT INTO editable_agents
               (id, name, description, icon, colour, prompt_body,
                can_write_files, can_run_commands, can_read_files, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               description = excluded.description,
               icon = excluded.icon,
               colour = excluded.colour,
               prompt_body = excluded.prompt_body,
               can_write_files = excluded.can_write_files,
               can_run_commands = excluded.can_run_commands,
               can_read_files = excluded.can_read_files,
               updated_at = excluded.updated_at`,
          )
          .run(
            id,
            name,
            description,
            icon,
            colour,
            input.promptBody,
            canWrite ? 1 : 0,
            canRun ? 1 : 0,
            canRead ? 1 : 0,
            existing?.createdAt ?? now,
            now,
          );
      },
    );
  })();
  return getEditableAgent(id)!;
}

export function deleteEditableAgent(id: string): void {
  getDb().transaction(() => {
    withSyncedEntityWrite(
      SYNC_ENTITY_EDITABLE_AGENT,
      id,
      SYNC_ENTITY_SCHEMA_VERSIONS[SYNC_ENTITY_EDITABLE_AGENT],
      'delete',
      () => null,
      () => {
        getDb().prepare('DELETE FROM editable_agents WHERE id = ?').run(id);
      },
    );
  })();
}
