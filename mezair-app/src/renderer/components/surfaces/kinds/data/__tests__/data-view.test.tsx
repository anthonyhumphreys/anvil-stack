import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import type { DataSurfaceData } from '../../../../../../shared/surfaces/kinds/data';
import type { SurfaceViewProps } from '../../../types';
import { dataSurfaceView } from '..';
import { DataStage } from '../DataStage';
import {
  cellAnchor,
  cellSortValue,
  filterRows,
  formatCell,
  indexRows,
  rowAnchor,
  rowsToCsv,
  seriesPointAnchor,
} from '../model';

const columns = [
  { key: 'day', label: 'Day', type: 'date' as const },
  { key: 'team', label: 'Team', type: 'string' as const },
  { key: 'count', label: 'Count', type: 'number' as const },
];
const rows = Array.from({ length: 12 }, (_, index) => ({
  day: `2026-01-${String(index + 1).padStart(2, '0')}`,
  team: index % 2 ? 'Web' : 'API',
  count: index * 1.5,
}));
const data: DataSurfaceData = {
  columns,
  rows,
  chart: { type: 'line', x: 'day', y: ['count'], title: 'Daily count' },
  note: 'Sampled from CI.',
};

function props(payloadData: unknown = data): SurfaceViewProps {
  const intent: AgentUISurfaceIntent = {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'data',
      title: 'Daily count',
      streaming: false,
      digest: '',
      data: payloadData,
    },
    createdAt: '',
    updatedAt: '',
  };
  return {
    intent,
    presentation: 'inline',
    onAction: async () => ({ ok: true }),
    onComment: () => undefined,
    onOpenStage: () => undefined,
  };
}

describe('data model', () => {
  const indexed = indexRows(rows);

  it('filters by any or one column', () => {
    expect(filterRows(indexed, columns, 'web', 'all')).toHaveLength(6);
    expect(filterRows(indexed, columns, 'web', 'day')).toHaveLength(0);
    expect(filterRows(indexed, columns, '', 'all')).toHaveLength(12);
  });

  it('formats and sorts cells by column type', () => {
    expect(formatCell(1234.5, columns[2])).toBe('1,234.5');
    expect(formatCell(null, columns[2])).toBe('');
    expect(cellSortValue('2026-01-02', columns[0])).toBe(Date.parse('2026-01-02'));
    expect(cellSortValue('', columns[1])).toBeNull();
  });

  it('exports CSV and builds row/cell/series-point anchors', () => {
    expect(rowsToCsv(columns, indexed.slice(0, 1))).toBe('Day,Team,Count\r\n2026-01-01,API,0');
    expect(rowAnchor(columns, indexed[2])).toEqual({
      type: 'row',
      targetId: 'r2',
      label: 'Row 3 (Day: 2026-01-03)',
    });
    expect(cellAnchor(columns[2], indexed[2])).toMatchObject({
      type: 'cell',
      targetId: 'r2:count',
    });
    expect(seriesPointAnchor({ seriesKey: 'count', rowIndex: 4, label: 'x' })).toEqual({
      type: 'series-point',
      targetId: 'count@r4',
      label: 'x',
    });
  });
});

describe('data views', () => {
  it('inline renders the chart at a fixed height and the first rows', () => {
    const markup = renderToStaticMarkup(<dataSurfaceView.Inline {...props()} />);
    expect(markup).toContain('height:220px');
    expect(markup).toContain('<title>Daily count</title>');
    expect(markup).toContain('first 8 of 12 rows');
    expect(markup).toContain('Open all 12 rows');
    expect(markup).toContain('Export CSV');
    expect(markup).toContain('data-row-id="r7"');
    expect(markup).not.toContain('data-row-id="r8"');
  });

  it('stage renders the full table with filter, column filter and export', () => {
    const markup = renderToStaticMarkup(
      <DataStage {...props()} presentation="stage" focusTargetId="r3" />,
    );
    expect(markup).toContain('aria-label="Filter rows"');
    expect(markup).toContain('aria-label="Filter column"');
    expect(markup).toContain('2026-01-12');
    expect(markup).toContain('height:300px');
    // Focused row detail exposes per-cell comment anchors.
    expect(markup).toContain('aria-label="Comment on Count"');
  });

  it('renders without a chart and tolerates malformed data', () => {
    const markup = renderToStaticMarkup(
      <dataSurfaceView.Inline {...props({ columns, rows: rows.slice(0, 2) })} />,
    );
    expect(markup).not.toContain('<svg role="img"');
    expect(markup).toContain('Open table');
    expect(() => renderToStaticMarkup(<dataSurfaceView.Inline {...props(null)} />)).not.toThrow();
  });
});
