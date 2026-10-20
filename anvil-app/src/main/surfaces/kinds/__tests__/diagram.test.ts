import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagramSurfaceKind,
  digestDiagram,
  type DiagramSurfaceData,
} from '../../../../shared/surfaces/kinds/diagram.js';
import {
  extractMermaidNodes,
  mermaidDiagramType,
  normaliseMermaidSource,
  validateMermaidSource,
} from '../../../../shared/surfaces/kinds/diagram/mermaid.js';
import {
  extractDrawioNodes,
  parseDrawio,
  validateDrawioSource,
} from '../../../../shared/surfaces/kinds/diagram/drawio.js';
import type { AgentToolSessionContext } from '../../../agent-tools/dispatch.js';
import { validateJsonSchema } from '../../validate.js';
import { fakeCoreState, getSurface, resetFakeCore, testContext, textOf } from './data-fake-core.js';

const mocks = vi.hoisted(() => ({
  repoPath: '',
  threadRepo: 'repo-1' as string | null,
  drawioAvailable: false,
  opened: [] as string[],
  openError: null as Error | null,
}));

vi.mock('../../core.js', async () => {
  const fake = await import('./data-fake-core.js');
  const { AgentToolError } = await import('../../../agent-tools/dispatch.js');
  return {
    ...fake,
    requireSurfaceInScope: (ctx: AgentToolSessionContext, surfaceId: unknown) => {
      const intent = fake.getSurface(String(surfaceId));
      if (!intent) throw new AgentToolError(`Surface not found: ${String(surfaceId)}`, 'not-found');
      if (intent.scope.threadId !== ctx.appThreadId) {
        throw new AgentToolError('Surface belongs to another thread.', 'forbidden');
      }
      return intent;
    },
  };
});
vi.mock('../../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (repoId: string) =>
        repoId === 'repo-1' ? { id: 'repo-1', name: 'web-app', path: mocks.repoPath } : undefined,
    }),
  }),
}));
vi.mock('../../../services/chat-sketch.service.js', () => ({
  threadRepoId: () => mocks.threadRepo,
}));
vi.mock('../../../services/drawio-mcp.service.js', () => ({
  checkDrawioAvailability: async () => mocks.drawioAvailable,
  openInDrawio: async (xml: string) => {
    if (mocks.openError) throw mocks.openError;
    mocks.opened.push(xml);
  },
}));
// In-memory-free stand-in for diagram-file.service (the real one pulls in the LLM stack).
vi.mock('../../../services/diagram-file.service.js', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = (repoPath: string) => path.join(repoPath, 'docs/diagrams');
  return {
    listDiagramFiles: (repoPath: string) =>
      fs.existsSync(dir(repoPath))
        ? fs
            .readdirSync(dir(repoPath))
            .filter((file) => file.endsWith('.drawio'))
            .map((filename) => ({
              filename,
              title: filename.replace(/\.drawio$/, ''),
              xml: fs.readFileSync(path.join(dir(repoPath), filename), 'utf-8'),
              mtime: fs.statSync(path.join(dir(repoPath), filename)).mtimeMs,
            }))
        : [],
    readDiagramFile: (repoPath: string, filename: string) => {
      const file = path.join(dir(repoPath), filename);
      if (!fs.existsSync(file)) return null;
      return { filename, title: filename, xml: fs.readFileSync(file, 'utf-8'), mtime: 0 };
    },
    writeDiagramFile: (repoPath: string, filename: string, xml: string) => {
      fs.mkdirSync(dir(repoPath), { recursive: true });
      fs.writeFileSync(path.join(dir(repoPath), filename), xml, 'utf-8');
    },
    sanitizeFilename: (title: string) =>
      title
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'untitled',
    resolveFilenameConflict: (repoPath: string, filename: string) => {
      if (!fs.existsSync(path.join(dir(repoPath), filename))) return filename;
      const base = filename.replace(/\.drawio$/, '');
      let counter = 1;
      while (fs.existsSync(path.join(dir(repoPath), `${base}-${counter}.drawio`))) counter += 1;
      return `${base}-${counter}.drawio`;
    },
  };
});

const { diagramSurfaceHandler, diagramKey, describeReviseRequest } = await import('../diagram.js');
const { prepareDiagramSource, inflateDrawioPages } = await import('../diagram/prepare.js');
const { diagramSnapshot, redactDiagram } = await import('../diagram/snapshot.js');
const { safeDiagramFilename } = await import('../diagram/files.js');

