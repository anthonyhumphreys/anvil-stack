import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'sketch' surface. Replace this stub.
export const sketchSurfaceKind: SurfaceKindDefinition = {
  kind: 'sketch',
  label: 'Sketch',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Sketch',
};
