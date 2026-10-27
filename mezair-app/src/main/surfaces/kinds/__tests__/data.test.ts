import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dataSurfaceKind,
  digestData,
  parseRowAnchorId,
  validateDataSurface,
  type DataSurfaceData,
} from '../../../../shared/surfaces/kinds/data.js';
import {
  bandScale,
  barRects,
  buildChartModel,
  categoryLabelStride,
  describeChart,
  formatNumber,
  linearScale,
  niceTicks,
  plotFrame,
  seriesPath,
  xAxisTicks,
} from '../../../../shared/surfaces/kinds/data/chart.js';
import { validateJsonSchema } from '../../validate.js';
import { fakeCoreState, getSurface, resetFakeCore, testContext, textOf } from './data-fake-core.js';

vi.mock('../../core.js', async () => await import('./data-fake-core.js'));

const { dataSurfaceHandler, dataSnapshot } = await import('../data.js');
const { normalizeRows } = await import('../data/normalize.js');

const columns = [
  { key: 'month', label: 'Month', type: 'string' as const },
  { key: 'open', label: 'Open', type: 'number' as const },
  { key: 'closed', label: 'Closed', type: 'number' as const },
];
const rows = [
  { month: 'Jan', open: 4, closed: 2 },
  { month: 'Feb', open: 6, closed: 5 },
  { month: 'Mar', open: 3, closed: 7 },
];

beforeEach(() => resetFakeCore());

describe('chart scales and ticks', () => {
  it('produces nice ticks covering the domain', () => {
    expect(niceTicks(0, 97, 5)).toMatchObject({ min: 0, max: 100, step: 20 });
    expect(niceTicks(0.1, 0.87, 5).ticks[0]).toBe(0);
    const flat = niceTicks(5, 5);
    expect(flat.ticks.length).toBeGreaterThanOrEqual(2);
    expect(flat.min).toBeLessThanOrEqual(5);
    expect(flat.max).toBeGreaterThanOrEqual(5);
    const negative = niceTicks(-12, 30);
    expect(negative.min).toBeLessThanOrEqual(-12);
    expect(negative.ticks).toContain(0);
  });

  it('maps linear and band scales', () => {
    const scale = linearScale([0, 10], [100, 0]);
    expect(scale(0)).toBe(100);
    expect(scale(5)).toBe(50);
    expect(linearScale([3, 3], [0, 10])(3)).toBe(5);
    const band = bandScale(4, [0, 400], 0.2);
    expect(band.step).toBe(100);
    expect(band.center(1)).toBe(150);
    expect(band.start(0)).toBeCloseTo(10);
  });

  it('formats numbers compactly and strides crowded labels', () => {
    expect(formatNumber(12_500)).toBe('12.5k');
    expect(formatNumber(2_000_000)).toBe('2M');
    expect(formatNumber(0.25, 0.05)).toBe('0.25');
    expect(categoryLabelStride(100, 560)).toBe(10);
    expect(categoryLabelStride(3, 560)).toBe(1);
  });
});