const FLOWCHART = `flowchart TD
  %% comment
  A[Client] -->|HTTPS| B(API gateway)
  B --> C{Authorised?}
  C -- yes --> D[(Users DB)]
  C -->|no| E>Reject]
  D & E --> F
  classDef hot fill:#f00
  class A hot
`;

const DRAWIO = `<mxfile host="app.diagrams.net"><diagram name="Overview" id="p1"><mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="api" value="API &amp;amp; auth" style="rounded=1;whiteSpace=wrap;" vertex="1" parent="1">
    <mxGeometry x="100" y="40" width="120" height="60" as="geometry"/>
  </mxCell>
  <mxCell id="db" value="&lt;b&gt;Users&lt;/b&gt;&lt;br&gt;DB" style="shape=cylinder3;html=1;" vertex="1" parent="1">
    <mxGeometry x="320" y="40" width="80" height="80" as="geometry"/>
  </mxCell>
  <UserObject label="Worker" id="worker"><mxCell style="ellipse;" vertex="1" parent="1"><mxGeometry x="100" y="200" width="80" height="80" as="geometry"/></mxCell></UserObject>
  <mxCell id="e1" value="SQL" style="edgeStyle=orthogonalEdgeStyle;dashed=1;" edge="1" parent="1" source="api" target="db">
    <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="260" y="70"/></Array></mxGeometry>
  </mxCell>
  <mxCell id="e2" edge="1" parent="1" source="api" target="worker"><mxGeometry relative="1" as="geometry"/></mxCell>
  <mxCell id="e2l" value="jobs" style="edgeLabel;" vertex="1" connectable="0" parent="e2"><mxGeometry x="-0.2" relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

function ctx(overrides: Partial<AgentToolSessionContext> = {}): AgentToolSessionContext {
  return testContext({ features: ['diagrams'], ...overrides });
}

async function call(name: string, args: Record<string, unknown>, context = ctx()) {
  return diagramSurfaceHandler.toolProvider!.call(context, name, args);
}

async function show(args: Partial<Record<string, unknown>> = {}) {
  const result = await call('diagram_show', {
    title: 'Auth flow',
    format: 'mermaid',
    source: FLOWCHART,
    repoId: 'repo-1',
    ...args,
  });
  const surfaceId = String(result?.structuredContent?.surfaceId);
  return { result, surfaceId, intent: getSurface(surfaceId)! };
}

function action(
  surfaceId: string,
  name: string,
  extra: { targetIds?: string[]; note?: string } = {},
) {
  const intent = getSurface(surfaceId)!;
  return diagramSurfaceHandler.executeAction!({ intent }, { surfaceId, action: name, ...extra });
}

beforeEach(() => {
  resetFakeCore();
  mocks.repoPath = mkdtempSync(join(tmpdir(), 'anvil-diagram-'));
  mocks.threadRepo = 'repo-1';
  mocks.drawioAvailable = false;
  mocks.opened = [];
  mocks.openError = null;
});

afterEach(() => {
  rmSync(mocks.repoPath, { recursive: true, force: true });
});

describe('diagram kind definition', () => {
  const data: DiagramSurfaceData = {
    format: 'mermaid',
    source: FLOWCHART,
    title: 'Auth flow',
    nodes: [
      { id: 'A', label: 'Client' },
      { id: 'B', label: 'API gateway' },
    ],
  };

  it('validates payloads and rejects malformed ones', () => {
    expect(validateJsonSchema(diagramSurfaceKind.schema, data)).toEqual([]);
    expect(validateJsonSchema(diagramSurfaceKind.schema, { ...data, format: 'png' })).not.toEqual(
      [],
    );
    expect(validateJsonSchema(diagramSurfaceKind.schema, { format: 'mermaid' })).not.toEqual([]);
    expect(
      validateJsonSchema(diagramSurfaceKind.schema, { ...data, nodes: [{ id: 'x' }] }),
    ).not.toEqual([]);
    expect(validateJsonSchema(diagramSurfaceKind.schema, { ...data, extra: 1 })).not.toEqual([]);
  });

  it('declares actions with semantics, anchors and gating', () => {
    expect(diagramSurfaceKind.actions.save_to_repo.semantics.type).toBe('mutation');
    expect(diagramSurfaceKind.actions.open_drawio.semantics.type).toBe('anvil-command');
    expect(diagramSurfaceKind.actions.ask_revise.semantics.type).toBe('agent-message');
    expect(diagramSurfaceKind.anchors).toEqual(['surface', 'node', 'region']);
    expect(diagramSurfaceKind.feature).toBe('diagrams');
    expect(diagramSurfaceKind.shareable).toBe(true);
  });

  it('digests to a compact summary', () => {
    expect(digestDiagram(data).split('\n')[0]).toBe('Diagram (mermaid): Auth flow · 2 nodes');
    expect(digestDiagram({ ...data, nodes: undefined, savedPath: 'docs/diagrams/a.mmd' })).toBe(
      'Diagram (mermaid): Auth flow · saved to docs/diagrams/a.mmd',
    );
  });
});

describe('mermaid validation and nodes', () => {
  it('recognises the diagram type after front matter, comments and directives', () => {
    expect(
      mermaidDiagramType('---\ntitle: X\n---\n%%{init: {}}%%\nsequenceDiagram\nA->>B: hi'),
    ).toBe('sequenceDiagram');
    expect(mermaidDiagramType('graph LR; A-->B')).toBe('graph');
    expect(mermaidDiagramType('flowchat TD\nA-->B')).toBeNull();
  });

  it('strips a surrounding fence', () => {
    expect(normaliseMermaidSource('```mermaid\ngraph TD\nA-->B\n```')).toBe('graph TD\nA-->B');
  });

  it('reports plain-language problems', () => {
    expect(validateMermaidSource(FLOWCHART)).toEqual([]);
    expect(validateMermaidSource('graph LR; A-->B')).toEqual([]);
    expect(validateMermaidSource('')).toEqual(['Mermaid source is empty.']);
    expect(validateMermaidSource('A --> B')[0]).toMatch(/first line must name a Mermaid diagram/);
    expect(validateMermaidSource('flowchart TD')[0]).toMatch(/no content/);
  });

  it('extracts flowchart nodes with labels and bare ids', () => {
    expect(extractMermaidNodes(FLOWCHART)).toEqual([
      { id: 'A', label: 'Client' },
      { id: 'B', label: 'API gateway' },
      { id: 'C', label: 'Authorised?' },
      { id: 'D', label: 'Users DB' },
      { id: 'E', label: 'Reject' },
      { id: 'F', label: 'F' },
    ]);
    expect(extractMermaidNodes('graph LR; a1["Quoted <br/> label"]-->b2')).toEqual([
      { id: 'a1', label: 'Quoted label' },
      { id: 'b2', label: 'b2' },
    ]);
    expect(
      extractMermaidNodes('flowchart LR\n  foo-->bar\n  x@{ shape: rect, label: "Ex" }'),
    ).toEqual([
      { id: 'foo', label: 'foo' },
      { id: 'bar', label: 'bar' },
      { id: 'x', label: 'Ex' },
    ]);
  });

  it('extracts sequence participants and skips unsupported types', () => {
    expect(
      extractMermaidNodes('sequenceDiagram\nparticipant U as User\nactor S\nU->>S: go'),
    ).toEqual([
      { id: 'U', label: 'User' },
      { id: 'S', label: 'S' },
    ]);
    expect(extractMermaidNodes('pie\n"a": 1')).toEqual([]);
  });
});

describe('draw.io validation and parsing', () => {
  it('accepts well-formed documents', () => {
    expect(validateDrawioSource(DRAWIO)).toEqual([]);
    expect(
      validateDrawioSource(
        '<?xml version="1.0"?>\n<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>',
      ),
    ).toEqual([]);
  });

  it('rejects malformed or foreign XML', () => {
    expect(validateDrawioSource('<svg></svg>')[0]).toMatch(/root element/);
    expect(validateDrawioSource('<mxGraphModel><root></mxGraphModel>')[0]).toMatch(/Mismatched/);
    expect(validateDrawioSource('<mxGraphModel><root>')[0]).toMatch(/Unclosed/);
    expect(validateDrawioSource('<mxGraphModel/><extra/>')[0]).toMatch(/after the root/);
    expect(validateDrawioSource('<mxfile></mxfile>')[0]).toMatch(/diagram/);
    expect(validateDrawioSource('<!DOCTYPE x [<!ENTITY a "b">]><mxGraphModel/>')[0]).toMatch(
      /DOCTYPE|Malformed/,
    );
    expect(validateDrawioSource('<mxGraphModel><a b=c></a></mxGraphModel>')[0]).toMatch(
      /Malformed/,
    );
  });

  it('reads cells, wrappers, labels and geometry', () => {
    const parsed = parseDrawio(DRAWIO);
    expect(parsed.pageName).toBe('Overview');
    expect(parsed.compressed).toBe(false);
    const api = parsed.cells.find((cell) => cell.id === 'api')!;
    expect(api.label).toBe('API & auth');
    expect(api.geometry).toMatchObject({ x: 100, y: 40, width: 120, height: 60 });
    expect(parsed.cells.find((cell) => cell.id === 'db')!.label).toBe('Users\nDB');
    expect(parsed.cells.find((cell) => cell.id === 'e1')!.points).toEqual([{ x: 260, y: 70 }]);
    expect(extractDrawioNodes(parsed)).toEqual([
      { id: 'api', label: 'API & auth' },
      { id: 'db', label: 'Users DB' },
      { id: 'worker', label: 'Worker' },
    ]);
  });

  it('inflates compressed pages', () => {
    const model =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="n" value="Node" vertex="1" parent="0"><mxGeometry x="0" y="0" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>';
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(model))).toString('base64');
    const xml = `<mxfile><diagram id="a" name="P">${compressed}</diagram></mxfile>`;
    expect(parseDrawio(xml).compressed).toBe(true);
    const inflated = inflateDrawioPages(xml);
    expect(inflated).toContain('<mxGraphModel>');
    expect(prepareDiagramSource('drawio', xml).nodes).toEqual([{ id: 'n', label: 'Node' }]);
  });
});

describe('diagram tools', () => {
  it('diagram_show validates, extracts nodes and publishes keyed by thread and title', async () => {
    const { result, intent } = await show();
    const data = intent.payload.data as DiagramSurfaceData;
    expect(intent.payload.key).toBe(diagramKey('thread-1', 'Auth flow'));
    expect(intent.payload.key).toBe('diagram:thread-1:auth-flow');
    expect(data.nodes).toHaveLength(6);
    expect(data.repoId).toBe('repo-1');
    expect(textOf(result)).toContain('Diagram (mermaid): Auth flow · 6 nodes');
    expect(textOf(result)).not.toContain('flowchart TD');
  });

  it('later shows with the same title supersede earlier ones', async () => {
    const first = await show();
    await show({ source: 'graph LR\nA-->B' });
    expect(getSurface(first.surfaceId)!.payload.supersededBy).toBeTruthy();
  });

  it('rejects invalid sources and out-of-scope repos', async () => {
    await expect(show({ source: 'not a diagram' })).rejects.toThrow(/Invalid Mermaid/);
    await expect(show({ format: 'drawio', source: '<svg/>' })).rejects.toThrow(/Invalid draw.io/);
    await expect(show({ repoId: 'repo-x' })).rejects.toThrow(/outside/);
  });

  it('diagram_show accepts draw.io XML', async () => {
    const { intent, result } = await show({ format: 'drawio', source: DRAWIO, title: 'Infra' });
    expect((intent.payload.data as DiagramSurfaceData).nodes).toHaveLength(3);
    expect(textOf(result)).toContain('Diagram (drawio): Infra · 3 nodes');
  });

  it('diagram_update patches the source with a revision check', async () => {
    const { surfaceId } = await show();
    const updated = await call('diagram_update', {
      surfaceId,
      baseRevision: 1,
      source: 'graph LR\nX[New]-->Y',
      description: 'Simplified',
    });
    expect(updated?.structuredContent?.revision).toBe(2);
    const data = getSurface(surfaceId)!.payload.data as DiagramSurfaceData;
    expect(data.source).toBe('graph LR\nX[New]-->Y');
    expect(data.description).toBe('Simplified');
    expect(data.nodes).toEqual([
      { id: 'X', label: 'New' },
      { id: 'Y', label: 'Y' },
    ]);
    await expect(
      call('diagram_update', { surfaceId, baseRevision: 1, source: 'graph LR\nA-->B' }),
    ).rejects.toThrow(/Stale/);
    await expect(
      call('diagram_update', { surfaceId, baseRevision: 2, source: '<mxGraphModel/>' }),
    ).rejects.toThrow(/Invalid Mermaid/);
    await expect(
      call(
        'diagram_update',
        { surfaceId, baseRevision: 2, source: 'graph LR\nA-->B' },
        ctx({ appThreadId: 'thread-2' }),
      ),
    ).rejects.toThrow(/another thread/);
  });

  it('diagram_list and diagram_read use the repo diagrams folder', async () => {
    const dir = join(mocks.repoPath, 'docs/diagrams');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'infra.drawio'), DRAWIO);
    writeFileSync(join(dir, 'auth.mmd'), FLOWCHART);
    writeFileSync(join(dir, 'notes.txt'), 'ignore');
    const listed = await call('diagram_list', { repoId: 'repo-1' });
    expect(textOf(listed)).toContain('infra.drawio (drawio');
    expect(textOf(listed)).toContain('auth.mmd (mermaid');
    expect(textOf(listed)).not.toContain('notes.txt');
    const read = await call('diagram_read', { repoId: 'repo-1', filename: 'auth.mmd' });
    expect(textOf(read)).toContain('A[Client]');
    await expect(
      call('diagram_read', { repoId: 'repo-1', filename: '../secrets.mmd' }),
    ).rejects.toThrow(/No diagram/);
    await expect(call('diagram_list', { repoId: 'repo-x' })).rejects.toThrow(/outside/);
  });

  it('only allows plain diagram file names', () => {
    expect(safeDiagramFilename('a.drawio')).toBe('a.drawio');
    expect(safeDiagramFilename('sub/a.mmd')).toBeNull();
    expect(safeDiagramFilename('..mmd')).toBeNull();
    expect(safeDiagramFilename('a.txt')).toBeNull();
  });

  it('exposes no mutation tools', () => {
    const tools = diagramSurfaceHandler.toolProvider!.tools(ctx());
    expect(tools.map((tool) => tool.name)).toEqual([
      'diagram_show',
      'diagram_update',
      'diagram_list',
      'diagram_read',
    ]);
    expect(tools.some((tool) => tool.mutation)).toBe(false);
    expect(tools.every((tool) => tool.feature === 'diagrams')).toBe(true);
    expect(tools[0].description).toContain('anvil_skill_get("diagram-generate")');
  });
});

describe('diagram actions', () => {
  it('save_to_repo writes .mmd into docs/diagrams and records savedPath', async () => {
    const { surfaceId } = await show();
    const result = await action(surfaceId, 'save_to_repo');
    expect(result).toMatchObject({
      ok: true,
      message: 'Saved to web-app/docs/diagrams/auth-flow.mmd',
    });
    const file = join(mocks.repoPath, 'docs/diagrams/auth-flow.mmd');
    expect(readFileSync(file, 'utf-8')).toBe(`${normaliseMermaidSource(FLOWCHART)}\n`);
    const data = getSurface(surfaceId)!.payload.data as DiagramSurfaceData;
    expect(data.savedPath).toBe('docs/diagrams/auth-flow.mmd');
    expect(getSurface(surfaceId)!.payload.digest).toContain('saved to docs/diagrams/auth-flow.mmd');

    // Saving again overwrites the same file rather than creating a copy.
    await action(surfaceId, 'save_to_repo');
    expect(existsSync(join(mocks.repoPath, 'docs/diagrams/auth-flow-1.mmd'))).toBe(false);
  });

  it('save_to_repo avoids clobbering other files and falls back to the thread repo', async () => {
    mkdirSync(join(mocks.repoPath, 'docs/diagrams'), { recursive: true });
    writeFileSync(join(mocks.repoPath, 'docs/diagrams/infra.drawio'), 'existing');
    const { surfaceId } = await show({
      format: 'drawio',
      source: DRAWIO,
      title: 'Infra',
      repoId: undefined,
    });
    const result = await action(surfaceId, 'save_to_repo');
    expect(result.message).toBe('Saved to web-app/docs/diagrams/infra-1.drawio');
    expect(readFileSync(join(mocks.repoPath, 'docs/diagrams/infra.drawio'), 'utf-8')).toBe(
      'existing',
    );
    expect((getSurface(surfaceId)!.payload.data as DiagramSurfaceData).repoId).toBe('repo-1');
  });

  it('save_to_repo explains when there is no repository', async () => {
    mocks.threadRepo = null;
    const { surfaceId } = await show({ repoId: undefined });
    expect(await action(surfaceId, 'save_to_repo')).toMatchObject({
      ok: false,
      error: 'Attach a repository to this thread first.',
    });
  });

  it('open_drawio opens draw.io diagrams and is honest about Mermaid and failures', async () => {
    const mermaid = await show();
    expect((await action(mermaid.surfaceId, 'open_drawio')).ok).toBe(false);
    const drawio = await show({ format: 'drawio', source: DRAWIO, title: 'Infra' });
    const web = await action(drawio.surfaceId, 'open_drawio');
    expect(web).toMatchObject({ ok: true });
    expect(web.message).toMatch(/web editor/);
    expect(mocks.opened).toHaveLength(1);
    mocks.drawioAvailable = true;
    expect((await action(drawio.surfaceId, 'open_drawio')).message).toBe('Opened in draw.io.');
    mocks.openError = new Error('spawn npx ENOENT');
    expect(await action(drawio.surfaceId, 'open_drawio')).toMatchObject({
      ok: false,
      error: 'Could not open draw.io: spawn npx ENOENT',
    });
  });

  it('ask_revise sends targets and the note to the agent', async () => {
    const { surfaceId } = await show();
    const result = await action(surfaceId, 'ask_revise', { targetIds: ['B'], note: 'Add retries' });
    expect(result.ok).toBe(true);
    const message = fakeCoreState.delivered[0].message;
    expect(message).toContain('Please revise the diagram "Auth flow"');
    expect(message).toContain('"API gateway" [B]');
    expect(message).toContain('User note: Add retries');
    expect(message).toContain(`diagram_update({surfaceId: "${surfaceId}", baseRevision: 1`);
    fakeCoreState.deliverResult = false;
    expect((await action(surfaceId, 'ask_revise')).ok).toBe(false);
  });

  it('describes revise requests without targets', () => {
    const text = describeReviseRequest(
      's1',
      3,
      { format: 'drawio', source: DRAWIO, title: 'Infra', savedPath: 'docs/diagrams/infra.drawio' },
      [],
      undefined,
    );
    expect(text).toContain('Format: draw.io. Saved at docs/diagrams/infra.drawio.');
    expect(text).not.toContain('Focus on');
  });

  it('rejects unknown actions', async () => {
    const { surfaceId } = await show();
    expect((await action(surfaceId, 'explode')).ok).toBe(false);
  });
});

describe('diagram share snapshot', () => {
  const mermaid: DiagramSurfaceData = {
    format: 'mermaid',
    source: 'graph TD\nA["<script>alert(1)</script>"]-->B',
    title: 'Flow',
    repoId: 'repo-1',
    description: 'How it flows',
  };

  it('redacts the local repo id', () => {
    expect(redactDiagram(mermaid)).not.toHaveProperty('repoId');
    expect(diagramSurfaceHandler.share!.redact(mermaid)).not.toHaveProperty('repoId');
  });

  it('shows Mermaid source with a caption when no SVG is available', () => {
    const { html, css } = diagramSnapshot(mermaid, 'Flow');
    expect(html).toContain('No rendered image was available');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).toContain('How it flows');
    expect(css).toContain('prefers-color-scheme: dark');
  });

  it('embeds a sanitised pre-rendered SVG when provided', () => {
    const { html } = diagramSnapshot(mermaid, 'Flow', {
      diagramSvg:
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="javascript:x()"><text>A</text></a><image href="https://evil.test/x.png"/></svg>',
    });
    expect(html).toContain('<figure class="dg-figure"');
    expect(html).toContain('<text>A</text>');
    expect(html).not.toMatch(/<script|onload|javascript:|evil\.test/);
    expect(html).toContain('<summary>Mermaid source</summary>');
  });

  it('draws draw.io geometry as a static SVG plus the XML', () => {
    const { html } = diagramSnapshot({ format: 'drawio', source: DRAWIO, title: 'Infra' }, 'Infra');
    expect(html).toContain('Simplified drawing of the draw.io diagram');
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toContain('>API &amp; auth</text>');
    expect(html).toContain('<summary>draw.io XML</summary>');
    expect(html).not.toContain('<mxCell');
    expect(html).toContain('&lt;mxCell');
  });

  it('falls back to XML with a caption for compressed draw.io pages', () => {
    const { html } = diagramSnapshot(
      { format: 'drawio', source: '<mxfile><diagram id="a">abc=</diagram></mxfile>', title: 'X' },
      'X',
    );
    expect(html).toContain('Save it as a .drawio file');
  });
});
