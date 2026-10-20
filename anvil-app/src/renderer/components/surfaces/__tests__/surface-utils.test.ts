import { describe, expect, it } from 'vitest';
import type { AgentUISurfaceIntent } from '../../../../shared/agent-ui-intents';
import type { ChatArtifact } from '../../../../shared/types';
import {
  actionAvailability,
  buildArtifactSurfaceIntent,
  canShareSurface,
  describeRegion,
  formatRelativeTime,
  formatSurfaceMeta,
  isActionAvailable,
  isEmptySurfaceData,
  isSyntheticSurfaceId,
  newerIntent,
  normaliseRegion,
  parseSyntheticArtifactSurfaceId,
  readArtifactSurfaceData,
  readStageSurfaceId,
  resolveArtifactStageSurfaceId,
  resolveShareTarget,
  resolveSupersedingId,
  shouldReplaceIntent,
  syntheticArtifactSurfaceId,
  withStageSurface,
} from '../surface-utils';
import { mergeThreadSurfaces } from '../SurfacesProvider';
import { surfaceWindowName, surfaceWindowTitle } from '../SurfaceWindow';

function surface(
  id: string,
  overrides: Partial<AgentUISurfaceIntent['payload']> = {},
  extra: Partial<AgentUISurfaceIntent> = {},
): AgentUISurfaceIntent {
  return {
    protocolVersion: 1,
    id,
    kind: 'surface',
    revision: 1,
    scope: { threadId: 'thread-1' },
    lifecycle: 'presented',
    presentation: { collapsed: false, hidden: false },
    payload: {
      surfaceKind: 'review',
      title: 'Review',
      streaming: false,
      digest: 'digest',
      data: { verdict: 'ship' },
      ...overrides,
    },
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...extra,
  };
}

describe('stage URL state', () => {
  it('reads and writes ?surface= without touching other params', () => {
    const search = new URLSearchParams('thread=t1&surface=s1');
    expect(readStageSurfaceId(search)).toBe('s1');
    expect(readStageSurfaceId(new URLSearchParams('surface=%20'))).toBeNull();
    const cleared = withStageSurface(search, null);
    expect(cleared.toString()).toBe('thread=t1');
    expect(withStageSurface(cleared, 'surface:abc').get('surface')).toBe('surface:abc');
    expect(search.get('surface')).toBe('s1');
  });
});

describe('revision handling', () => {
  it('prefers the higher revision, then the later update', () => {
    const v1 = surface('a');
    const v2 = surface('a', {}, { revision: 2 });
    expect(newerIntent(v1, v2)).toBe(v2);
    expect(newerIntent(v2, v1)).toBe(v2);
    const later = surface('a', {}, { updatedAt: '2026-01-01T11:00:00.000Z' });
    expect(shouldReplaceIntent(v1, later)).toBe(true);
    expect(shouldReplaceIntent(later, v1)).toBe(false);
  });

  it('merges transcript and context copies in transcript order', () => {
    const transcript = [surface('a'), surface('b')];
    const context = [
      surface('b', { title: 'B v3' }, { revision: 3 }),
      surface('c', {}, { createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const merged = mergeThreadSurfaces(transcript, context);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1].payload.title).toBe('B v3');
  });
});

describe('resolveSupersedingId', () => {
  it('uses the explicit supersededBy first', () => {
    expect(resolveSupersedingId(surface('a', { supersededBy: 'z' }), [])).toBe('z');
  });

  it('finds the newest later surface with the same key', () => {
    const first = surface('a', { key: 'review:repo:tree' });
    const second = surface(
      'b',
      { key: 'review:repo:tree' },
      { createdAt: '2026-01-01T11:00:00.000Z' },
    );
    const third = surface(
      'c',
      { key: 'review:repo:tree' },
      { createdAt: '2026-01-01T12:00:00.000Z' },
    );
    const other = surface('d', { key: 'other' }, { createdAt: '2026-01-01T13:00:00.000Z' });
    const all = [first, second, third, other];
    expect(resolveSupersedingId(first, all)).toBe('c');
    expect(resolveSupersedingId(third, all)).toBeUndefined();
    expect(resolveSupersedingId(other, all)).toBeUndefined();
    expect(resolveSupersedingId(surface('x'), all)).toBeUndefined();
  });
});

describe('meta line', () => {
  const now = Date.parse('2026-01-01T10:03:00.000Z');
  it('formats revision and relative time', () => {
    expect(formatSurfaceMeta(surface('a'), now)).toBe('3m ago');
    expect(
      formatSurfaceMeta(
        surface('a', {}, { revision: 2, updatedAt: '2026-01-01T10:02:50.000Z' }),
        now,
      ),
    ).toBe('v2 · updated just now');
    expect(formatSurfaceMeta(surface('a', { streaming: true }), now)).toBe('Writing…');
    expect(formatRelativeTime('not a date', now)).toBe('');
    expect(formatRelativeTime('2026-01-01T07:00:00.000Z', now)).toBe('3h ago');
  });
});

describe('artifacts and sharing', () => {
  const artifact = {
    id: 'art-1',
    threadId: 'thread-1',
    title: 'Runbook',
    kind: 'markdown',
    storage: 'repository',
    relativePath: 'runbook.md',
    content: '# Runbook',
    version: 3,
    status: 'draft',
    visibility: 'local',
    source: 'assistant',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
  } satisfies ChatArtifact;

  it('synthesises an artifact surface for fence-persisted artifacts', () => {
    const intent = buildArtifactSurfaceIntent(artifact);
    expect(intent.id).toBe(syntheticArtifactSurfaceId('art-1'));
    expect(isSyntheticSurfaceId(intent.id)).toBe(true);
    expect(parseSyntheticArtifactSurfaceId(intent.id)).toBe('art-1');
    expect(parseSyntheticArtifactSurfaceId('surface:abc')).toBeNull();
    expect(readArtifactSurfaceData(intent.payload.data)).toEqual({
      artifactId: 'art-1',
      version: 3,
      operation: 'updated',
    });
  });

  it('resolves share targets per kind', () => {
    const artifactSurface = surface('s1', {
      surfaceKind: 'artifact',
      data: { artifactId: 'art-1', version: 1, operation: 'created' },
    });
    expect(resolveShareTarget(artifactSurface, false)).toEqual({
      itemType: 'artifact',
      itemId: 'art-1',
    });
    expect(resolveShareTarget(surface('s2'), true)).toEqual({ itemType: 'surface', itemId: 's2' });
    expect(resolveShareTarget(surface('s2'), false)).toBeNull();
    const sketch = surface('s3', { surfaceKind: 'sketch', data: { sketchId: 'k' } });
    expect(resolveShareTarget(sketch, false)).toBeNull();
    expect(canShareSurface(sketch, false)).toBe(true);
    expect(canShareSurface(surface('s2'), false)).toBe(false);
  });

  it('tolerates malformed artifact data', () => {
    expect(readArtifactSurfaceData(null)).toBeNull();
    expect(readArtifactSurfaceData({ artifactId: '' })).toBeNull();
    expect(readArtifactSurfaceData({ artifactId: 'a', version: 'x' })?.version).toBe(1);
  });
});

describe('regions', () => {
  it('normalises drags into 0..1 rectangles and rejects tiny ones', () => {
    expect(
      normaliseRegion({ x: 200, y: 100 }, { x: 100, y: 50 }, { width: 400, height: 200 }),
    ).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.25,
      height: 0.25,
    });
    expect(
      normaliseRegion({ x: 10, y: 10 }, { x: 12, y: 40 }, { width: 400, height: 200 }),
    ).toBeNull();
    expect(
      normaliseRegion({ x: -50, y: 0 }, { x: 900, y: 900 }, { width: 400, height: 200 }),
    ).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    expect(describeRegion({ x: 0.25, y: 0.1, width: 0.5, height: 0.2 })).toBe(
      'Region at 25%, 10% (50% × 20%)',
    );
  });
});

