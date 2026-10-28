// Diagram surface handler (§8.7): the agent authors Mermaid or draw.io with
// skill guidance (mezair_skill_get "diagram-generate" / "diagram-iterate"),
// diagram_show publishes it, diagram_update revises it in place. Saving to
// the repo is a user action (mutation), never an agent tool.
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';
import type {
  JsonSchema,
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../../shared/surfaces/types.js';
import {
  DIAGRAM_FORMATS,
  DIAGRAM_MAX_DESCRIPTION,
  DIAGRAM_MAX_SOURCE,
  describeDiagramFormat,
  diagramSurfaceKind,
  type DiagramFormat,
  type DiagramSurfaceData,
} from '../../../shared/surfaces/kinds/diagram.js';
import {
  AgentToolError,
  assertRepoInScope,
  textResult,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import {
  deliverSurfaceFeedback,
  patchSurface,
  publishSurface,
  requireSurfaceInScope,
} from '../core.js';
import { openInDrawio, checkDrawioAvailability } from '../../services/drawio-mcp.service.js';
import { threadRepoId } from '../../services/chat-sketch.service.js';
import {
  actionError,
  actionOk,
  errorMessage,
  getRepoRecord,
  parseToolArgs,
  renderTemplate,
  requireTargets,
  surfaceToolResult,
} from './data/tool-kit.js';
import { prepareDiagramSource, slugifyTitle } from './diagram/prepare.js';
import { listRepoDiagrams, readRepoDiagram, saveRepoDiagram } from './diagram/files.js';
import { diagramSnapshot, redactDiagram, type DiagramSnapshotOptions } from './diagram/snapshot.js';

const KIND = 'diagram';
const MAX_READ_CHARS = 60_000;

export function diagramKey(threadId: string, title: string): string {
  return `diagram:${threadId}:${slugifyTitle(title)}`;
}

const showInput: JsonSchema = {
  type: 'object',
  required: ['title', 'format', 'source'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    format: {
      type: 'string',
      enum: DIAGRAM_FORMATS,
      description:
        '"mermaid" for Mermaid text, "drawio" for draw.io XML (<mxfile> or <mxGraphModel>).',
    },
    source: {
      type: 'string',
      minLength: 1,
      maxLength: DIAGRAM_MAX_SOURCE,
      description: 'Mermaid source (first line names the diagram type) or draw.io XML.',
    },
    description: {
      type: 'string',
      maxLength: DIAGRAM_MAX_DESCRIPTION,
      description: 'One or two sentences on what the diagram shows.',
    },
    repoId: {
      type: 'string',
      description: 'Repository the diagram is about; Save to repo writes to its docs/diagrams/.',
    },
  },
  additionalProperties: false,
};

const updateInput: JsonSchema = {
  type: 'object',
  required: ['surfaceId', 'baseRevision', 'source'],
  properties: {
    surfaceId: { type: 'string', minLength: 1 },
    baseRevision: { type: 'integer', minimum: 1 },
    source: { type: 'string', minLength: 1, maxLength: DIAGRAM_MAX_SOURCE },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: DIAGRAM_MAX_DESCRIPTION },
  },
  additionalProperties: false,
};

const listInput: JsonSchema = {
  type: 'object',
  required: ['repoId'],
  properties: { repoId: { type: 'string', description: 'Repository id from this session.' } },
  additionalProperties: false,
};

const readInput: JsonSchema = {
  type: 'object',
  required: ['repoId', 'filename'],
  properties: {
    repoId: { type: 'string', description: 'Repository id from this session.' },
    filename: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'File name from diagram_list, e.g. "auth-flow.drawio" or "auth-flow.mmd".',
    },
  },
  additionalProperties: false,
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'diagram_show',
    title: 'Show a diagram',
    description:
      'Show a Mermaid or draw.io diagram inline as a Diagram surface. Fetch the style guide first with mezair_skill_get("diagram-generate") (and "diagram-iterate" when revising). Showing again with the same title replaces the earlier one. The user can save it to the repo, open it in draw.io, or comment on nodes and regions. Returns a digest and surfaceId.',
    inputSchema: showInput,
    feature: 'diagrams',
  },
  {
    name: 'diagram_update',
    title: 'Update a diagram',
    description:
      'Replace the source of a Diagram surface you showed (same format). Pass the current revision as baseRevision; a stale revision is a conflict, so re-read with surface_read and retry.',
    inputSchema: updateInput,
    feature: 'diagrams',
  },
  {
    name: 'diagram_list',
    title: 'List repo diagrams',
    description:
      'List diagrams saved in a repository’s docs/diagrams/ folder (draw.io .drawio and Mermaid .mmd files).',
    inputSchema: listInput,
    feature: 'diagrams',
    requiresThread: false,
  },
  {
    name: 'diagram_read',
    title: 'Read a repo diagram',
    description:
      'Read one diagram file from a repository’s docs/diagrams/ folder. Use diagram_show to display or revise it.',
    inputSchema: readInput,
    feature: 'diagrams',
    requiresThread: false,
  },
];

