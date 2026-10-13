// Data surface (§8.8): agent-supplied table + optional chart, rendered natively.
import type { JsonSchema, SurfaceKindDefinition } from '../types.js';

export type DataColumnType = 'string' | 'number' | 'date';
export type DataCell = string | number | null;
export type DataRow = Record<string, DataCell>;
export type DataChartType = 'bar' | 'line' | 'area' | 'scatter' | 'stacked-bar';
export const DATA_CHART_TYPES: readonly DataChartType[] = [
  'bar',
  'line',
  'area',
  'scatter',
  'stacked-bar',
];

export interface DataColumn {
  key: string;
  label: string;
  type: DataColumnType;
}

export interface DataChartSpec {
  type: DataChartType;
  x: string;
  y: string[];
  title?: string;
}

export interface DataSurfaceData {
  columns: DataColumn[];
  rows: DataRow[];
  chart?: DataChartSpec;
  note?: string;
}

export type DataActionId = 'export_csv' | 'ask_about';

export const DATA_MAX_ROWS = 5000;
export const DATA_MAX_COLUMNS = 50;
export const DATA_MAX_SERIES = 8;

const cellSchema: JsonSchema = {
  oneOf: [{ type: 'string', maxLength: 4000 }, { type: 'number' }, { type: 'null' }],
};

export const dataColumnSchema: JsonSchema = {
  type: 'object',
  required: ['key', 'label', 'type'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 100 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    type: { type: 'string', enum: ['string', 'number', 'date'] },
  },
  additionalProperties: false,
};

export const dataChartSchema: JsonSchema = {
  type: 'object',
  required: ['type', 'x', 'y'],
  properties: {
    type: { type: 'string', enum: DATA_CHART_TYPES },
    x: { type: 'string', minLength: 1, maxLength: 100 },
    y: {
      type: 'array',
      maxItems: DATA_MAX_SERIES,
      items: { type: 'string', minLength: 1, maxLength: 100 },
    },
    title: { type: 'string', maxLength: 300 },
  },
  additionalProperties: false,
};

export const dataSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['columns', 'rows'],
  properties: {
    columns: { type: 'array', maxItems: DATA_MAX_COLUMNS, items: dataColumnSchema },
    rows: {
      type: 'array',
      maxItems: DATA_MAX_ROWS,
      items: { type: 'object', additionalProperties: cellSchema },
    },
    chart: dataChartSchema,
    note: { type: 'string', maxLength: 4000 },
  },
  additionalProperties: false,
};

/** Stable anchor ids. */
export function rowAnchorId(rowIndex: number): string {
  return `r${rowIndex}`;
}
export function cellAnchorId(rowIndex: number, columnKey: string): string {
  return `r${rowIndex}:${columnKey}`;
}
export function seriesPointAnchorId(seriesKey: string, rowIndex: number): string {
  return `${seriesKey}@r${rowIndex}`;
}

export function parseRowAnchorId(id: string): number | null {
  const match = /^r(\d+)(?::|$)/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Structural checks the JSON-schema subset cannot express: unique column
 * keys, chart axes referencing columns, numeric series. Returns problems.
 */
export function validateDataSurface(data: DataSurfaceData): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const column of data.columns) {
    if (keys.has(column.key)) problems.push(`Duplicate column key "${column.key}".`);
    keys.add(column.key);
  }
  if (data.columns.length === 0) problems.push('At least one column is required.');
  if (data.chart) {
    if (!keys.has(data.chart.x)) problems.push(`chart.x "${data.chart.x}" is not a column key.`);
    if (data.chart.y.length === 0) problems.push('chart.y needs at least one column key.');
    for (const key of data.chart.y) {
      const column = data.columns.find((candidate) => candidate.key === key);
      if (!column) problems.push(`chart.y "${key}" is not a column key.`);
      else if (column.type !== 'number') problems.push(`chart.y "${key}" must be a number column.`);
    }
  }
  return problems;
}

function formatCell(value: DataCell | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function digestData(data: DataSurfaceData, title?: string): string {
  const lines = [
    `${title ? `${title}: ` : ''}${data.rows.length} rows × ${data.columns.length} columns (${data.columns
      .map((column) => `${column.key}:${column.type}`)
      .join(', ')})`,
  ];
  if (data.chart) {
    lines.push(
      `Chart: ${data.chart.type} of ${data.chart.y.join(', ')} by ${data.chart.x}${data.chart.title ? ` "${data.chart.title}"` : ''}`,
    );
  }
  for (const column of data.columns
    .filter((candidate) => candidate.type === 'number')
    .slice(0, 4)) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (const row of data.rows) {
      const value = row[column.key];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count += 1;
    }
    if (count > 0) {
      lines.push(`${column.key}: min ${round(min)}, max ${round(max)}, mean ${round(sum / count)}`);
    }
  }
  const preview = data.rows.slice(0, 3).map(
    (row, index) =>
      `r${index}: ${data.columns
        .slice(0, 6)
        .map((column) => `${column.key}=${formatCell(row[column.key]).slice(0, 40)}`)
        .join(', ')}`,
  );
  lines.push(...preview);
  if (data.note) lines.push(`Note: ${data.note.slice(0, 200)}`);
  return lines.join('\n');
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export const dataSurfaceKind: SurfaceKindDefinition<DataSurfaceData> = {
  kind: 'data',
  label: 'Data',
  schema: dataSurfaceSchema,
  actions: {
    export_csv: {
      label: 'Export CSV',
      // Runs entirely in the renderer (download); main acknowledges only.
      semantics: { type: 'anvil-command', command: 'data.export-csv' },
      targets: 'none',
    },
    ask_about: {
      label: 'Ask agent about selection',
      semantics: {
        type: 'agent-message',
        template: 'About these rows from "{title}":\n{targets}',
      },
      targets: 'many',
    },
  },
  anchors: ['surface', 'row', 'cell', 'series-point'],
  digest: (data) => digestData(data),
  wide: true,
  shareable: true,
};
