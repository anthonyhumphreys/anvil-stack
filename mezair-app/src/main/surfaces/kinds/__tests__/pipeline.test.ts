import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CicdPipelineAnalysis } from '../../../../shared/types.js';
import {
  compactPipelineGraph,
  digestPipeline,
  pipelineSurfaceKind,
  type PipelineSurfaceData,
} from '../../../../shared/surfaces/kinds/pipeline.js';
import {
  countCrossings,
  edgePath,
  layoutDag,
} from '../../../../shared/surfaces/kinds/pipeline/layout.js';
import { validateJsonSchema } from '../../validate.js';
import { fakeCoreState, getSurface, resetFakeCore, testContext, textOf } from './data-fake-core.js';

const WORKFLOW = `name: CI
on: [push]
jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Install
        run: pnpm install
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
`;

function analysis(): CicdPipelineAnalysis {
  const file = '.github/workflows/ci.yml';
  return {
    repoId: 'repo-1',
    repoName: 'web-app',
    generatedAt: '2026-01-01T00:00:00Z',
    files: [
      {
        path: file,
        provider: 'github-actions',
        role: 'entrypoint',
        name: 'CI',
        valid: true,
        content: WORKFLOW,
      },
    ],
    nodes: [
      {
        id: 'wf',
        type: 'workflow',
        provider: 'github-actions',
        filePath: file,
        label: 'CI',
        status: 'configured',
        depth: 0,
      },
      {
        id: 'build',
        type: 'job',
        provider: 'github-actions',
        filePath: file,
        label: 'Build',
        status: 'configured',
        depth: 1,
      },
      {
        id: 'test',
        type: 'job',
        provider: 'github-actions',
        filePath: file,
        label: 'test',
        status: 'warning',
        depth: 1,
      },
      {
        id: 's1',
        type: 'step',
        provider: 'github-actions',
        filePath: file,
        label: 'Checkout',
        status: 'configured',
        depth: 2,
      },
      {
        id: 's2',
        type: 'step',
        provider: 'github-actions',
        filePath: file,
        label: 'Install',
        status: 'configured',
        depth: 2,
      },
    ],
    edges: [
      { from: 'wf', to: 'build', label: 'starts' },
      { from: 'build', to: 'test', label: 'needs' },
      { from: 'build', to: 's1' },
      { from: 'build', to: 's2' },
    ],
    findings: [
      {
        id: 'i1',
        severity: 'warning',
        provider: 'github-actions',
        filePath: file,
        message: 'No timeout-minutes',
        nodeId: 'test',
      },
    ],
    stack: { language: 'node', workspace: false, scripts: [], evidence: [] },
    recommendations: [],
    summary: {
      providers: ['github-actions'],
      workflowCount: 1,
      stageCount: 0,
      jobCount: 2,
      stepCount: 2,
      gateCount: 0,
      templateCount: 0,
    },
  };
}

const mocks = vi.hoisted(() => ({ analysis: null as CicdPipelineAnalysis | null }));

vi.mock('../../core.js', async () => await import('./data-fake-core.js'));
vi.mock('../../../db/database.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: (id: string) =>
        id === 'repo-1' ? { id, name: 'web-app', path: '/work/web-app' } : undefined,
    }),
  }),
}));
vi.mock('../../../services/cicd.service.js', () => ({
  analyzeCicdPipelines: async () => mocks.analysis,
}));

const { pipelineSurfaceHandler } = await import('../pipeline.js');
const { buildPipelineData, excerptFor } = await import('../pipeline/build.js');
const { pipelineSnapshot } = await import('../pipeline/snapshot.js');

beforeEach(() => {
  resetFakeCore();
  mocks.analysis = analysis();
});

describe('layoutDag', () => {
  it('layers by longest path and places nodes left to right', () => {
    const layout = layoutDag(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    );
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect([...'abcd'].map((id) => byId.get(id)!.layer)).toEqual([0, 1, 2, 3]);
    expect(byId.get('b')!.x).toBeGreaterThan(byId.get('a')!.x);
    expect(layout.layers).toBe(4);
    expect(layout.width).toBeGreaterThan(0);
  });

  it('survives cycles, self loops, duplicates and dangling edges', () => {
    const layout = layoutDag(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'a' }],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
        { from: 'a', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'a', to: 'missing' },
      ],
    );
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.filter((edge) => edge.back)).toHaveLength(1);
    expect(edgePath(layout.edges.find((edge) => edge.back)!)).toMatch(/^M/);
  });

  it('reduces crossings with barycentre ordering', () => {
    // Inputs ordered to cross: a→y, b→x.
    const layout = layoutDag(
      [{ id: 'a' }, { id: 'b' }, { id: 'x' }, { id: 'y' }],
      [
        { from: 'a', to: 'y' },
        { from: 'b', to: 'x' },
      ],
    );
    expect(countCrossings(layout)).toBe(0);
  });

  it('handles empty graphs and centres short layers', () => {
    expect(layoutDag([], []).nodes).toEqual([]);
    const layout = layoutDag(
      [{ id: 'root' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
      ['a', 'b', 'c'].map((id) => ({ from: 'root', to: id })),
    );
    const root = layout.nodes.find((node) => node.id === 'root')!;
    const middle = layout.nodes.find((node) => node.layer === 1 && node.order === 1)!;
    expect(root.y).toBeCloseTo(middle.y);
  });
});

