// Chart model, scale and tick helpers for the Data surface. Pure: shared by
// the renderer SVG chart and the main-process static share snapshot.
import type { DataChartSpec, DataColumn, DataRow } from '../data.js';

/** Theme token names (`--color-<token>`) used for series, in order. */
export const CHART_SERIES_TOKENS = [
  'info',
  'accent',
  'success',
  'warning',
  'persona-docs',
  'error',
  'persona-architect',
  'persona-reviewer',
] as const;

export function seriesToken(index: number): (typeof CHART_SERIES_TOKENS)[number] {
  return CHART_SERIES_TOKENS[index % CHART_SERIES_TOKENS.length];
}

export interface NiceTicks {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

function niceNumber(range: number, round: boolean): number {
  if (range <= 0 || !Number.isFinite(range)) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let nice: number;
  if (round) {
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3) nice = 2;
    else if (fraction < 7) nice = 5;
    else nice = 10;
  } else if (fraction <= 1) nice = 1;
  else if (fraction <= 2) nice = 2;
  else if (fraction <= 5) nice = 5;
  else nice = 10;
  return nice * 10 ** exponent;
}

/** "Nice" axis bounds and ticks (Heckbert). Always returns ≥ 2 ticks. */
export function niceTicks(min: number, max: number, count = 5): NiceTicks {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
    lo -= pad;
    hi += pad;
    if (min === 0 || min > 0) lo = Math.max(0, lo);
  }
  const range = niceNumber(hi - lo, false);
  const step = niceNumber(range / Math.max(1, count - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  for (let value = niceMin; value <= niceMax + step / 2; value += step) {
    ticks.push(Number(value.toFixed(decimals)));
  }
  return { min: niceMin, max: niceMax, step, ticks };
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export interface BandScale {
  bandwidth: number;
  step: number;
  /** Left edge of band `index`. */
  start(index: number): number;
  center(index: number): number;
}

export function bandScale(
  count: number,
  range: readonly [number, number],
  padding = 0.2,
): BandScale {
  const [r0, r1] = range;
  const safeCount = Math.max(1, count);
  const step = (r1 - r0) / safeCount;
  const bandwidth = step * (1 - padding);
  const inset = (step - bandwidth) / 2;
  return {
    bandwidth,
    step,
    start: (index) => r0 + index * step + inset,
    center: (index) => r0 + index * step + step / 2,
  };
}

export function formatNumber(value: number, step?: number): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}k`;
  const decimals =
    step && step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : abs < 1 && abs > 0 ? 2 : 0;
  return value.toFixed(decimals);
}

function trim(value: number): string {
  return Number(value.toFixed(1)).toString();
}

export function formatDate(timestamp: number, spanMs: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  if (spanMs < 2 * 86_400_000) return iso.slice(11, 16);
  if (spanMs < 400 * 86_400_000) return iso.slice(5, 10);
  return iso.slice(0, 7);
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Chart model
// ---------------------------------------------------------------------------

export type ChartXKind = 'category' | 'number' | 'date';

export interface ChartPoint {
  /** Category index (category axis) or numeric/time x value. */
  x: number;
  y: number;
  /** For stacked bars: running base before this value. */
  y0: number;
  rowIndex: number;
  xLabel: string;
}

export interface ChartSeries {
  key: string;
  label: string;
  token: (typeof CHART_SERIES_TOKENS)[number];
  points: ChartPoint[];
}

export interface ChartModel {
  type: DataChartSpec['type'];
  title?: string;
  xKind: ChartXKind;
  xLabel: string;
  categories: string[];
  series: ChartSeries[];
  xDomain: [number, number];
  yTicks: NiceTicks;
  /** Rows dropped because x or y was not plottable. */
  skipped: number;
}

export const CHART_MAX_CATEGORIES = 200;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function buildChartModel(
  spec: DataChartSpec,
  columns: readonly DataColumn[],
  rows: readonly DataRow[],
): ChartModel {
  const xColumn = columns.find((column) => column.key === spec.x);
  const yColumns = spec.y
    .map((key) => columns.find((column) => column.key === key))
    .filter((column): column is DataColumn => Boolean(column));
  const categorical = spec.type === 'bar' || spec.type === 'stacked-bar';
  const xKind: ChartXKind = categorical
    ? 'category'
    : xColumn?.type === 'number'
      ? 'number'
      : xColumn?.type === 'date'
        ? 'date'
        : 'category';

  const categories: string[] = [];
  const categoryIndex = new Map<string, number>();
  const series: ChartSeries[] = yColumns.map((column, index) => ({
    key: column.key,
    label: column.label,
    token: seriesToken(index),
    points: [],
  }));
  let skipped = 0;

  rows.forEach((row, rowIndex) => {
    const rawX = row[spec.x];
    let x: number | null;
    const xLabel = cellText(rawX);
    if (xKind === 'category') {
      if (!categoryIndex.has(xLabel)) {
        if (categories.length >= CHART_MAX_CATEGORIES) {
          skipped += 1;
          return;
        }
        categoryIndex.set(xLabel, categories.length);
        categories.push(xLabel);
      }
      x = categoryIndex.get(xLabel)!;
    } else {
      x = xKind === 'date' ? toTimestamp(rawX) : toNumber(rawX);
    }
    if (x === null) {
      skipped += 1;
      return;
    }
    let plotted = false;
    series.forEach((entry) => {
      const y = toNumber(row[entry.key]);
      if (y === null) return;
      entry.points.push({ x, y, y0: 0, rowIndex, xLabel });
      plotted = true;
    });
    if (!plotted) skipped += 1;
  });

  if (xKind !== 'category') {
    for (const entry of series) entry.points.sort((a, b) => a.x - b.x);
  }

  let yMin = 0;
  let yMax = 0;
  if (spec.type === 'stacked-bar') {
    const positive = new Map<number, number>();
    const negative = new Map<number, number>();
    for (const entry of series) {
      for (const point of entry.points) {
        const bucket = point.y >= 0 ? positive : negative;
        const base = bucket.get(point.x) ?? 0;
        point.y0 = base;
        bucket.set(point.x, base + point.y);
      }
    }
    yMax = Math.max(0, ...positive.values());
    yMin = Math.min(0, ...negative.values());
  } else {
    const values = series.flatMap((entry) => entry.points.map((point) => point.y));
    if (values.length > 0) {
      yMin = Math.min(...values);
      yMax = Math.max(...values);
    }
    if (spec.type !== 'scatter' && spec.type !== 'line') {
      // Bars and areas need a zero baseline.
      yMin = Math.min(0, yMin);
      yMax = Math.max(0, yMax);
    }
  }

  let xDomain: [number, number] = [0, Math.max(0, categories.length - 1)];
  if (xKind !== 'category') {
    const xs = series.flatMap((entry) => entry.points.map((point) => point.x));
    xDomain = xs.length > 0 ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
  }

  return {
    type: spec.type,
    title: spec.title,
    xKind,
    xLabel: xColumn?.label ?? spec.x,
    categories,
    series,
    xDomain,
    yTicks: niceTicks(yMin, yMax, 5),
    skipped,
  };
}

export function formatXValue(
  model: Pick<ChartModel, 'xKind' | 'xDomain' | 'categories'>,
  x: number,
): string {
  if (model.xKind === 'category') return model.categories[x] ?? '';
  if (model.xKind === 'date') return formatDate(x, model.xDomain[1] - model.xDomain[0]);
  return formatNumber(x);
}

/** Up to `count` x tick values for numeric/time axes. */
export function xAxisTicks(model: Pick<ChartModel, 'xKind' | 'xDomain'>, count = 6): number[] {
  const [lo, hi] = model.xDomain;
  if (model.xKind === 'date') {
    if (hi === lo) return [lo];
    const step = (hi - lo) / Math.max(1, count - 1);
    return Array.from({ length: count }, (_, index) => lo + index * step);
  }
  return niceTicks(lo, hi, count).ticks.filter((tick) => tick >= lo && tick <= hi);
}

/** Every nth category label so they never overlap at `width`. */
export function categoryLabelStride(count: number, width: number, minLabelWidth = 56): number {
  if (count <= 0) return 1;
  return Math.max(1, Math.ceil((count * minLabelWidth) / Math.max(1, width)));
}

export interface ChartGeometry {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface PlotFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  xToPx(x: number): number;
  yToPx(y: number): number;
  band?: BandScale;
}

export function plotFrame(model: ChartModel, geometry: ChartGeometry): PlotFrame {
  const left = geometry.margin.left;
  const right = geometry.width - geometry.margin.right;
  const top = geometry.margin.top;
  const bottom = geometry.height - geometry.margin.bottom;
  const yToPx = linearScale([model.yTicks.min, model.yTicks.max], [bottom, top]);
  if (model.xKind === 'category') {
    const band = bandScale(
      model.categories.length,
      [left, right],
      model.type === 'scatter' ? 0 : 0.25,
    );
    return { left, right, top, bottom, yToPx, band, xToPx: (x) => band.center(x) };
  }
  const pad = model.type === 'scatter' ? 8 : 0;
  const xToPx = linearScale(model.xDomain, [left + pad, right - pad]);
  return { left, right, top, bottom, yToPx, xToPx };
}

/** SVG path for a line (or closed area to the baseline). */
export function seriesPath(points: readonly ChartPoint[], frame: PlotFrame, area: boolean): string {
  if (points.length === 0) return '';
  const coords = points.map((point) => `${r(frame.xToPx(point.x))},${r(frame.yToPx(point.y))}`);
  const line = `M${coords.join(' L')}`;
  if (!area) return line;
  // Area charts always include zero in the y domain (see buildChartModel).
  const baseline = r(frame.yToPx(0));
  const first = r(frame.xToPx(points[0].x));
  const last = r(frame.xToPx(points[points.length - 1].x));
  return `${line} L${last},${baseline} L${first},${baseline} Z`;
}

export interface BarRect {
  seriesIndex: number;
  pointIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function barRects(model: ChartModel, frame: PlotFrame): BarRect[] {
  const band = frame.band;
  if (!band) return [];
  const rects: BarRect[] = [];
  const stacked = model.type === 'stacked-bar';
  const seriesCount = Math.max(1, model.series.length);
  const subWidth = stacked ? band.bandwidth : band.bandwidth / seriesCount;
  model.series.forEach((entry, seriesIndex) => {
    entry.points.forEach((point, pointIndex) => {
      const from = stacked ? point.y0 : 0;
      const to = stacked ? point.y0 + point.y : point.y;
      const y1 = frame.yToPx(from);
      const y2 = frame.yToPx(to);
      rects.push({
        seriesIndex,
        pointIndex,
        x: r(band.start(point.x) + (stacked ? 0 : seriesIndex * subWidth)),
        y: r(Math.min(y1, y2)),
        width: r(Math.max(1, subWidth - (stacked ? 0 : 1))),
        height: r(Math.max(0, Math.abs(y2 - y1))),
      });
    });
  });
  return rects;
}

function r(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Plain-language chart description for <desc> and screen readers. */
export function describeChart(model: ChartModel): string {
  const kind = model.type === 'stacked-bar' ? 'stacked bar' : model.type;
  const seriesText = model.series.map((entry) => entry.label).join(', ');
  const pointCount = model.series.reduce((sum, entry) => sum + entry.points.length, 0);
  const extremes = model.series
    .map((entry) => {
      if (entry.points.length === 0) return null;
      const max = entry.points.reduce((best, point) => (point.y > best.y ? point : best));
      const min = entry.points.reduce((best, point) => (point.y < best.y ? point : best));
      return `${entry.label} ranges ${formatNumber(min.y)} (${min.xLabel}) to ${formatNumber(max.y)} (${max.xLabel})`;
    })
    .filter(Boolean)
    .join('; ');
  return `${kind} chart of ${seriesText || 'no series'} by ${model.xLabel}, ${pointCount} points. ${extremes}`.trim();
}
