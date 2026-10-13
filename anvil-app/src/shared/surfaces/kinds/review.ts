import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'review' surface. Replace this stub.
export const reviewSurfaceKind: SurfaceKindDefinition = {
  kind: 'review',
  label: 'Review',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Review',
};
