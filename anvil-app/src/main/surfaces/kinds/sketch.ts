import type { ChatArtifact } from '../../../shared/types.js';
import type { SketchSurfacePayload } from '../../../shared/surfaces/kinds/sketch.js';
import {
  buildSketchDocument,
  DEFAULT_SKETCH_TOKENS,
} from '../../../shared/surfaces/sketch-runtime.js';
import {
  AgentToolError,
  textResult,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { listAgentUISurfaces } from '../../services/agent-ui-intent.service.js';
import {
  createChatSketch,
  getChatSketch,
  keepChatSketch,
  MAX_SKETCH_HTML_BYTES,
  updateChatSketch,
} from '../../services/chat-sketch.service.js';
import {
  createToolProvider,
  patchSurface,
  publishSurface,
  requireSurfaceInScope,
  surfaceResult,
} from '../core.js';
import { renderOffscreen } from '../offscreen.js';
import type { MainSurfaceHandler } from '../types.js';
import { resolveArtifactRepoId } from './artifact.js';

/** Reply column width used for the first-paint height measurement and snapshots. */
export const SKETCH_MEASURE_WIDTH = 728;

function sketchDocument(html: string): string {
  return buildSketchDocument(html, { tokens: DEFAULT_SKETCH_TOKENS.dark, mode: 'share' });
}

/** Best-effort height at the reply width; undefined when offscreen rendering is unavailable. */
async function measureSketch(html: string): Promise<number | undefined> {
  try {
    const { height } = await renderOffscreen(sketchDocument(html), { width: SKETCH_MEASURE_WIDTH });
    return height > 0 ? Math.min(height, 20_000) : undefined;
  } catch {
    return undefined;
  }
}

function assertHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) {
    throw new AgentToolError('html is required.', 'invalid-params');
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_SKETCH_HTML_BYTES) {
    throw new AgentToolError(
      'Sketch HTML is too large (1.5 MB maximum). Use artifact_create for large documents.',
      'invalid-params',
    );
  }
  return html;
}

function requireSketchSurface(ctx: AgentToolSessionContext, surfaceId: unknown) {
  const intent = requireSurfaceInScope(ctx, surfaceId);
  if (intent.payload.surfaceKind !== 'sketch') {
    throw new AgentToolError('That surface is not a sketch.', 'invalid-params');
  }
  const data = intent.payload.data as SketchSurfacePayload;
  const sketch = getChatSketch(data.sketchId);
  if (!sketch) throw new AgentToolError('The sketch behind this surface is gone.', 'not-found');
  return { intent, sketch, data };
}

/** Keeps a sketch as an HTML artifact and marks every surface showing it. */
export function keepSketchAndNotify(
  sketchId: string,
  options: { title?: string; path?: string; repoId?: string | null } = {},
): ChatArtifact {
  const sketch = getChatSketch(sketchId);
  if (!sketch) throw new Error(`Sketch not found: ${sketchId}`);
  const artifact = keepChatSketch(sketchId, options);
  for (const intent of listAgentUISurfaces(sketch.threadId, {
    surfaceKind: 'sketch',
    includeSuperseded: true,
  })) {
    if ((intent.payload.data as SketchSurfacePayload).sketchId !== sketchId) continue;
    patchSurface<SketchSurfacePayload>(intent.id, undefined, (data) => ({
      ...data,
      keptArtifactId: artifact.id,
    }));
  }
  return artifact;
}