describe('pipeline payload', () => {
  it('builds a schema-valid payload with excerpts and pinned issues', () => {
    const data = buildPipelineData(analysis());
    expect(validateJsonSchema(pipelineSurfaceKind.schema, data)).toEqual([]);
    const build = data.nodes.find((node) => node.id === 'build')!;
    expect(build.excerpt?.split('\n')[0]).toBe('  build:');
    expect(build.excerpt).toContain('pnpm install');
    expect(build.excerpt).not.toContain('needs: build');
    expect(data.nodes.find((node) => node.id === 's1')!.excerpt).toBe(
      '      - name: Checkout\n        uses: actions/checkout@v4',
    );
    expect(data.issues[0].nodeId).toBe('test');
    expect(digestPipeline(data)).toContain('Validation: 0 errors, 1 warnings');
  });

  it('excerptFor falls back gracefully', () => {
    expect(excerptFor('', { type: 'job', label: 'x' })).toBeUndefined();
    expect(excerptFor(WORKFLOW, { type: 'job', label: 'nope' })).toBeUndefined();
    expect(excerptFor(WORKFLOW, { type: 'workflow', label: 'CI' })?.startLine).toBe(1);
  });

  it('compacts steps into counts on their parents', () => {
    const view = compactPipelineGraph(buildPipelineData(analysis()), false);
    expect(view.nodes.map((node) => node.id)).toEqual(['wf', 'build', 'test']);
    expect(view.hiddenSteps.get('build')).toBe(2);
  });
});

describe('cicd_analyze + actions', () => {
  it('publishes a keyed pipeline surface and returns its digest', async () => {
    const result = await pipelineSurfaceHandler.toolProvider!.call(testContext(), 'cicd_analyze', {
      repoId: 'repo-1',
    });
    const intent = getSurface(result?.structuredContent?.surfaceId as string)!;
    expect(intent.payload.key).toBe('pipeline:repo-1');
    expect(textOf(result)).toContain('Pipelines for web-app');
    expect(textOf(result)).not.toContain('pnpm install');
  });

  it('rejects out-of-scope repos', async () => {
    await expect(
      pipelineSurfaceHandler.toolProvider!.call(testContext({ repoIds: [] }), 'cicd_analyze', {
        repoId: 'repo-1',
      }),
    ).rejects.toThrow(/outside/);
  });

  it('ask_fix_node sends node, upstream, issues and YAML', async () => {
    const result = await pipelineSurfaceHandler.toolProvider!.call(testContext(), 'cicd_analyze', {
      repoId: 'repo-1',
    });
    const intent = getSurface(result?.structuredContent?.surfaceId as string)!;
    const outcome = await pipelineSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_fix_node', targetIds: ['test'] },
    );
    expect(outcome.ok).toBe(true);
    const message = fakeCoreState.delivered[0].message;
    expect(message).toContain('job "test" (warning)');
    expect(message).toContain('upstream: job "Build"');
    expect(message).toContain('[warning] No timeout-minutes');
    expect(message).toContain('needs: build');
    const missing = await pipelineSurfaceHandler.executeAction!(
      { intent },
      { surfaceId: intent.id, action: 'ask_fix_node', targetIds: ['nope'] },
    );
    expect(missing.ok).toBe(false);
  });

  it('snapshot is a static, script-free SVG', () => {
    const data: PipelineSurfaceData = buildPipelineData(analysis());
    data.nodes[0].label = '<script>alert(1)</script>';
    const snapshot = pipelineSnapshot(data, 'Pipelines');
    expect(snapshot.html).toContain('<svg');
    expect(snapshot.html).toContain('<desc>');
    expect(snapshot.html).not.toMatch(/<script/i);
    expect(snapshot.html).toContain('No timeout-minutes');
  });
});