describe('misc', () => {
  it('detects empty streaming data', () => {
    expect(isEmptySurfaceData(undefined)).toBe(true);
    expect(isEmptySurfaceData({})).toBe(true);
    expect(isEmptySurfaceData([])).toBe(true);
    expect(isEmptySurfaceData({ rows: [] })).toBe(false);
  });

  it('names windows per surface and includes the workspace in the title', () => {
    expect(surfaceWindowName('surface:ab/c')).toBe('anvil-surface-surface-ab-c');
    expect(surfaceWindowTitle('Review', 'Payments')).toBe('Review — Payments');
    expect(surfaceWindowTitle('Review', '')).toBe('Review');
  });
});

describe('read-only action availability', () => {
  it('hides registry mutation actions only when read-only', () => {
    expect(isActionAvailable('review', 'post_to_pr', true)).toBe(false);
    expect(isActionAvailable('review', 'apply_patch', true)).toBe(false);
    expect(isActionAvailable('review', 'create_work_items', true)).toBe(false);
    expect(isActionAvailable('findings', 'create_work_items', true)).toBe(false);
    expect(isActionAvailable('dependencies', 'create_work_items', true)).toBe(false);
    expect(isActionAvailable('artifact', 'save_to_repo', true)).toBe(false);
    expect(isActionAvailable('review', 'post_to_pr', false)).toBe(true);
    expect(isActionAvailable('artifact', 'save_to_repo', undefined)).toBe(true);
  });

  it('keeps non-mutation and undeclared actions available', () => {
    expect(isActionAvailable('review', 'ask_fix', true)).toBe(true);
    expect(isActionAvailable('review', 'dismiss', true)).toBe(true);
    expect(isActionAvailable('findings', 'not_declared', true)).toBe(true);
    expect(isActionAvailable('unknown-kind', 'anything', true)).toBe(true);
    const review = actionAvailability('review', true);
    expect(review('accept')).toBe(true);
    expect(review('post_to_pr')).toBe(false);
  });
});

describe('artifact deep links', () => {
  const artifactSurface = (id: string, version: number, createdAt: string) =>
    surface(
      id,
      { surfaceKind: 'artifact', data: { artifactId: 'a1', version, operation: 'created' } },
      { createdAt },
    );

  it('prefers the latest published surface for the artifact', () => {
    const surfaces = [
      artifactSurface('s-v1', 1, '2026-01-01T10:00:00.000Z'),
      artifactSurface('s-v2', 2, '2026-01-01T11:00:00.000Z'),
      surface('other', { surfaceKind: 'artifact', data: { artifactId: 'a2', version: 3 } }),
      surface('review'),
    ];
    expect(resolveArtifactStageSurfaceId('a1', surfaces, [])).toBe('s-v2');
    expect(resolveArtifactStageSurfaceId('a1', [...surfaces].reverse(), [{ id: 'a1' }])).toBe(
      's-v2',
    );
  });

  it('falls back to the synthetic stage surface, or waits for the thread', () => {
    expect(resolveArtifactStageSurfaceId('a1', [surface('review')], [{ id: 'a1' }])).toBe(
      syntheticArtifactSurfaceId('a1'),
    );
    expect(resolveArtifactStageSurfaceId('a1', [], [{ id: 'a9' }])).toBeNull();
  });
});
