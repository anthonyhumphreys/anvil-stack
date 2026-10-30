import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildChartModel, plotFrame } from '../../../../../shared/surfaces/kinds/data/chart';
import { SeverityBadge, SeveritySummaryBar } from '../SeverityGlyph';
import { SvgChart, nearestPoint, pointLabel } from '../SvgChart';
import { DataTable } from '../DataTable';
import {
  compareSortValues,
  matchesQuery,
  moveSelection,
  nextSort,
  safeFileName,
  sortRows,
  toCsv,
  toggleInSet,
} from '../table-model';

describe('table-model', () => {
  it('sorts naturally with empties last in both directions', () => {
    const rows = [{ v: 'item10' }, { v: '' }, { v: 'item2' }, { v: null }, { v: 'Item1' }];
    expect(sortRows(rows, (row) => row.v, 'asc').map((row) => row.v)).toEqual([
      'Item1',
      'item2',
      'item10',
      '',
      null,
    ]);
    expect(sortRows(rows, (row) => row.v, 'desc').map((row) => row.v)).toEqual([
      'item10',
      'item2',
      'Item1',
      '',
      null,
    ]);
    expect(compareSortValues(2, 10)).toBeLessThan(0);
  });

  it('cycles sort state asc → desc → none', () => {
    expect(nextSort(null, 'a')).toEqual({ key: 'a', direction: 'asc' });
    expect(nextSort({ key: 'a', direction: 'asc' }, 'a')).toEqual({ key: 'a', direction: 'desc' });
    expect(nextSort({ key: 'a', direction: 'desc' }, 'a')).toBeNull();
    expect(nextSort({ key: 'a', direction: 'desc' }, 'b')).toEqual({ key: 'b', direction: 'asc' });
  });

  it('matches all terms case-insensitively', () => {
    expect(matchesQuery('sql INJ', ['SQL injection', 'src/db.ts'])).toBe(true);
    expect(matchesQuery('sql xss', ['SQL injection'])).toBe(false);
    expect(matchesQuery('  ', [])).toBe(true);
  });

  it('moves selection within bounds', () => {
    expect(moveSelection(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(moveSelection(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(moveSelection([], 'a', 1)).toBeNull();
    expect([...toggleInSet(new Set(['a']), 'a')]).toEqual([]);
  });

  it('writes RFC 4180 CSV and neutralises formulas', () => {
    expect(
      toCsv(
        ['Name', 'Value'],
        [
          ['a,b', 1],
          ['=SUM(A1)', -2],
          ['-cmd', null],
          ['say "hi"', 3.5],
        ],
      ),
    ).toBe('Name,Value\r\n"a,b",1\r\n\'=SUM(A1),-2\r\n\'-cmd,\r\n"say ""hi""",3.5');
    expect(safeFileName('Issue trend / Q1', 'csv')).toBe('Issue-trend-Q1.csv');
  });
});

describe('severity glyphs', () => {
  it('always pairs shape with a label', () => {
    const markup = renderToStaticMarkup(<SeverityBadge severity="critical" />);
    expect(markup).toContain('<svg');
    expect(markup).toContain('Critical');
    const compact = renderToStaticMarkup(<SeverityBadge severity="low" compact />);
    expect(compact).toContain('sr-only');
  });

  it('renders counts for every severity', () => {
    const markup = renderToStaticMarkup(
      <SeveritySummaryBar counts={{ critical: 1, high: 2, medium: 0, low: 3, info: 0 }} />,
    );
    for (const label of ['Critical', 'High', 'Medium', 'Low', 'Info'])
      expect(markup).toContain(label);
    expect(markup).toContain('aria-hidden="true" class="flex h-1');
  });
});

describe('SvgChart', () => {
  const columns = [
    { key: 'month', label: 'Month', type: 'string' as const },
    { key: 'open', label: 'Open', type: 'number' as const },
    { key: 'closed', label: 'Closed', type: 'number' as const },
  ];
  const rows = [
    { month: 'Jan', open: 4, closed: 2 },
    { month: 'Feb', open: 6, closed: 5 },
  ];

  it('renders an accessible chart with title, description and legend', () => {
    const markup = renderToStaticMarkup(
      <SvgChart
        spec={{ type: 'bar', x: 'month', y: ['open', 'closed'] }}
        columns={columns}
        rows={rows}
        height={200}
        title="Issues"
      />,
    );
    expect(markup).toContain('<title>Issues</title>');
    expect(markup).toContain('<desc');
    expect(markup).toContain('bar chart of Open, Closed by Month');
    expect(markup).toContain('aria-label="Legend"');
    expect(markup.match(/<rect /g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).toContain('var(--color-info)');
    expect(markup).toContain('height:200px');
  });

  it('finds the nearest point and labels it', () => {
    const model = buildChartModel({ type: 'line', x: 'month', y: ['open'] }, columns, rows);
    const frame = plotFrame(model, {
      width: 200,
      height: 100,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    const near = nearestPoint(model, frame.xToPx, 190);
    expect(near).toEqual({ seriesIndex: 0, pointIndex: 1 });
    expect(pointLabel(model, near!)).toBe('Open, Feb: 6');
  });
});

describe('DataTable', () => {
  it('renders sortable headers, grouping and a show-more control', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `r${index}`,
      group: index % 2 ? 'odd' : 'even',
      n: index,
    }));
    const markup = renderToStaticMarkup(
      <DataTable
        caption="Numbers"
        columns={[
          {
            key: 'n',
            header: 'N',
            render: (row) => row.n,
            sortValue: (row) => row.n,
            align: 'right',
          },
        ]}
        rows={rows}
        getRowId={(row) => row.id}
        sort={{ key: 'n', direction: 'desc' }}
        onSortChange={() => undefined}
        groupBy={(row) => row.group}
        initialVisibleRows={3}
      />,
    );
    expect(markup).toContain('<caption class="sr-only">Numbers</caption>');
    expect(markup).toContain('aria-sort="descending"');
    expect(markup).toContain('scope="rowgroup"');
    expect(markup).toContain('Showing 3 of 5');
    // Grouped: "even" rows (4, 2, 0) come first, sorted descending.
    expect(markup.indexOf('data-row-id="r4"')).toBeLessThan(markup.indexOf('data-row-id="r2"'));
  });
});
