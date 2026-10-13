import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'dependencies' surface. Replace this stub.
export const dependenciesSurfaceKind: SurfaceKindDefinition = {
  kind: 'dependencies',
  label: 'Dependencies',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Dependencies',
};