describe('chart model', () => {
  it('builds grouped bars with a zero baseline', () => {
    const model = buildChartModel(
      { type: 'bar', x: 'month', y: ['open', 'closed'] },
      columns,
      rows,
    );
    expect(model.categories).toEqual(['Jan', 'Feb', 'Mar']);
    expect(model.series.map((series) => series.token)).toEqual(['info', 'accent']);
    expect(model.yTicks.min).toBe(0);
    const frame = plotFrame(model, {
      width: 400,
      height: 200,
      margin: { top: 10, right: 10, bottom: 30, left: 40 },
    });
    const rects = barRects(model, frame);
    expect(rects).toHaveLength(6);
    expect(rects.every((rect) => rect.y + rect.height <= frame.bottom + 0.1)).toBe(true);
  });

  it('stacks bars cumulatively', () => {
    const model = buildChartModel(
      { type: 'stacked-bar', x: 'month', y: ['open', 'closed'] },
      columns,
      rows,
    );
    expect(model.series[1].points[0].y0).toBe(4);
    expect(model.yTicks.max).toBeGreaterThanOrEqual(11);
  });

  it('uses a time axis for date columns and skips unplottable rows', () => {
    const dateColumns = [
      { key: 'day', label: 'Day', type: 'date' as const },
      { key: 'v', label: 'Value', type: 'number' as const },
    ];
    const model = buildChartModel({ type: 'line', x: 'day', y: ['v'] }, dateColumns, [
      { day: '2026-01-03', v: 3 },
      { day: '2026-01-01', v: 1 },
      { day: 'not a date', v: 9 },
      { day: '2026-01-02', v: null },
    ]);
    expect(model.xKind).toBe('date');
    expect(model.series[0].points.map((point) => point.y)).toEqual([1, 3]);
    expect(model.skipped).toBe(2);
    expect(xAxisTicks(model, 3)).toHaveLength(3);
    const frame = plotFrame(model, {
      width: 300,
      height: 100,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(seriesPath(model.series[0].points, frame, false)).toMatch(/^M0,\d+(\.\d)? L300,/);
    expect(seriesPath(model.series[0].points, frame, true)).toMatch(/Z$/);
  });

  it('describes the chart in plain language', () => {
    const model = buildChartModel({ type: 'line', x: 'month', y: ['open'] }, columns, rows);
    const description = describeChart(model);
    expect(description).toContain('line chart of Open by Month');
    expect(description).toContain('3 (Mar) to 6 (Feb)');
  });
});

describe('data kind', () => {
  const data: DataSurfaceData = { columns, rows, chart: { type: 'bar', x: 'month', y: ['open'] } };

  it('validates schema, structural rules and anchors', () => {
    expect(validateJsonSchema(dataSurfaceKind.schema, data)).toEqual([]);
    expect(
      validateJsonSchema(dataSurfaceKind.schema, { columns, rows: [{ month: true }] }).length,
    ).toBeGreaterThan(0);
    expect(
      validateDataSurface({ ...data, chart: { type: 'bar', x: 'nope', y: ['month'] } }),
    ).toEqual(['chart.x "nope" is not a column key.', 'chart.y "month" must be a number column.']);
    expect(parseRowAnchorId('r12:open')).toBe(12);
    expect(parseRowAnchorId('open@r2')).toBeNull();
  });

  it('digests shape, chart and numeric stats', () => {
    const digest = digestData(data, 'Issues');
    expect(digest).toContain('Issues: 3 rows × 3 columns');
    expect(digest).toContain('Chart: bar of open by month');
    expect(digest).toContain('open: min 3, max 6, mean 4.33');
  });

  it('normalises cells to column types', () => {
    expect(
      normalizeRows([{ month: 1, open: '1,200', closed: 'n/a', extra: 'x' }, 'bad'], columns),
    ).toEqual([
      { month: 1, open: 1200, closed: 'n/a' },
      { month: null, open: null, closed: null },
    ]);
  });
});

describe('data_show + actions + share', () => {
  it('publishes the data surface and returns the digest', async () => {
    const result = await dataSurfaceHandler.toolProvider!.call(testContext(), 'data_show', {
      title: 'Issue trend',
      columns,
      rows: [...rows, { month: 'Apr', open: true, closed: 1 }],
      chart: { type: 'line', x: 'month', y: ['open', 'closed'] },
    });
    const intent = getSurface(result?.structuredContent?.surfaceId as string)!;
    expect((intent.payload.data as DataSurfaceData).rows[3].open).toBe('true');
    expect(textOf(result)).toContain('4 rows × 3 columns');
  });

  it('rejects charts referencing unknown columns', async () => {
    await expect(
      dataSurfaceHandler.toolProvider!.call(testContext(), 'data_show', {
        title: 'x',
        columns,
        rows,
        chart: { type: 'bar', x: 'month', y: ['missing'] },
      }),
    ).rejects.toThrow(/not a column key/);
  });

  it('ask_about sends the selected rows; export is renderer-side', async () => {
    const result = await dataSurfaceHandler.toolProvider!.call(testContext(), 'data_show', {
      title: 'T',
      columns,
      rows,
    });
    const intent = getSurface(result?.structuredContent?.surfaceId as string)!;
    const asked = await dataSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_about', targetIds: ['r1', 'r1:open', 'r99'] },
    );
    expect(asked.ok).toBe(true);
    expect(fakeCoreState.delivered[0].message).toContain('- r1: Month=Feb, Open=6, Closed=5');
    expect(fakeCoreState.delivered[0].message).not.toContain('r99');
    const exported = await dataSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'export_csv' },
    );
    expect(exported.ok).toBe(true);
  });

  it('snapshot includes a static SVG chart and table without scripts', () => {
    const snapshot = dataSnapshot(
      {
        columns,
        rows: [...rows, { month: '<script>x</script>', open: 1, closed: 1 }],
        chart: { type: 'area', x: 'month', y: ['open'] },
      },
      'Trend',
    );
    expect(snapshot.html).toContain('<svg');
    expect(snapshot.html).toContain('<desc>area chart of Open by Month');
    expect(snapshot.html).toContain('<table>');
    expect(snapshot.html).not.toMatch(/<script/i);
  });
});
