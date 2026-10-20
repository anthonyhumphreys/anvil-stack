import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../../../shared/agent-ui-intents';
import type { PipelineSurfaceData } from '../../../../../../shared/surfaces/kinds/pipeline';
import type { SurfaceViewProps } from '../../../types';
import { pipelineSurfaceView } from '..';
import { PipelineStage } from '../PipelineStage';
import {
  INLINE_LAYOUT,
  clampZoom,
  ensureVisible,
  fitViewport,
  neighbourNode,
  nodeAnchor,
  prepareGraph,
  zoomAround,
} from '../model';

const data: PipelineSurfaceData = {
  repoId: 'repo-1',
  repoName: 'web-app',
  generatedAt: '',
  providers: ['github-actions'],
  files: [
    {
      path: '.github/workflows/ci.yml',
      provider: 'github-actions',
      role: 'entrypoint',
      name: 'CI',
      valid: true,
    },
  ],
  nodes: [
    {
      id: 'wf',
      type: 'workflow',
      label: 'CI',
      status: 'configured',
      filePath: '.github/workflows/ci.yml',
    },
    {
      id: 'build',
      type: 'job',
      label: 'Build',
      status: 'configured',
      filePath: '.github/workflows/ci.yml',
      excerpt: '  build:\n    runs-on: ubuntu',
      excerptStartLine: 4,
    },
    {
      id: 'lint',
      type: 'job',
      label: 'Lint',
      status: 'error',
      filePath: '.github/workflows/ci.yml',
    },
    {
      id: 'test',
      type: 'job',
      label: 'Test',
      status: 'warning',
      filePath: '.github/workflows/ci.yml',
    },
    {
      id: 's1',
      type: 'step',
      label: 'Checkout',
      status: 'configured',
      filePath: '.github/workflows/ci.yml',
    },
  ],
  edges: [
    { from: 'wf', to: 'build' },
    { from: 'wf', to: 'lint' },
    { from: 'build', to: 'test' },
    { from: 'build', to: 's1' },
  ],
  issues: [
    {
      id: 'i1',
      severity: 'warning',
      filePath: '.github/workflows/ci.yml',
      message: 'No timeout',
      nodeId: 'test',
    },
    {
      id: 'i2',
      severity: 'error',
      filePath: '.github/workflows/ci.yml',
      message: 'Unknown action',
      nodeId: 'lint',
    },
  ],
};

function props(payloadData: unknown = data): SurfaceViewProps {
  const intent: AgentUISurfaceIntent = {
    protocolVersion: 1,
    id: 'surface-1',
    kind: 'surface',
    revision: 1,
    scope: { threadId: 't' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'pipeline',
      title: 'Pipelines · web-app',
      streaming: false,
      digest: '',
      data: payloadData,
    },
    createdAt: '',
    updatedAt: '',
  };
  return {
    intent,
    presentation: 'inline',
    onAction: async () => ({ ok: true }),
    onComment: () => undefined,
    onOpenStage: () => undefined,
  };
}

describe('pipeline model', () => {
  it('compacts steps and lays out left to right', () => {
    const graph = prepareGraph(data, false, INLINE_LAYOUT);
    expect(graph.nodes.map((node) => node.id)).not.toContain('s1');
    expect(graph.hiddenSteps.get('build')).toBe(1);
    const wf = graph.layout.nodes.find((node) => node.id === 'wf')!;
    const test = graph.layout.nodes.find((node) => node.id === 'test')!;
    expect(test.x).toBeGreaterThan(wf.x);
  });

  it('navigates neighbours with arrow keys', () => {
    const graph = prepareGraph(data, false, INLINE_LAYOUT);
    expect(neighbourNode(graph, null, 'ArrowRight')).toBe(graph.layout.nodes[0].id);
    expect(neighbourNode(graph, 'build', 'ArrowRight')).toBe('test');
    expect(neighbourNode(graph, 'test', 'ArrowLeft')).toBe('build');
    const sameLayer = neighbourNode(graph, 'build', 'ArrowDown');
    expect(['lint', 'build']).toContain(sameLayer);
  });

  it('zooms around a point, clamps, fits and keeps nodes visible', () => {
    expect(clampZoom(10)).toBe(2.5);
    const zoomed = zoomAround({ x: 0, y: 0, scale: 1 }, 2, 100, 100);
    expect(zoomed).toEqual({ scale: 2, x: -100, y: -100 });
    const fit = fitViewport({ width: 1000, height: 200 }, 500, 400);
    expect(fit.scale).toBeCloseTo(0.468, 2);
    const visible = ensureVisible(
      { x: 0, y: 0, scale: 1 },
      { x: 900, y: 10, width: 100, height: 40 },
      500,
      400,
    );
    expect(visible.x).toBeLessThan(0);
    expect(nodeAnchor(data.nodes[1])).toMatchObject({
      type: 'node',
      targetId: 'build',
      lineStart: 4,
    });
  });
});

describe('pipeline views', () => {
  it('inline renders a compact accessible graph with issue badges', () => {
    const markup = renderToStaticMarkup(<pipelineSurfaceView.Inline {...props()} />);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="job Lint, Error, 1 issue"');
    expect(markup).toContain('aria-label="job Build, Configured, 1 steps"');
    expect(markup).toContain('Unknown action');
    expect(markup).not.toContain('Checkout');
  });

  it('stage renders zoom controls and graph', () => {
    const Stage = pipelineSurfaceView.Stage!;
    const markup = renderToStaticMarkup(<Stage {...props()} presentation="stage" />);
    expect(markup).toContain('aria-label="Zoom in (+)"');
    expect(markup).toContain('Show steps');
    expect(markup).toContain('Checkout');
    expect(markup).toContain('Select a node');
  });

  it('stage detail shows the YAML excerpt for a focused node', () => {
    const markup = renderToStaticMarkup(
      <PipelineStage {...props()} presentation="stage" focusTargetId="build" />,
    );
    expect(markup).toContain('aria-label="Node Build"');
    expect(markup).toContain('runs-on: ubuntu');
    expect(markup).toContain('Downstream');
  });

  it('handles empty analyses', () => {
    const markup = renderToStaticMarkup(
      <pipelineSurfaceView.Inline
        {...props({ ...data, nodes: [], edges: [], issues: [], files: [] })}
      />,
    );
    expect(markup).toContain('No CI/CD pipeline files');
  });
});
