import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { DataChartSpec, DataColumn, DataRow } from '../../../../shared/surfaces/kinds/data';
import {
  barRects,
  buildChartModel,
  categoryLabelStride,
  describeChart,
  formatNumber,
  formatXValue,
  plotFrame,
  seriesPath,
  xAxisTicks,
  type ChartModel,
} from '../../../../shared/surfaces/kinds/data/chart';
import { cx } from '../../ui';

export interface ChartPointRef {
  seriesIndex: number;
  pointIndex: number;
}

export interface SvgChartProps {
  spec: DataChartSpec;
  columns: readonly DataColumn[];
  rows: readonly DataRow[];
  /** Fixed pixel height (reserved up front; no layout shift). */
  height: number;
  title: string;
  compact?: boolean;
  /** Called with the active point when the user presses `c` or the comment button. */
  onPointComment?: (point: {
    seriesKey: string;
    seriesLabel: string;
    rowIndex: number;
    label: string;
  }) => void;
  className?: string;
}

const DEFAULT_WIDTH = 640;

function color(token: string): string {
  return `var(--color-${token})`;
}

export function pointLabel(model: ChartModel, ref: ChartPointRef): string {
  const series = model.series[ref.seriesIndex];
  const point = series?.points[ref.pointIndex];
  if (!series || !point) return '';
  return `${series.label}, ${point.xLabel || formatXValue(model, point.x)}: ${formatNumber(point.y)}`;
}

/** Nearest point (by horizontal distance) to a pixel x, across series. */
export function nearestPoint(
  model: ChartModel,
  xToPx: (x: number) => number,
  px: number,
  py?: number,
  yToPx?: (y: number) => number,
): ChartPointRef | null {
  let best: ChartPointRef | null = null;
  let bestDistance = Infinity;
  model.series.forEach((series, seriesIndex) => {
    series.points.forEach((point, pointIndex) => {
      const dx = xToPx(point.x) - px;
      const dy = py !== undefined && yToPx ? yToPx(point.y) - py : 0;
      const distance = dx * dx + dy * dy * (model.type === 'scatter' ? 1 : 0.05);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { seriesIndex, pointIndex };
      }
    });
  });
  return best;
}

