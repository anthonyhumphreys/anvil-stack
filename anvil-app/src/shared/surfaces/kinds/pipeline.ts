import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'pipeline' surface. Replace this stub.
export const pipelineSurfaceKind: SurfaceKindDefinition = {
  kind: 'pipeline',
  label: 'Pipeline',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Pipeline',
};
