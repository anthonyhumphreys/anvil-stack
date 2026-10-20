import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import type { DiagramSurfaceData } from '../../../../../../shared/surfaces/kinds/diagram';
import {
  buildDrawioSvgModel,
  clipToBox,
  drawioLabelBaselines,
  drawioNodeOutline,
  drawioShape,
  parseDrawio,
  wrapLabel,
} from '../../../../../../shared/surfaces/kinds/diagram/drawio';
import { DEFAULT_SKETCH_TOKENS } from '../../../../../../shared/surfaces/sketch-runtime';
import type { SurfaceViewProps } from '../../../types';
import { diagramSurfaceView } from '..';
import { DrawioSvg } from '../DrawioSvg';
import {
  drawioView,
  filterNodes,
  mermaidConfigForTokens,
  mermaidNodeIdFromElement,
  nodeAnchor,
  readDiagramData,
  regionAnchor,
  sizeMermaidSvg,
} from '../model';

const DRAWIO = `<mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="group" value="Backend" style="swimlane;" vertex="1" parent="1">
    <mxGeometry x="200" y="100" width="300" height="200" as="geometry"/>
  </mxCell>
  <mxCell id="svc" value="Service with a rather long label" style="rounded=1;" vertex="1" parent="group">
    <mxGeometry x="20" y="40" width="120" height="50" as="geometry"/>
  </mxCell>
  <mxCell id="db" value="DB" style="shape=cylinder3;" vertex="1" parent="1">
    <mxGeometry x="600" y="140" width="60" height="80" as="geometry"/>
  </mxCell>
  <mxCell id="ok" value="OK?" style="rhombus;" vertex="1" parent="1">
    <mxGeometry x="600" y="300" width="60" height="60" as="geometry"/>
  </mxCell>
  <mxCell id="e1" value="reads" style="endArrow=none;" edge="1" parent="1" source="svc" target="db">
    <mxGeometry relative="1" as="geometry"/>
  </mxCell>
  <mxCell id="e2" edge="1" parent="1" source="db">
    <mxGeometry relative="1" as="geometry">
      <mxPoint x="700" y="400" as="targetPoint"/>
    </mxGeometry>
  </mxCell>
</root></mxGraphModel>`;

function intent(data: DiagramSurfaceData): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 'thread-1' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'diagram',
      title: data.title,
      streaming: false,
      digest: 'Diagram',
      data,
    },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function props(data: DiagramSurfaceData, extra: Partial<SurfaceViewProps> = {}): SurfaceViewProps {
  return {
    intent: intent(data),
    presentation: 'inline',
    onAction: async () => ({ ok: true }),
    onComment: () => undefined,
    onOpenStage: () => undefined,
    ...extra,
  };
}

