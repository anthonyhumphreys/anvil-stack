import type { SurfaceKindDefinition } from '../types.js';

// Owned by the workstream building the 'diagram' surface. Replace this stub.
export const diagramSurfaceKind: SurfaceKindDefinition = {
  kind: 'diagram',
  label: 'Diagram',
  schema: { type: 'object' },
  actions: {},
  anchors: ['surface'],
  digest: () => 'Diagram',
};
