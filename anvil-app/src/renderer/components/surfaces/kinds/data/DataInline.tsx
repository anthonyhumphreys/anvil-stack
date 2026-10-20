import { useMemo } from 'react';
import { Download, MessageSquarePlus } from 'lucide-react';
import { Button, IconButton } from '../../../ui';
import type { SurfaceViewProps } from '../../types';
import { DataTable } from '../../shared-ui/DataTable';
import { SvgChart } from '../../shared-ui/SvgChart';
import { SurfaceSkeleton } from '../../shared-ui/useSurfaceActions';
import { exportCsv, indexedRowId, tableColumns } from './DataParts';
import { indexRows, readDataSurface, rowAnchor, seriesPointAnchor } from './model';

export const INLINE_CHART_HEIGHT = 220;
const INLINE_ROWS = 8;

export function DataInline({ intent, onComment, onOpenStage }: SurfaceViewProps) {
  const raw = intent.payload.data;
  const data = useMemo(() => readDataSurface(raw), [raw]);
  const indexed = useMemo(() => indexRows(data.rows), [data.rows]);
  const columns = useMemo(() => tableColumns(data.columns), [data.columns]);
  const title = intent.payload.title;

  if (intent.payload.streaming && data.rows.length === 0) {
    return <SurfaceSkeleton label="Loading data" />;
  }

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      {data.note && <p className="max-w-[72ch] text-sm text-text-secondary">{data.note}</p>}
      {data.chart && (
        <SvgChart
          spec={data.chart}
          columns={data.columns}
          rows={data.rows}
          height={INLINE_CHART_HEIGHT}
          title={title}
          compact
          onPointComment={(point) => onComment(seriesPointAnchor(point))}
        />
      )}
      <DataTable
        caption={`${title}: first ${Math.min(INLINE_ROWS, indexed.length)} of ${indexed.length} rows`}
        columns={columns}
        rows={indexed.slice(0, INLINE_ROWS)}
        getRowId={indexedRowId}
        rowActions={(entry) => (
          <IconButton
            icon={MessageSquarePlus}
            label={`Comment on row ${entry.index + 1}`}
            onClick={() => onComment(rowAnchor(data.columns, entry))}
          />
        )}
        onRowKeyDown={(event, entry) => {
          if (event.key === 'c') {
            event.preventDefault();
            onComment(rowAnchor(data.columns, entry));
          }
        }}
        emptyMessage="No rows."
        dense
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => onOpenStage()}>
          {indexed.length > INLINE_ROWS ? `Open all ${indexed.length} rows` : 'Open table'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => exportCsv(title, data.columns, indexed)}>
          <Download size={13} aria-hidden="true" />
          Export CSV
        </Button>
      </div>
    </section>
  );
}