const sketchToolProvider = createToolProvider('sketch', [
  {
    tool: {
      name: 'sketch_show',
      title: 'Show sketch',
      description:
        'Show a throwaway, interactive HTML visual inline in your reply (comparison, mockup, explanatory diagram, quick dashboard). Sandboxed, no network, themed with --anvil-* tokens. Not versioned and not in the Library; use artifact_create for anything the user will keep. Returns {surfaceId, measuredHeight}; the HTML is never echoed back.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          html: { type: 'string', minLength: 1 },
          height: {
            type: 'integer',
            minimum: 40,
            maximum: 20_000,
            description: 'Initial height hint in px; the frame then sizes to content.',
          },
        },
        required: ['title', 'html'],
        additionalProperties: false,
      },
    },
    handler: async (ctx, args) => {
      const html = assertHtml(args.html);
      const measured = await measureSketch(html);
      const height = measured ?? (typeof args.height === 'number' ? args.height : undefined);
      const sketch = createChatSketch({
        threadId: ctx.appThreadId as string,
        title: String(args.title),
        html,
        height,
      });
      const intent = publishSurface<SketchSurfacePayload>(ctx, {
        surfaceKind: 'sketch',
        title: sketch.title,
        data: {
          sketchId: sketch.id,
          title: sketch.title.slice(0, 300),
          ...(sketch.height ? { height: sketch.height } : {}),
        },
      });
      return surfaceResult(intent, { sketchId: sketch.id, measuredHeight: measured ?? null });
    },
  },
  {
    tool: {
      name: 'sketch_update',
      title: 'Update sketch',
      description:
        'Replace a sketch’s HTML in place (no version history; the turn shows the latest).',
      inputSchema: {
        type: 'object',
        properties: {
          surfaceId: { type: 'string', minLength: 1 },
          html: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
        },
        required: ['surfaceId', 'html'],
        additionalProperties: false,
      },
    },
    handler: async (ctx, args) => {
      const { intent, sketch } = requireSketchSurface(ctx, args.surfaceId);
      const html = assertHtml(args.html);
      const measured = await measureSketch(html);
      const title = typeof args.title === 'string' ? args.title : undefined;
      const updated = updateChatSketch(sketch.id, {
        html,
        ...(title ? { title } : {}),
        ...(measured ? { height: measured } : {}),
      });
      const patched = patchSurface<SketchSurfacePayload>(
        intent.id,
        undefined,
        (data) => ({
          ...data,
          title: updated.title.slice(0, 300),
          ...(updated.height ? { height: updated.height } : {}),
        }),
        title ? { title: updated.title } : undefined,
      );
      return surfaceResult(patched, { sketchId: sketch.id, measuredHeight: measured ?? null });
    },
  },
  {
    tool: {
      name: 'sketch_keep',
      title: 'Keep sketch as artifact',
      description:
        'Promote a sketch to a durable HTML artifact (v1) when it turned out to be worth keeping. Returns {artifactId, version}.',
      inputSchema: {
        type: 'object',
        properties: {
          surfaceId: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          path: { type: 'string', maxLength: 500 },
        },
        required: ['surfaceId'],
        additionalProperties: false,
      },
    },
    handler: (ctx, args) => {
      const { sketch } = requireSketchSurface(ctx, args.surfaceId);
      const artifact = keepSketchAndNotify(sketch.id, {
        title: typeof args.title === 'string' ? args.title : undefined,
        path: typeof args.path === 'string' ? args.path : undefined,
        repoId: resolveArtifactRepoId(ctx),
      });
      return textResult(
        `Kept as artifact "${artifact.title}" v${artifact.version} (${artifact.storage}: ${artifact.relativePath}).`,
        { artifactId: artifact.id, version: artifact.version },
      );
    },
  },
  {
    tool: {
      name: 'sketch_snapshot',
      title: 'Snapshot sketch',
      description:
        'Render a sketch offscreen at the reply width and return a screenshot so you can check your work before replying.',
      inputSchema: {
        type: 'object',
        properties: { surfaceId: { type: 'string', minLength: 1 } },
        required: ['surfaceId'],
        additionalProperties: false,
      },
    },
    handler: async (ctx, args) => {
      const { sketch } = requireSketchSurface(ctx, args.surfaceId);
      let rendered: Awaited<ReturnType<typeof renderOffscreen>>;
      try {
        rendered = await renderOffscreen(sketchDocument(sketch.html), {
          width: SKETCH_MEASURE_WIDTH,
          screenshot: true,
        });
      } catch (error) {
        throw new AgentToolError(
          `Could not render the sketch: ${error instanceof Error ? error.message : String(error)}`,
          'unavailable',
        );
      }
      const summary = `Rendered at ${SKETCH_MEASURE_WIDTH}px wide, ${rendered.height}px tall.`;
      return {
        content: [
          ...(rendered.png
            ? [{ type: 'image' as const, data: rendered.png, mimeType: 'image/png' }]
            : []),
          { type: 'text', text: rendered.png ? summary : `${summary} No screenshot was captured.` },
        ],
        structuredContent: { measuredHeight: rendered.height },
      };
    },
  },
]);

export const sketchSurfaceHandler: MainSurfaceHandler = {
  kind: 'sketch',
  toolProvider: sketchToolProvider,
  async executeAction(ctx, request) {
    if (request.action !== 'keep')
      return { ok: false, error: `Unknown action: ${request.action}.` };
    const data = ctx.intent.payload.data as SketchSurfacePayload;
    const artifact = keepSketchAndNotify(data.sketchId);
    return { ok: true, message: `Kept as artifact "${artifact.title}" v${artifact.version}.` };
  },
};
