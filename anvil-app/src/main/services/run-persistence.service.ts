import { randomUUID } from 'node:crypto';
import type { RunCommand, RunCommandSource } from '../../shared/run-types.js';
import { getDb } from '../db/database.js';

// ---------------------------------------------------------------------------
// Internal row type (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface RunCommandRow {
  id: string;
  repo_id: string;
  label: string;
  command: string;
  source: string;
  last_used_at: string | null;
  pinned: number;
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapCommand(row: RunCommandRow): RunCommand {
  return {
    id: row.id,
    repoId: row.repo_id,
    label: row.label,
    command: row.command,
    source: row.source as RunCommandSource,
    lastUsedAt: row.last_used_at ?? undefined,
    pinned: row.pinned === 1,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function saveCommand(
  repoId: string,
  label: string,
  command: string,
  source: 'ai' | 'custom',
): RunCommand {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO run_commands (id, repo_id, label, command, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, repoId, label, command, source);
  return { id, repoId, label, command, source, pinned: false };
}

export function listSavedCommands(repoId: string): RunCommand[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM run_commands WHERE repo_id = ?
       ORDER BY pinned DESC, last_used_at DESC NULLS LAST`,
    )
    .all(repoId) as RunCommandRow[];
  return rows.map(mapCommand);
}

export function pinCommand(commandId: string): void {
  const db = getDb();
  db.prepare('UPDATE run_commands SET pinned = 1 WHERE id = ?').run(commandId);
}

export function unpinCommand(commandId: string): void {
  const db = getDb();
  db.prepare('UPDATE run_commands SET pinned = 0 WHERE id = ?').run(commandId);
}

export function deleteCommand(commandId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM run_commands WHERE id = ?').run(commandId);
}

export function touchCommandUsedAt(repoId: string, command: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('UPDATE run_commands SET last_used_at = ? WHERE repo_id = ? AND command = ?').run(
    now,
    repoId,
    command,
  );
}
