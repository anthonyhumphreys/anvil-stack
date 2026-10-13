import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'artifact' surface. Replace this stub.
export const artifactSurfaceKind: SurfaceKindDefinition = {
  kind: 'artifact',
  label: 'Artifact',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Artifact',
};
