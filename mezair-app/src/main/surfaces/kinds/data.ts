// Data surface handler (§8.8): data_show renders agent-supplied rows and an
// optional chart natively. CSV export runs in the renderer.
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';
import type {
  JsonSchema,
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../../shared/surfaces/types.js';
import {
  DATA_MAX_ROWS,
  DATA_MAX_COLUMNS,
  dataChartSchema,
  dataColumnSchema,
  dataSurfaceKind,
  parseRowAnchorId,
  validateDataSurface,
  type DataChartSpec,
  type DataColumn,
  type DataSurfaceData,
} from '../../../shared/surfaces/kinds/data.js';
import {
  AgentToolError,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { deliverSurfaceFeedback, publishSurface } from '../core.js';
import {
  actionError,
  actionOk,
  parseToolArgs,
  renderTemplate,
  requireTargets,
  surfaceToolResult,
} from './data/tool-kit.js';
import { normalizeRows } from './data/normalize.js';
import { staticChartSvg } from './data/static-chart.js';
import {
  SHARE_BASE_CSS,
  assertScriptFree,
  escapeHtml,
  htmlTable,
  wrapSnapshot,
} from './data/share-kit.js';

const KIND = 'data';
const SNAPSHOT_MAX_ROWS = 500;

const dataShowInput: JsonSchema = {
  type: 'object',
  required: ['title', 'columns', 'rows'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 300 },
    columns: {
      type: 'array',
      maxItems: DATA_MAX_COLUMNS,
      items: dataColumnSchema,
      description: 'Column definitions; row objects are keyed by column key.',
    },
    rows: {
      type: 'array',
      maxItems: DATA_MAX_ROWS,
      items: { type: 'object' },
      description: `Up to ${DATA_MAX_ROWS} row objects keyed by column key.`,
    },
    chart: {
      ...dataChartSchema,
      description: 'Optional chart: x is a column key, y lists numeric column keys (series).',
    },
    note: { type: 'string', maxLength: 4000, description: 'Short caveat or source note.' },
  },
  additionalProperties: false,
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'data_show',
    title: 'Show data',
    description:
      'Show a table (and optional bar/line/area/scatter/stacked-bar chart) natively, with sort, filter and CSV export. Use instead of a markdown table or a sketch whenever the visual is just data.',
    inputSchema: dataShowInput,
  },
];

function dataShowTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{
    title: string;
    columns: DataColumn[];
    rows: unknown[];
    chart?: DataChartSpec;
    note?: string;
  }>(dataShowInput, args);
  const data: DataSurfaceData = {
    columns: input.columns,
    rows: normalizeRows(input.rows, input.columns),
    ...(input.chart ? { chart: input.chart } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const problems = validateDataSurface(data);
  if (problems.length > 0) {
    throw new AgentToolError(`Invalid data: ${problems.slice(0, 5).join(' ')}`, 'invalid-params');
  }
  const intent = publishSurface<DataSurfaceData>(ctx, {
    surfaceKind: KIND,
    title: input.title,
    data,
  });
  return surfaceToolResult(intent);
}

export function describeRowsForAgent(data: DataSurfaceData, rowIndexes: readonly number[]): string {
  return rowIndexes
    .map((index) => {
      const row = data.rows[index];
      if (!row) return null;
      return `- r${index}: ${data.columns
        .map(
          (column) => `${column.label}=${row[column.key] === null ? '' : String(row[column.key])}`,
        )
        .join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
}

async function executeDataAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  if (request.action === 'export_csv') {
    return actionOk('CSV export runs in the app window.');
  }
  if (request.action !== 'ask_about') return actionError(`Unknown data action: ${request.action}`);
  const data = ctx.intent.payload.data as DataSurfaceData;
  const indexes = Array.from(
    new Set(
      requireTargets(request.targetIds)
        .map(parseRowAnchorId)
        .filter((index): index is number => index !== null && index < data.rows.length),
    ),
  ).slice(0, 50);
  if (indexes.length === 0) return actionError('Select at least one row.');
  const semantics = dataSurfaceKind.actions.ask_about.semantics;
  const template = semantics.type === 'agent-message' ? semantics.template : '{targets}';
  const message = [
    renderTemplate(template, {
      title: ctx.intent.payload.title,
      targets: describeRowsForAgent(data, indexes),
    }),
    `(Data surface ${ctx.intent.id}.)`,
    request.note ? `User note: ${request.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const delivered = await deliverSurfaceFeedback(ctx.intent.id, message);
  return delivered
    ? actionOk('Sent to the agent.')
    : actionError('No live agent session for this thread. Reopen the thread and try again.');
}

export function dataSnapshot(data: DataSurfaceData, title: string) {
  const rows = data.rows.slice(0, SNAPSHOT_MAX_ROWS);
  const table = htmlTable(
    data.columns.map((column) => ({
      label: column.label,
      numeric: column.type === 'number',
      cell: (row: DataSurfaceData['rows'][number]) => escapeHtml(row[column.key] ?? ''),
    })),
    rows,
  );
  const omitted =
    data.rows.length > rows.length
      ? `<p class="muted">${data.rows.length - rows.length} more rows not included.</p>`
      : '';
  const meta = `${data.rows.length} rows · ${data.columns.length} columns`;
  const html = wrapSnapshot(
    title,
    meta,
    `${data.note ? `<p>${escapeHtml(data.note)}</p>` : ''}${staticChartSvg(data, title)}${table}${omitted}`,
  );
  assertScriptFree(html);
  return { html, css: SHARE_BASE_CSS };
}

export const dataSurfaceHandler: MainSurfaceHandler = {
  kind: KIND,
  toolProvider: {
    id: 'surface:data',
    tools: () => TOOLS,
    async call(ctx, name, args) {
      if (name === 'data_show') return dataShowTool(ctx, args);
      return undefined;
    },
  },
  executeAction: executeDataAction,
  share: {
    // Agent-supplied values; the share pipeline's secret scan covers them.
    redact: (data) => data,
    snapshot: (data, title) => dataSnapshot(data as DataSurfaceData, title),
  },
};