function threadIdOf(ctx: AgentToolSessionContext): string {
  if (!ctx.appThreadId) {
    throw new AgentToolError('Diagrams need a saved chat thread.', 'unavailable');
  }
  return ctx.appThreadId;
}

function noteFor(notes: string[], nodes: number, format: DiagramFormat): string | undefined {
  const lines = [...notes];
  if (nodes === 0 && format === 'mermaid') {
    lines.push('No node ids were extracted (only flowcharts and sequence participants are read).');
  }
  return lines.length ? lines.join('\n') : undefined;
}

function diagramShowTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{
    title: string;
    format: DiagramFormat;
    source: string;
    description?: string;
    repoId?: string;
  }>(showInput, args);
  const threadId = threadIdOf(ctx);
  const repoId = input.repoId === undefined ? undefined : assertRepoInScope(ctx, input.repoId);
  const title = input.title.trim();
  if (!title) throw new AgentToolError('A title is required.', 'invalid-params');
  const prepared = prepareDiagramSource(input.format, input.source);
  const description = input.description?.trim();
  const data: DiagramSurfaceData = {
    format: input.format,
    source: prepared.source,
    title,
    ...(description ? { description } : {}),
    ...(repoId ? { repoId } : {}),
    ...(prepared.nodes.length ? { nodes: prepared.nodes } : {}),
  };
  const intent = publishSurface<DiagramSurfaceData>(ctx, {
    surfaceKind: KIND,
    title,
    key: diagramKey(threadId, title),
    data,
  });
  return surfaceToolResult(
    intent,
    {},
    noteFor(prepared.notes, prepared.nodes.length, input.format),
  );
}

function diagramUpdateTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{
    surfaceId: string;
    baseRevision: number;
    source: string;
    title?: string;
    description?: string;
  }>(updateInput, args);
  const current = requireSurfaceInScope(ctx, input.surfaceId);
  if (current.payload.surfaceKind !== KIND) {
    throw new AgentToolError('Surface is not a Diagram.', 'invalid-params');
  }
  const format = (current.payload.data as DiagramSurfaceData).format;
  const prepared = prepareDiagramSource(format, input.source);
  const title = input.title?.trim() || undefined;
  const intent = patchSurface<DiagramSurfaceData>(
    current.id,
    input.baseRevision,
    (data) => {
      const next: DiagramSurfaceData = { ...data, source: prepared.source };
      if (title) next.title = title;
      if (input.description !== undefined) {
        const description = input.description.trim();
        if (description) next.description = description;
        else delete next.description;
      }
      if (prepared.nodes.length) next.nodes = prepared.nodes;
      else delete next.nodes;
      return next;
    },
    title ? { title } : undefined,
  );
  return surfaceToolResult(intent, {}, noteFor(prepared.notes, prepared.nodes.length, format));
}

function formatTime(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

function diagramListTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string }>(listInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const entries = listRepoDiagrams(repo.path);
  if (entries.length === 0) {
    return textResult(`No diagrams in ${repo.name}/docs/diagrams/.`, { diagrams: [] });
  }
  const lines = [
    `${entries.length} diagram${entries.length === 1 ? '' : 's'} in ${repo.name}/docs/diagrams/:`,
    ...entries.map(
      (entry) =>
        `- ${entry.filename} (${entry.format}, ${entry.bytes} bytes, modified ${formatTime(entry.mtime)})`,
    ),
  ];
  return textResult(lines.join('\n'), {
    diagrams: entries.map(({ filename, format, mtime }) => ({ filename, format, mtime })),
  });
}

function diagramReadTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string; filename: string }>(readInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const file = readRepoDiagram(repo.path, input.filename);
  if (!file) {
    throw new AgentToolError(
      `No diagram "${input.filename}" in ${repo.name}/docs/diagrams/ (use a .drawio or .mmd file name from diagram_list).`,
      'not-found',
    );
  }
  const text =
    file.source.length > MAX_READ_CHARS
      ? `${file.source.slice(0, MAX_READ_CHARS)}\n… truncated (${file.source.length} characters).`
      : file.source;
  return textResult(`docs/diagrams/${file.filename} (${file.format})\n${text}`, {
    filename: file.filename,
    format: file.format,
    length: file.source.length,
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function resolveSaveRepo(ctx: SurfaceActionContext, data: DiagramSurfaceData): string | null {
  // payload.repoId was checked against the session scope when published.
  return data.repoId ?? threadRepoId(ctx.intent.scope.threadId);
}

async function saveToRepo(
  ctx: SurfaceActionContext,
  data: DiagramSurfaceData,
): Promise<SurfaceActionResult> {
  const repoId = resolveSaveRepo(ctx, data);
  if (!repoId) return actionError('Attach a repository to this thread first.');
  const repo = (() => {
    try {
      return getRepoRecord(repoId);
    } catch {
      return null;
    }
  })();
  if (!repo) return actionError('The repository for this diagram is no longer available.');
  const savedPath = saveRepoDiagram(repo.path, {
    format: data.format,
    title: data.title || ctx.intent.payload.title,
    source: data.source,
    savedPath: data.savedPath,
  });
  patchSurface<DiagramSurfaceData>(ctx.intent.id, undefined, (current) => ({
    ...current,
    savedPath,
    repoId: current.repoId ?? repo.id,
  }));
  return actionOk(`Saved to ${repo.name}/${savedPath}`);
}

async function openDrawio(data: DiagramSurfaceData): Promise<SurfaceActionResult> {
  if (data.format !== 'drawio') {
    return actionError(
      'Open in draw.io works for draw.io diagrams. Ask the agent for a draw.io version, or save the Mermaid source to the repo.',
    );
  }
  try {
    const desktop = await checkDrawioAvailability();
    await openInDrawio(data.source);
    return actionOk(
      desktop
        ? 'Opened in draw.io.'
        : 'Opened in the draw.io web editor (the draw.io desktop tooling is not available).',
    );
  } catch (error) {
    return actionError(`Could not open draw.io: ${errorMessage(error)}`);
  }
}

export function describeReviseRequest(
  intentId: string,
  revision: number,
  data: DiagramSurfaceData,
  targetIds: readonly string[],
  note: string | undefined,
): string {
  const labels = new Map((data.nodes ?? []).map((node) => [node.id, node.label]));
  const targets = targetIds.length
    ? `Focus on: ${targetIds.map((id) => `"${labels.get(id) ?? id}" [${id}]`).join(', ')}`
    : '';
  const semantics = diagramSurfaceKind.actions.ask_revise.semantics;
  const template = semantics.type === 'agent-message' ? semantics.template : '{targets}';
  return [
    renderTemplate(template, { title: data.title, targets }).trim(),
    `Format: ${describeDiagramFormat(data)}.${data.savedPath ? ` Saved at ${data.savedPath}.` : ''}`,
    note ? `User note: ${note}` : '',
    `(Diagram surface ${intentId}; call diagram_update({surfaceId: "${intentId}", baseRevision: ${revision}, source}) with the revised source.)`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function executeDiagramAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  const data = ctx.intent.payload.data as DiagramSurfaceData;
  try {
    switch (request.action) {
      case 'save_to_repo':
        return await saveToRepo(ctx, data);
      case 'open_drawio':
        return await openDrawio(data);
      case 'ask_revise': {
        const message = describeReviseRequest(
          ctx.intent.id,
          ctx.intent.revision,
          data,
          requireTargets(request.targetIds),
          request.note,
        );
        const delivered = await deliverSurfaceFeedback(ctx.intent.id, message);
        return delivered
          ? actionOk('Asked the agent to revise the diagram.')
          : actionError('No live agent session for this thread. Reopen the thread and try again.');
      }
      default:
        return actionError(`Unknown diagram action: ${request.action}`);
    }
  } catch (error) {
    return actionError(errorMessage(error));
  }
}

export const diagramSurfaceHandler: MainSurfaceHandler = {
  kind: KIND,
  toolProvider: {
    id: 'surface:diagram',
    tools: () => TOOLS,
    async call(ctx, name, args) {
      switch (name) {
        case 'diagram_show':
          return diagramShowTool(ctx, args);
        case 'diagram_update':
          return diagramUpdateTool(ctx, args);
        case 'diagram_list':
          return diagramListTool(ctx, args);
        case 'diagram_read':
          return diagramReadTool(ctx, args);
        default:
          return undefined;
      }
    },
  },
  executeAction: executeDiagramAction,
  share: {
    redact: (data) => redactDiagram(data as DiagramSurfaceData),
    // `options` may carry the renderer's pre-rendered Mermaid SVG (diagramSvg)
    // once the share pipeline forwards it to surface snapshots.
    snapshot: (data, title, options) =>
      diagramSnapshot(data as DiagramSurfaceData, title, options as DiagramSnapshotOptions),
  },
};
