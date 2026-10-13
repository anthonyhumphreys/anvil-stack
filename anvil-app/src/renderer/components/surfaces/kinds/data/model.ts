import {
  cellAnchorId,
  rowAnchorId,
  seriesPointAnchorId,
  type DataCell,
  type DataColumn,
  type DataRow,
  type DataSurfaceData,
} from '../../../../../shared/surfaces/kinds/data';
import { toTimestamp } from '../../../../../shared/surfaces/kinds/data/chart';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import { matchesQuery, toCsv, type SortValue } from '../../shared-ui/table-model';

export interface IndexedRow {
  index: number;
  row: DataRow;
}

export function readDataSurface(data: unknown): DataSurfaceData {
  const value = (data ?? {}) as Partial<DataSurfaceData>;
  return {
    ...value,
    columns: Array.isArray(value.columns) ? value.columns : [],
    rows: Array.isArray(value.rows) ? value.rows : [],
  } as DataSurfaceData;
}

export function indexRows(rows: readonly DataRow[]): IndexedRow[] {
  return rows.map((row, index) => ({ index, row }));
}

export function formatCell(value: DataCell | undefined, column: DataColumn): string {
  if (value === null || value === undefined) return '';
  if (column.type === 'number' && typeof value === 'number') {
    return value.toLocaleString('en-GB', { maximumFractionDigits: 4 });
  }
  return String(value);
}

export function cellSortValue(value: DataCell | undefined, column: DataColumn): SortValue {
  if (value === null || value === undefined || value === '') return null;
  if (column.type === 'number')
    return typeof value === 'number' ? value : Number(value) || String(value);
  if (column.type === 'date') return toTimestamp(value) ?? String(value);
  return String(value);
}

/** `column` = 'all' searches every column. */
export function filterRows(
  rows: readonly IndexedRow[],
  columns: readonly DataColumn[],
  query: string,
  column: string,
): IndexedRow[] {
  if (!query.trim()) return [...rows];
  const searched =
    column === 'all' ? columns : columns.filter((candidate) => candidate.key === column);
  return rows.filter(({ row }) =>
    matchesQuery(
      query,
      searched.map((candidate) => row[candidate.key]),
    ),
  );
}

export function rowsToCsv(columns: readonly DataColumn[], rows: readonly IndexedRow[]): string {
  return toCsv(
    columns.map((column) => column.label),
    rows.map(({ row }) => columns.map((column) => row[column.key] ?? null)),
  );
}

export function rowLabel(columns: readonly DataColumn[], entry: IndexedRow): string {
  const first = columns[0];
  const value = first ? formatCell(entry.row[first.key], first) : '';
  return `Row ${entry.index + 1}${value ? ` (${first.label}: ${value.slice(0, 40)})` : ''}`;
}

export function rowAnchor(columns: readonly DataColumn[], entry: IndexedRow): SurfaceAnchor {
  return { type: 'row', targetId: rowAnchorId(entry.index), label: rowLabel(columns, entry) };
}

export function cellAnchor(column: DataColumn, entry: IndexedRow): SurfaceAnchor {
  const value = formatCell(entry.row[column.key], column);
  return {
    type: 'cell',
    targetId: cellAnchorId(entry.index, column.key),
    label: `Row ${entry.index + 1} · ${column.label}: ${value.slice(0, 60)}`,
  };
}

export function seriesPointAnchor(point: {
  seriesKey: string;
  rowIndex: number;
  label: string;
}): SurfaceAnchor {
  return {
    type: 'series-point',
    targetId: seriesPointAnchorId(point.seriesKey, point.rowIndex),
    label: point.label,
  };
}
