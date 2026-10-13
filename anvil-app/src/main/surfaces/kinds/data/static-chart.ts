// Static SVG rendering of a Data surface chart for share snapshots. Uses the
// same model/scales as the renderer chart (shared/surfaces/kinds/data/chart).
import type { DataSurfaceData } from '../../../../shared/surfaces/kinds/data.js';
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
  type ChartGeometry,
} from '../../../../shared/surfaces/kinds/data/chart.js';
import { escapeHtml } from './share-kit.js';

const GEOMETRY: ChartGeometry = {
  width: 720,
  height: 280,
  margin: { top: 16, right: 16, bottom: 40, left: 56 },
};

export function staticChartSvg(data: DataSurfaceData, title: string): string {
  if (!data.chart) return '';
  const model = buildChartModel(data.chart, data.columns, data.rows);
  const frame = plotFrame(model, GEOMETRY);
  const color = (token: string) => `var(--color-${token})`;
  const parts: string[] = [];

  for (const tick of model.yTicks.ticks) {
    const y = frame.yToPx(tick);
    parts.push(
      `<line x1="${frame.left}" x2="${frame.right}" y1="${y}" y2="${y}" stroke="var(--color-border-subtle)" stroke-width="1"/>`,
      `<text x="${frame.left - 6}" y="${y + 4}" text-anchor="end">${escapeHtml(formatNumber(tick, model.yTicks.step))}</text>`,
    );
  }
  parts.push(
    `<line x1="${frame.left}" x2="${frame.right}" y1="${frame.bottom}" y2="${frame.bottom}" stroke="var(--color-border)" stroke-width="1"/>`,
  );

  if (model.xKind === 'category') {
    const stride = categoryLabelStride(model.categories.length, frame.right - frame.left);
    model.categories.forEach((category, index) => {
      if (index % stride !== 0) return;
      parts.push(
        `<text x="${frame.xToPx(index)}" y="${frame.bottom + 16}" text-anchor="middle">${escapeHtml(category.slice(0, 14))}</text>`,
      );
    });
  } else {
    for (const tick of xAxisTicks(model)) {
      parts.push(
        `<text x="${frame.xToPx(tick)}" y="${frame.bottom + 16}" text-anchor="middle">${escapeHtml(formatXValue(model, tick))}</text>`,
      );
    }
  }

  if (model.type === 'bar' || model.type === 'stacked-bar') {
    for (const rect of barRects(model, frame)) {
      const series = model.series[rect.seriesIndex];
      const point = series.points[rect.pointIndex];
      parts.push(
        `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="${color(series.token)}"><title>${escapeHtml(`${series.label} · ${point.xLabel}: ${formatNumber(point.y)}`)}</title></rect>`,
      );
    }
  } else {
    for (const series of model.series) {
      if (model.type === 'area') {
        parts.push(
          `<path d="${seriesPath(series.points, frame, true)}" fill="${color(series.token)}" fill-opacity="0.18" stroke="none"/>`,
        );
      }
      if (model.type !== 'scatter') {
        parts.push(
          `<path d="${seriesPath(series.points, frame, false)}" fill="none" stroke="${color(series.token)}" stroke-width="2"/>`,
        );
      }
      if (model.type === 'scatter' || series.points.length <= 60) {
        for (const point of series.points) {
          parts.push(
            `<circle cx="${frame.xToPx(point.x)}" cy="${frame.yToPx(point.y)}" r="${model.type === 'scatter' ? 3.5 : 2.5}" fill="${color(series.token)}"><title>${escapeHtml(`${series.label} · ${point.xLabel}: ${formatNumber(point.y)}`)}</title></circle>`,
          );
        }
      }
    }
  }

  // Legend (always; colour is never the only cue: each entry is labelled).
  let legendX = frame.left;
  const legendY = GEOMETRY.height - 8;
  for (const series of model.series) {
    parts.push(
      `<rect x="${legendX}" y="${legendY - 9}" width="10" height="10" rx="2" fill="${color(series.token)}"/>`,
      `<text x="${legendX + 14}" y="${legendY}">${escapeHtml(series.label)}</text>`,
    );
    legendX += 24 + series.label.length * 7;
  }

  const chartTitle = data.chart.title ?? title;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${GEOMETRY.width} ${GEOMETRY.height}" width="${GEOMETRY.width}" height="${GEOMETRY.height}"><title>${escapeHtml(chartTitle)}</title><desc>${escapeHtml(describeChart(model))}</desc>${parts.join('')}</svg>`;
}
