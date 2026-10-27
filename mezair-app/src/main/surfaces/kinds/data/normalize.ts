// Normalises agent-supplied rows to the Data surface cell model.
import type { DataCell, DataColumn, DataRow } from '../../../../shared/surfaces/kinds/data.js';

const CELL_MAX = 4000;

export function normalizeCell(value: unknown, column: DataColumn): DataCell {
  if (value === null || value === undefined) return null;
  if (column.type === 'number') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') return null;
      const parsed = Number(trimmed.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : trimmed.slice(0, CELL_MAX);
    }
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, CELL_MAX);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  try {
    return JSON.stringify(value).slice(0, CELL_MAX);
  } catch {
    return String(value).slice(0, CELL_MAX);
  }
}

/** Keeps only declared columns, coercing each cell to its column type. */
export function normalizeRows(rows: readonly unknown[], columns: readonly DataColumn[]): DataRow[] {
  return rows.map((raw) => {
    const source =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const row: DataRow = {};
    for (const column of columns) row[column.key] = normalizeCell(source[column.key], column);
    return row;
  });
}