export function SvgChart({
  spec,
  columns,
  rows,
  height,
  title,
  compact = false,
  onPointComment,
  className,
}: SvgChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [active, setActive] = useState<ChartPointRef | null>(null);
  const descId = useId();
  const liveId = useId();

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? DEFAULT_WIDTH);
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => buildChartModel(spec, columns, rows), [spec, columns, rows]);
  const geometry = useMemo(
    () => ({
      width,
      height,
      margin: { top: 12, right: 12, bottom: compact ? 24 : 32, left: compact ? 40 : 52 },
    }),
    [width, height, compact],
  );
  const frame = useMemo(() => plotFrame(model, geometry), [model, geometry]);
  const description = useMemo(() => describeChart(model), [model]);
  const isBar = model.type === 'bar' || model.type === 'stacked-bar';
  const rects = useMemo(() => (isBar ? barRects(model, frame) : []), [isBar, model, frame]);
  const yTicks = compact
    ? model.yTicks.ticks.filter((_, index) => index % 2 === 0)
    : model.yTicks.ticks;
  const activePoint = active
    ? model.series[active.seriesIndex]?.points[active.pointIndex]
    : undefined;
  const activeSeries = active ? model.series[active.seriesIndex] : undefined;

  const handleMove = (event: MouseEvent<SVGSVGElement>) => {
    if (isBar) return;
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const py = ((event.clientY - box.top) / box.height) * height;
    setActive(nearestPoint(model, frame.xToPx, px, py, frame.yToPx));
  };

  const commentOnActive = () => {
    if (!active || !activePoint || !activeSeries || !onPointComment) return;
    onPointComment({
      seriesKey: activeSeries.key,
      seriesLabel: activeSeries.label,
      rowIndex: activePoint.rowIndex,
      label: pointLabel(model, active),
    });
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const seriesCount = model.series.length;
    if (seriesCount === 0) return;
    const current = active ?? { seriesIndex: 0, pointIndex: -1 };
    const points = model.series[current.seriesIndex]?.points ?? [];
    let next: ChartPointRef;
    if (event.key === 'ArrowRight') {
      next = { ...current, pointIndex: Math.min(points.length - 1, current.pointIndex + 1) };
    } else if (event.key === 'ArrowLeft') {
      next = { ...current, pointIndex: Math.max(0, current.pointIndex - 1) };
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const seriesIndex =
        (current.seriesIndex + (event.key === 'ArrowDown' ? 1 : -1) + seriesCount) % seriesCount;
      const length = model.series[seriesIndex].points.length;
      next = { seriesIndex, pointIndex: Math.max(0, Math.min(length - 1, current.pointIndex)) };
    } else if (event.key === 'Home') {
      next = { ...current, pointIndex: 0 };
    } else if (event.key === 'End') {
      next = { ...current, pointIndex: points.length - 1 };
    } else if (event.key === 'Escape') {
      setActive(null);
      return;
    } else if (event.key === 'c' && onPointComment) {
      event.preventDefault();
      commentOnActive();
      return;
    } else {
      return;
    }
    event.preventDefault();
    if (next.pointIndex >= 0) setActive(next);
  };

  const tooltipX = activePoint ? frame.xToPx(activePoint.x) : 0;
  const tooltipY = activePoint
    ? frame.yToPx(model.type === 'stacked-bar' ? activePoint.y0 + activePoint.y : activePoint.y)
    : 0;
  const showMarkers = (count: number) => model.type === 'scatter' || count <= (compact ? 40 : 120);

  return (
    <figure className={cx('m-0 flex flex-col gap-2', className)}>
      {(spec.title || !compact) && (
        <figcaption className="text-xs font-medium text-text-secondary">
          {spec.title ?? title}
        </figcaption>
      )}
      <div ref={containerRef} className="relative w-full" style={{ height }}>
        <svg
          role="img"
          aria-label={`${spec.title ?? title}. Use arrow keys to explore points.`}
          aria-describedby={`${descId} ${liveId}`}
          tabIndex={0}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          onMouseMove={handleMove}
          onMouseLeave={() => setActive(null)}
          onKeyDown={handleKeyDown}
          className="block overflow-visible rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <title>{spec.title ?? title}</title>
          <desc id={descId}>{description}</desc>
          {yTicks.map((tick) => (
            <g key={`y${tick}`}>
              <line
                x1={frame.left}
                x2={frame.right}
                y1={frame.yToPx(tick)}
                y2={frame.yToPx(tick)}
                stroke="var(--color-border-subtle)"
                strokeWidth={1}
              />
              <text
                x={frame.left - 6}
                y={frame.yToPx(tick) + 3}
                textAnchor="end"
                className="fill-text-tertiary text-[11px]"
              >
                {formatNumber(tick, model.yTicks.step)}
              </text>
            </g>
          ))}
          <line
            x1={frame.left}
            x2={frame.right}
            y1={frame.bottom}
            y2={frame.bottom}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
          {model.xKind === 'category'
            ? model.categories.map((category, index) =>
                index %
                  categoryLabelStride(
                    model.categories.length,
                    frame.right - frame.left,
                    compact ? 64 : 56,
                  ) ===
                0 ? (
                  <text
                    key={`x${index}`}
                    x={frame.xToPx(index)}
                    y={frame.bottom + 14}
                    textAnchor="middle"
                    className="fill-text-tertiary text-[11px]"
                  >
                    {category.length > 12 ? `${category.slice(0, 11)}…` : category}
                  </text>
                ) : null,
              )
            : xAxisTicks(model, compact ? 4 : 6).map((tick) => (
                <text
                  key={`x${tick}`}
                  x={frame.xToPx(tick)}
                  y={frame.bottom + 14}
                  textAnchor="middle"
                  className="fill-text-tertiary text-[11px]"
                >
                  {formatXValue(model, tick)}
                </text>
              ))}

          {isBar &&
            rects.map((rect) => {
              const series = model.series[rect.seriesIndex];
              const isActive =
                active?.seriesIndex === rect.seriesIndex && active.pointIndex === rect.pointIndex;
              return (
                <rect
                  key={`${rect.seriesIndex}:${rect.pointIndex}`}
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  rx={Math.min(2, rect.width / 4)}
                  fill={color(series.token)}
                  fillOpacity={active && !isActive ? 0.55 : 1}
                  stroke={isActive ? 'var(--color-text-primary)' : 'none'}
                  strokeWidth={isActive ? 1 : 0}
                  onMouseEnter={() =>
                    setActive({ seriesIndex: rect.seriesIndex, pointIndex: rect.pointIndex })
                  }
                />
              );
            })}

          {!isBar &&
            model.series.map((series) => (
              <g key={series.key}>
                {model.type === 'area' && (
                  <path
                    d={seriesPath(series.points, frame, true)}
                    fill={color(series.token)}
                    fillOpacity={0.16}
                    stroke="none"
                  />
                )}
                {model.type !== 'scatter' && (
                  <path
                    d={seriesPath(series.points, frame, false)}
                    fill="none"
                    stroke={color(series.token)}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                )}
                {showMarkers(series.points.length) &&
                  series.points.map((point, index) => (
                    <circle
                      key={index}
                      cx={frame.xToPx(point.x)}
                      cy={frame.yToPx(point.y)}
                      r={model.type === 'scatter' ? 3.5 : 2.5}
                      fill={color(series.token)}
                    />
                  ))}
              </g>
            ))}

          {activePoint && activeSeries && !isBar && (
            <g aria-hidden="true">
              <line
                x1={tooltipX}
                x2={tooltipX}
                y1={frame.top}
                y2={frame.bottom}
                stroke="var(--color-border)"
                strokeDasharray="3 3"
              />
              <circle
                cx={tooltipX}
                cy={tooltipY}
                r={5}
                fill="var(--color-bg-primary)"
                stroke={color(activeSeries.token)}
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
        {activePoint && active && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-text-primary shadow-sm"
            style={{
              left: Math.max(60, Math.min(width - 60, tooltipX)),
              top: Math.max(24, tooltipY - 8),
            }}
          >
            {pointLabel(model, active)}
          </div>
        )}
      </div>
      <p id={liveId} aria-live="polite" className="sr-only">
        {active ? pointLabel(model, active) : ''}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
        {model.series.length > 1 || !compact ? (
          <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {model.series.map((series) => (
              <li key={series.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: color(series.token) }}
                />
                {series.label}
              </li>
            ))}
          </ul>
        ) : null}
        {model.skipped > 0 && (
          <span className="text-text-tertiary">
            {model.skipped} row{model.skipped === 1 ? '' : 's'} not plotted
          </span>
        )}
        {onPointComment && active && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={commentOnActive}
            className="ml-auto rounded-md px-2 py-0.5 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            Comment on point
          </button>
        )}
      </div>
    </figure>
  );
}
