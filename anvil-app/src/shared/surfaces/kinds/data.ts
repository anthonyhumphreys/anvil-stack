import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'data' surface. Replace this stub.
export const dataSurfaceKind: SurfaceKindDefinition = {
  kind: 'data',
  label: 'Data',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Data',
};
