import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'findings' surface. Replace this stub.
export const findingsSurfaceKind: SurfaceKindDefinition = {
  kind: 'findings',
  label: 'Findings',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Findings',
};
