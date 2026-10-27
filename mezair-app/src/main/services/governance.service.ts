import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { dialog, BrowserWindow } from 'electron';
import type {
  GovernanceBoard,
  GovernanceDocument,
  GovernanceFileType,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface BoardRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  workspace_id: string;
  board_id: string | null;
  file_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  description: string | null;
  added_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapBoard(row: BoardRow): GovernanceBoard {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocument(row: DocumentRow): GovernanceDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    boardId: row.board_id ?? undefined,
    filePath: row.file_path,
    fileName: row.file_name,
    fileType: row.file_type as GovernanceFileType,
    fileSize: row.file_size,
    description: row.description ?? undefined,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
  };
}

function inferFileType(filePath: string): GovernanceFileType {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.docx':
      return 'docx';
    case '.pptx':
      return 'pptx';
    case '.xlsx':
      return 'xlsx';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------
// Board CRUD
// ---------------------------------------------------------------------------

export function listBoards(workspaceId: string): GovernanceBoard[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM governance_boards WHERE workspace_id = ? ORDER BY name ASC')
    .all(workspaceId) as BoardRow[];
  return rows.map(mapBoard);
}

export function createBoard(
  workspaceId: string,
  name: string,
  description?: string,
): GovernanceBoard {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO governance_boards (id, workspace_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(id, workspaceId, name, description ?? null);

  const row = db.prepare('SELECT * FROM governance_boards WHERE id = ?').get(id) as BoardRow;
  return mapBoard(row);
}

export function updateBoard(
  id: string,
  opts: { name?: string; description?: string },
): GovernanceBoard {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (opts.name !== undefined) {
    sets.push('name = ?');
    params.push(opts.name);
  }
  if (opts.description !== undefined) {
    sets.push('description = ?');
    params.push(opts.description);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE governance_boards SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT * FROM governance_boards WHERE id = ?').get(id) as BoardRow;
  if (!row) throw new Error(`Board not found: ${id}`);
  return mapBoard(row);
}

export function deleteBoard(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM governance_boards WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Document CRUD
// ---------------------------------------------------------------------------

export function listDocuments(workspaceId: string, boardId?: string): GovernanceDocument[] {
  const db = getDb();
  if (boardId) {
    const rows = db
      .prepare(
        'SELECT * FROM governance_documents WHERE workspace_id = ? AND board_id = ? ORDER BY file_name ASC',
      )
      .all(workspaceId, boardId) as DocumentRow[];
    return rows.map(mapDocument);
  }
  const rows = db
    .prepare('SELECT * FROM governance_documents WHERE workspace_id = ? ORDER BY file_name ASC')
    .all(workspaceId) as DocumentRow[];
  return rows.map(mapDocument);
}

export function addDocument(
  workspaceId: string,
  filePath: string,
  boardId?: string,
  description?: string,
): GovernanceDocument {
  const db = getDb();
  const id = randomUUID();
  const fileName = path.basename(filePath);
  const fileType = inferFileType(filePath);
  let fileSize = 0;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    // file might not be accessible right now
  }

  db.prepare(
    `INSERT INTO governance_documents (id, workspace_id, board_id, file_path, file_name, file_type, file_size, description, added_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    workspaceId,
    boardId ?? null,
    filePath,
    fileName,
    fileType,
    fileSize,
    description ?? null,
  );

  const row = db.prepare('SELECT * FROM governance_documents WHERE id = ?').get(id) as DocumentRow;
  return mapDocument(row);
}

export function updateDocument(
  id: string,
  opts: { boardId?: string | null; description?: string },
): GovernanceDocument {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (opts.boardId !== undefined) {
    sets.push('board_id = ?');
    params.push(opts.boardId);
  }
  if (opts.description !== undefined) {
    sets.push('description = ?');
    params.push(opts.description);
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE governance_documents SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT * FROM governance_documents WHERE id = ?').get(id) as DocumentRow;
  if (!row) throw new Error(`Document not found: ${id}`);
  return mapDocument(row);
}

export function removeDocument(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM governance_documents WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// File picker dialog
// ---------------------------------------------------------------------------

export async function selectGovernanceFiles(): Promise<string[]> {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow!, {
    title: 'Select governance documents',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Documents',
        extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled) return [];
  return filePaths;
}
