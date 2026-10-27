import { useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { parseRowAnchorId } from '../../../../../shared/surfaces/kinds/data';
import { Button } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { DataTable } from '../../shared-ui/DataTable';
import { SvgChart } from '../../shared-ui/SvgChart';
import { sortRows, toggleInSet, type SortState } from '../../shared-ui/table-model';
import {
  ActionStatusLine,
  FilterInput,
  FilterSelect,
  SurfaceSkeleton,
  useSurfaceActions,
} from '../../shared-ui/useSurfaceActions';
import { RowCells, exportCsv, indexedRowId, tableColumns } from './DataParts';
import {
  filterRows,
  indexRows,
  readDataSurface,
  rowAnchor,
  rowLabel,
  seriesPointAnchor,
} from './model';

export const STAGE_CHART_HEIGHT = 300;

export function DataStage(props: SurfaceViewProps & { focusTargetId?: string }) {
  const { intent, onComment, onAction } = props;
  const raw = intent.payload.data;
  const data = useMemo(() => readDataSurface(raw), [raw]);
  const indexed = useMemo(() => indexRows(data.rows), [data.rows]);
  const columns = useMemo(() => tableColumns(data.columns), [data.columns]);
  const [query, setQuery] = useState('');
  const [filterColumn, setFilterColumn] = useState<string>('all');
  const [sort, setSort] = useState<SortState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const focusIndex = props.focusTargetId ? parseRowAnchorId(props.focusTargetId) : null;
  const [activeId, setActiveId] = useState<string | null>(
    focusIndex !== null ? `r${focusIndex}` : null,
  );
  const filterRef = useRef<HTMLInputElement>(null);
  const { run, pending, status } = useSurfaceActions(onAction);
  const title = intent.payload.title;

  const filtered = useMemo(
    () => filterRows(indexed, data.columns, query, filterColumn),
    [indexed, data.columns, query, filterColumn],
  );
  // Export follows what the user sees: filtered and sorted.
  const ordered = useMemo(() => {
    const column = sort ? columns.find((candidate) => candidate.key === sort.key) : undefined;
    return sortRows(filtered, column?.sortValue, sort?.direction ?? 'asc');
  }, [filtered, columns, sort]);
  const activeEntry = indexed.find((entry) => indexedRowId(entry) === activeId);

  if (intent.payload.streaming && data.rows.length === 0) {
    return <SurfaceSkeleton rows={6} label="Loading data" />;
  }

  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 flex-col gap-3"
      onKeyDown={(event) => {
        const tag = (event.target as HTMLElement).tagName;
        if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
          event.preventDefault();
          filterRef.current?.focus();
        }
      }}
    >
      {data.note && <p className="max-w-[72ch] text-sm text-text-secondary">{data.note}</p>}
      {data.chart && (
        <SvgChart
          spec={data.chart}
          columns={data.columns}
          rows={data.rows}
          height={STAGE_CHART_HEIGHT}
          title={title}
          onPointComment={(point) => onComment(seriesPointAnchor(point))}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FilterInput
          inputRef={filterRef}
          value={query}
          onChange={setQuery}
          placeholder="Filter rows (press /)"
          label="Filter rows"
        />
        <FilterSelect
          label="Filter column"
          value={filterColumn}
          options={[
            { value: 'all', label: 'All columns' },
            ...data.columns.map((column) => ({ value: column.key, label: column.label })),
          ]}
          onChange={setFilterColumn}
        />
        <span className="text-xs tabular-nums text-text-tertiary">
          {filtered.length === indexed.length
            ? `${indexed.length} rows`
            : `${filtered.length} of ${indexed.length} rows`}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => exportCsv(title, data.columns, ordered)}
        >
          <Download size={13} aria-hidden="true" />
          Export CSV
        </Button>
      </div>
      {selected.size > 0 && (
        <div
          role="toolbar"
          aria-label="Selected rows"
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span className="text-text-secondary">{selected.size} selected</span>
          <Button
            size="sm"
            variant="primary"
            disabled={pending !== null}
            onClick={() => void run('ask_about', [...selected])}
          >
            Ask agent about these rows
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <DataTable
          caption={`${title}: ${filtered.length} rows`}
          columns={columns}
          rows={filtered}
          getRowId={indexedRowId}
          sort={sort}
          onSortChange={setSort}
          activeRowId={activeId}
          onActiveRowChange={setActiveId}
          selectedIds={selected}
          onToggleSelect={(id) => setSelected((current) => toggleInSet(current, id))}
          onToggleAll={(ids) =>
            setSelected((current) =>
              ids.every((id) => current.has(id)) ? new Set() : new Set([...current, ...ids]),
            )
          }
          onRowKeyDown={(event, entry) => {
            if (event.key === 'c' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              onComment(rowAnchor(data.columns, entry));
            }
          }}
          emptyMessage={indexed.length === 0 ? 'No rows.' : 'No rows match the filter.'}
          dense
        />
      </div>
      {activeEntry && (
        <section
          aria-label={rowLabel(data.columns, activeEntry)}
          className="flex flex-col gap-2 border-t border-border pt-3"
        >
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-text-secondary">
              {rowLabel(data.columns, activeEntry)}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onComment(rowAnchor(data.columns, activeEntry))}
            >
              Comment on row
            </Button>
          </div>
          <RowCells columns={data.columns} entry={activeEntry} onComment={onComment} />
        </section>
      )}
      <p className="text-xs text-text-tertiary">
        Keys: j/k move · space select · enter details · c comment · / filter · arrows explore the
        chart
      </p>
      <ActionStatusLine status={status} />
    </section>
  );
}
