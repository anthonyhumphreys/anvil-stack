import type { DataColumn } from '../../../../../shared/surfaces/kinds/data';
import { rowAnchorId } from '../../../../../shared/surfaces/kinds/data';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import { cx } from '../../../ui';
import type { DataTableColumn } from '../../shared-ui/DataTable';
import { CommentButton, downloadText } from '../../shared-ui/useSurfaceActions';
import { safeFileName } from '../../shared-ui/table-model';
import { cellAnchor, cellSortValue, formatCell, rowsToCsv, type IndexedRow } from './model';

export function tableColumns(columns: readonly DataColumn[]): DataTableColumn<IndexedRow>[] {
  return columns.map((column) => ({
    key: column.key,
    header: column.label,
    align: column.type === 'number' ? 'right' : 'left',
    render: (entry) => (
      <span
        className={cx(
          column.type === 'string' ? 'text-text-primary' : 'text-text-secondary',
          column.type !== 'string' && 'font-mono',
        )}
      >
        {formatCell(entry.row[column.key], column)}
      </span>
    ),
    sortValue: (entry) => cellSortValue(entry.row[column.key], column),
  }));
}

export function indexedRowId(entry: IndexedRow): string {
  return rowAnchorId(entry.index);
}

export function exportCsv(
  title: string,
  columns: readonly DataColumn[],
  rows: readonly IndexedRow[],
): void {
  downloadText(safeFileName(title, 'csv'), rowsToCsv(columns, rows), 'text/csv;charset=utf-8');
}

/** Values of one row with a comment button per cell (the `cell` anchor). */
export function RowCells({
  columns,
  entry,
  onComment,
}: {
  columns: readonly DataColumn[];
  entry: IndexedRow;
  onComment: (anchor: SurfaceAnchor) => void;
}) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 text-xs">
      {columns.map((column) => (
        <div key={column.key} className="contents">
          <dt className="text-text-tertiary">{column.label}</dt>
          <dd className="break-words font-mono text-text-secondary">
            {formatCell(entry.row[column.key], column) || '—'}
          </dd>
          <dd>
            <CommentButton
              anchor={cellAnchor(column, entry)}
              onComment={onComment}
              label={`Comment on ${column.label}`}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
