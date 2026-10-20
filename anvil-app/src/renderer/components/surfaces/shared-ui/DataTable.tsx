import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cx } from '../../ui';
import { moveSelection, nextSort, orderRows, type SortState, type SortValue } from './table-model';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => SortValue;
  align?: 'left' | 'right';
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  /** Accessible table name. */
  caption: string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  activeRowId?: string | null;
  onActiveRowChange?: (id: string) => void;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
  /** Per-row actions, revealed on row hover or focus. */
  rowActions?: (row: T) => ReactNode;
  /** Kind-specific shortcuts on the focused row (d, f, c…). */
  onRowKeyDown?: (event: KeyboardEvent<HTMLTableRowElement>, row: T) => void;
  groupBy?: (row: T) => string;
  initialVisibleRows?: number;
  emptyMessage?: string;
  dense?: boolean;
  className?: string;
}

const PAGE = 200;

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  sort = null,
  onSortChange,
  activeRowId,
  onActiveRowChange,
  selectedIds,
  onToggleSelect,
  onToggleAll,
  rowActions,
  onRowKeyDown,
  groupBy,
  initialVisibleRows = PAGE,
  emptyMessage = 'Nothing to show.',
  dense = false,
  className,
}: DataTableProps<T>) {
  const [visible, setVisible] = useState(initialVisibleRows);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  const sorted = useMemo(() => {
    const column = sort ? columns.find((candidate) => candidate.key === sort.key) : undefined;
    return orderRows(rows, column?.sortValue, sort?.direction ?? 'asc', groupBy);
  }, [rows, columns, sort, groupBy]);

  const shown = sorted.slice(0, visible);
  const shownIds = shown.map(getRowId);
  const selectable = Boolean(onToggleSelect);
  const allSelected =
    selectable && shownIds.length > 0 && shownIds.every((id) => selectedIds?.has(id));
  const cellPad = dense ? 'px-2 py-1' : 'px-2 py-1.5';
  const colCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const focusRow = (id: string | null) => {
    if (!id) return;
    const element = bodyRef.current?.querySelector<HTMLElement>(
      `[data-row-id="${CSS.escape(id)}"]`,
    );
    element?.focus();
    onActiveRowChange?.(id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const id = getRowId(row);
    if (event.target !== event.currentTarget) return;
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      focusRow(moveSelection(shownIds, id, 1));
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      focusRow(moveSelection(shownIds, id, -1));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusRow(event.key === 'Home' ? shownIds[0] : shownIds[shownIds.length - 1]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onActiveRowChange?.(id);
      return;
    }
    if (event.key === ' ' && selectable) {
      event.preventDefault();
      onToggleSelect?.(id);
      return;
    }
    onRowKeyDown?.(event, row);
  };

  const rovingId = activeRowId && shownIds.includes(activeRowId) ? activeRowId : shownIds[0];
  let lastGroup: string | undefined;

  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-text-tertiary">
            {selectable && (
              <th scope="col" className={cx(cellPad, 'w-8')}>
                <input
                  type="checkbox"
                  aria-label="Select all visible rows"
                  checked={allSelected}
                  onChange={() => onToggleAll?.(shownIds)}
                  className="accent-[var(--color-accent)]"
                />
              </th>
            )}
            {columns.map((column) => {
              const active = sort?.key === column.key ? sort.direction : undefined;
              const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined
                  }
                  className={cx(
                    cellPad,
                    'font-medium',
                    column.align === 'right' && 'text-right',
                    column.className,
                  )}
                >
                  {column.sortValue && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(nextSort(sort, column.key))}
                      className={cx(
                        'inline-flex items-center gap-1 rounded-sm hover:text-text-primary',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                        active && 'text-text-primary',
                      )}
                    >
                      {column.header}
                      <Icon size={11} aria-hidden="true" className={active ? '' : 'opacity-40'} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className={cellPad}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {shown.length === 0 && (
            <tr>
              <td colSpan={colCount} className="px-2 py-4 text-center text-text-tertiary">
                {emptyMessage}
              </td>
            </tr>
          )}
          {shown.map((row) => {
            const id = getRowId(row);
            const group = groupBy?.(row);
            const showGroup = group !== undefined && group !== lastGroup;
            lastGroup = group;
            const active = id === activeRowId;
            const selected = selectedIds?.has(id) ?? false;
            return (
              <Fragment key={id}>
                {showGroup && (
                  <tr className="border-b border-border">
                    <th
                      scope="rowgroup"
                      colSpan={colCount}
                      className="px-2 pb-1 pt-3 text-left text-eyebrow uppercase text-text-tertiary"
                    >
                      {group}
                    </th>
                  </tr>
                )}
                <tr
                  data-row-id={id}
                  tabIndex={id === rovingId ? 0 : -1}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onActiveRowChange?.(id)}
                  onKeyDown={(event) => handleKeyDown(event, row)}
                  className={cx(
                    'group border-b border-border-subtle align-top transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
                    onActiveRowChange && 'cursor-pointer',
                    active ? 'bg-bg-tertiary' : 'hover:bg-bg-secondary',
                  )}
                >
                  {selectable && (
                    <td className={cellPad} onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        tabIndex={-1}
                        aria-label="Select row"
                        checked={selected}
                        onChange={() => onToggleSelect?.(id)}
                        className="accent-[var(--color-accent)]"
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cx(
                        cellPad,
                        'break-words',
                        column.align === 'right' && 'text-right tabular-nums',
                        column.className,
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td
                      className={cx(cellPad, 'w-px whitespace-nowrap')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-focus:opacity-100 motion-reduce:transition-none">
                        {rowActions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {sorted.length > shown.length && (
        <div className="flex items-center justify-between gap-2 px-2 py-2 text-xs text-text-tertiary">
          <span>
            Showing {shown.length} of {sorted.length}
          </span>
          <button
            type="button"
            onClick={() => setVisible((count) => count + PAGE)}
            className="rounded-md px-2 py-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Show {Math.min(PAGE, sorted.length - shown.length)} more
          </button>
        </div>
      )}
    </div>
  );
}