describe('draw.io geometry → SVG model', () => {
  const model = buildDrawioSvgModel(parseDrawio(DRAWIO));
  const byId = new Map(model.nodes.map((node) => [node.id, node]));

  it('resolves child geometry against its container and pads the drawing', () => {
    const group = byId.get('group')!;
    const svc = byId.get('svc')!;
    expect(group).toMatchObject({ x: 16, y: 16, shape: 'container' });
    expect(svc.x - group.x).toBe(20);
    expect(svc.y - group.y).toBe(40);
    expect(byId.get('db')!.shape).toBe('cylinder');
    expect(byId.get('ok')!.shape).toBe('diamond');
    expect(svc.shape).toBe('rounded');
    expect(model.width).toBeGreaterThan(460);
    expect(model.height).toBeGreaterThan(300);
  });

  it('clips connectors to the shape borders and keeps free ends', () => {
    const svc = byId.get('svc')!;
    const db = byId.get('db')!;
    const e1 = model.edges.find((edge) => edge.id === 'e1')!;
    expect(e1.points[0].x).toBeCloseTo(svc.x + svc.width);
    expect(e1.points[1].x).toBeCloseTo(db.x);
    expect(e1).toMatchObject({ label: 'reads', arrow: false, dashed: false });
    const e2 = model.edges.find((edge) => edge.id === 'e2')!;
    expect(e2.points).toHaveLength(2);
    expect(e2.arrow).toBe(true);
  });

  it('wraps labels to fit their shapes', () => {
    const svc = byId.get('svc')!;
    expect(svc.lines.length).toBeGreaterThan(1);
    expect(svc.lines.length).toBeLessThanOrEqual(3);
    expect(wrapLabel('one two three four', 8, 1)).toEqual(['one two…']);
    expect(wrapLabel('supercalifragilistic', 8, 5)).toEqual(['supercal', 'ifragili', 'stic']);
    expect(drawioLabelBaselines({ shape: 'rect', height: 40, lines: ['a'] })).toHaveLength(1);
  });

  it('maps styles to shapes and outlines', () => {
    expect(drawioShape('text;html=1;')).toBe('text');
    expect(drawioShape('ellipse;whiteSpace=wrap;')).toBe('ellipse');
    expect(drawioShape('shape=mxgraph.flowchart.database;')).toBe('cylinder');
    expect(drawioShape('whiteSpace=wrap;')).toBe('rect');
    expect(drawioNodeOutline({ shape: 'text', width: 10, height: 10 }).kind).toBe('none');
    expect(drawioNodeOutline({ shape: 'diamond', width: 10, height: 10 })).toEqual({
      kind: 'path',
      d: 'M5 0 L10 5 L5 10 L0 5 Z',
    });
    expect(clipToBox({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 5 })).toEqual({
      x: 10,
      y: 5,
    });
  });

  it('reports nothing drawable for empty or compressed pages', () => {
    expect(drawioView('<mxGraphModel><root/></mxGraphModel>').model).toBeNull();
    expect(drawioView('<mxfile><diagram id="a">abc=</diagram></mxfile>')).toMatchObject({
      model: null,
      compressed: true,
    });
  });

  it('renders the model as an accessible SVG', () => {
    const html = renderToStaticMarkup(<DrawioSvg model={model} title="Infra" selectedId="db" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('draw.io diagram with 4 shapes and 2 connectors');
    expect(html).toContain('>reads</text>');
    expect(html).toContain('var(--color-accent)');
  });
});

describe('diagram view helpers', () => {
  it('normalises payloads defensively', () => {
    expect(readDiagramData(null)).toMatchObject({ format: 'mermaid', source: '', nodes: [] });
    expect(
      readDiagramData({
        format: 'drawio',
        source: 'x',
        title: 't',
        nodes: [{ id: 1 }, { id: 'a', label: 'A' }],
      }).nodes,
    ).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('builds anchors and filters nodes', () => {
    expect(nodeAnchor({ id: 'A', label: 'Client' })).toEqual({
      type: 'node',
      targetId: 'A',
      label: 'Client',
    });
    expect(regionAnchor({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toMatchObject({
      type: 'region',
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      label: 'Region at 10%, 20% (30% × 40%)',
    });
    const nodes = [
      { id: 'api', label: 'Gateway' },
      { id: 'db', label: 'Users' },
    ];
    expect(filterNodes(nodes, 'gate')).toEqual([nodes[0]]);
    expect(filterNodes(nodes, 'DB')).toEqual([nodes[1]]);
    expect(filterNodes(nodes, ' ')).toEqual(nodes);
  });

  it('gives Mermaid SVG explicit pixel size from its viewBox', () => {
    const sized = sizeMermaidSvg(
      '<svg id="m" width="100%" style="max-width: 523.5px; background: red" viewBox="0 0 523.5 300"><g/></svg>',
    );
    expect(sized.width).toBe(524);
    expect(sized.height).toBe(300);
    expect(sized.svg).toMatch(/^<svg width="524" height="300" id="m" style="\s*background: red"/);
    expect(sizeMermaidSvg('<svg><g/></svg>')).toMatchObject({ width: 0, height: 0 });
  });

  it('maps clicked Mermaid elements to node ids', () => {
    const known = new Set(['A', 'node-2']);
    const element = (attrs: Record<string, string>) => ({
      getAttribute: (name: string) => attrs[name] ?? null,
    });
    expect(mermaidNodeIdFromElement(element({ 'data-id': 'A' }), known)).toBe('A');
    expect(mermaidNodeIdFromElement(element({ id: 'flowchart-A-0' }), known)).toBe('A');
    expect(
      mermaidNodeIdFromElement(element({ id: 'anvil-diagram-1234-flowchart-node-2-7' }), known),
    ).toBe('node-2');
    expect(mermaidNodeIdFromElement(element({ id: 'flowchart-Z-0' }), known)).toBeNull();
    expect(mermaidNodeIdFromElement(null, known)).toBeNull();
  });

  it('themes Mermaid from the active tokens', () => {
    const light = mermaidConfigForTokens(DEFAULT_SKETCH_TOKENS.light, 'light');
    expect(light.theme).toBe('base');
    expect(light.securityLevel).toBe('strict');
    expect(light.themeVariables?.darkMode).toBe(false);
    expect(light.themeVariables?.primaryTextColor).toBe(DEFAULT_SKETCH_TOKENS.light['--anvil-ink']);
    const unparsable = mermaidConfigForTokens(
      { ...DEFAULT_SKETCH_TOKENS.dark, '--anvil-canvas': 'oklch(0.2 0 0)' },
      'dark',
    );
    expect(unparsable.theme).toBe('dark');
    expect(unparsable.themeVariables).toBeUndefined();
  });
});

describe('diagram views', () => {
  const drawio: DiagramSurfaceData = {
    format: 'drawio',
    source: DRAWIO,
    title: 'Infra',
    description: 'Services and stores',
    nodes: [
      { id: 'svc', label: 'Service' },
      { id: 'db', label: 'DB' },
    ],
  };

  it('inline shows the drawing, description and actions', () => {
    const html = renderToStaticMarkup(<diagramSurfaceView.Inline {...props(drawio)} />);
    expect(html).toContain('Services and stores');
    expect(html).toContain('draw.io · 2 nodes');
    expect(html).toContain('role="img"');
    expect(html).toContain('Save to repo');
    expect(html).toContain('Open in draw.io');
    expect(html).toContain('Ask agent to revise');
  });

  it('hides Save to repo in read-only threads and offers Open in draw.io only for draw.io', () => {
    const readOnly = renderToStaticMarkup(
      <diagramSurfaceView.Inline {...props(drawio, { readOnly: true })} />,
    );
    expect(readOnly).not.toContain('Save to repo');
    const mermaid = renderToStaticMarkup(
      <diagramSurfaceView.Inline
        {...props({ format: 'mermaid', source: 'graph TD\nA-->B', title: 'Flow' })}
      />,
    );
    expect(mermaid).not.toContain('Open in draw.io');
    expect(mermaid).toContain('Mermaid graph');
  });

  it('shows the saved path once saved', () => {
    const html = renderToStaticMarkup(
      <diagramSurfaceView.Inline
        {...props({ ...drawio, savedPath: 'docs/diagrams/infra.drawio' })}
      />,
    );
    expect(html).toContain('Update saved file');
    expect(html).toContain('docs/diagrams/infra.drawio');
  });

  it('stage lists nodes for comments with the canvas controls', () => {
    const Stage = diagramSurfaceView.Stage!;
    const html = renderToStaticMarkup(
      <Stage {...props(drawio, { presentation: 'stage', focusTargetId: 'db' })} />,
    );
    expect(html).toContain('aria-label="Nodes"');
    expect(html).toContain('Comment on Service');
    expect(html).toContain('Zoom in (+)');
    expect(html).toContain('Comment on a region');
    expect(html).toContain('Ask agent to revise “DB”');
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*DB/);
  });
});
