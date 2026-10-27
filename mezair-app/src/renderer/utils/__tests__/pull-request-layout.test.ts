import { describe, expect, it } from 'vitest';
import type {
  PullRequestVisualisationEdge,
  PullRequestVisualisationNode,
} from '../../../shared/types';
import { isRenderablePullRequestEdge, layoutPullRequestNodes } from '../pull-request-layout';

describe('layoutPullRequestNodes', () => {
  it('lays a causal chain out from left to right on one rank', () => {
    const nodes = [node('review'), node('auth-file'), node('worker')];
    const positions = layoutPullRequestNodes(nodes, [
      edge('review-to-auth', 'review', 'auth-file'),
      edge('auth-to-worker', 'auth-file', 'worker'),
    ]);

    expect(positions.get('review')!.x).toBeLessThan(positions.get('auth-file')!.x);
    expect(positions.get('auth-file')!.x).toBeLessThan(positions.get('worker')!.x);
    expect(positions.get('review')!.y).toBe(positions.get('auth-file')!.y);
    expect(positions.get('auth-file')!.y).toBe(positions.get('worker')!.y);
  });

  it('centres a fan-in target between its inputs', () => {
    const nodes = [node('review'), node('auth-file'), node('worker')];
    const positions = layoutPullRequestNodes(nodes, [
      edge('review-to-worker', 'review', 'worker'),
      edge('auth-to-worker', 'auth-file', 'worker'),
    ]);

    const sourceYs = [positions.get('review')!.y, positions.get('auth-file')!.y].sort(
      (left, right) => left - right,
    );
    expect(positions.get('worker')!.x).toBeGreaterThan(positions.get('review')!.x);
    expect(positions.get('worker')!.y).toBeGreaterThan(sourceYs[0]);
    expect(positions.get('worker')!.y).toBeLessThan(sourceYs[1]);
  });

  it('keeps coordinates stable when callers compare different node states', () => {
    const nodes = [
      node('entry', 'both'),
      node('legacy', 'before'),
      node('replacement', 'after'),
      node('worker', 'both'),
    ];
    const edges = [
      edge('entry-to-legacy', 'entry', 'legacy', 'before'),
      edge('legacy-to-worker', 'legacy', 'worker', 'before'),
      edge('entry-to-replacement', 'entry', 'replacement', 'after'),
      edge('replacement-to-worker', 'replacement', 'worker', 'after'),
    ];

    const first = layoutPullRequestNodes(nodes, edges);
    const second = layoutPullRequestNodes(nodes, edges);
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('produces finite positions for cyclic and disconnected graph sections', () => {
    const nodes = [node('a'), node('b'), node('c'), node('detached')];
    const positions = layoutPullRequestNodes(nodes, [
      edge('a-to-b', 'a', 'b'),
      edge('b-to-c', 'b', 'c'),
      edge('c-to-a', 'c', 'a'),
    ]);

    expect(positions.size).toBe(nodes.length);
    for (const position of positions.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
    }
  });
});

describe('isRenderablePullRequestEdge', () => {
  it('removes self-loops and relationships to hidden chapter nodes', () => {
    const ids = new Set(['source', 'target']);
    expect(isRenderablePullRequestEdge(edge('valid', 'source', 'target'), ids)).toBe(true);
    expect(isRenderablePullRequestEdge(edge('loop', 'source', 'source'), ids)).toBe(false);
    expect(isRenderablePullRequestEdge(edge('missing', 'source', 'other'), ids)).toBe(false);
  });
});

function node(
  id: string,
  changeState: PullRequestVisualisationNode['changeState'] = 'both',
): PullRequestVisualisationNode {
  return {
    id,
    label: id,
    kind: 'service',
    tone: 'neutral',
    changeState,
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  changeState: PullRequestVisualisationEdge['changeState'] = 'both',
): PullRequestVisualisationEdge {
  return {
    id,
    source,
    target,
    tone: 'neutral',
    changeState,
    changed: false,
  };
}
