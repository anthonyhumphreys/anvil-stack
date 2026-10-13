import type { SurfaceKindDefinition } from './types.js';
import { artifactSurfaceKind } from './kinds/artifact.js';
import { sketchSurfaceKind } from './kinds/sketch.js';
import { reviewSurfaceKind } from './kinds/review.js';
import { findingsSurfaceKind } from './kinds/findings.js';
import { dependenciesSurfaceKind } from './kinds/dependencies.js';
import { pipelineSurfaceKind } from './kinds/pipeline.js';
import { dataSurfaceKind } from './kinds/data.js';
import { diagramSurfaceKind } from './kinds/diagram.js';

/** Every registered surface kind. Add a kind by adding one entry here. */
export const SURFACE_KINDS: readonly SurfaceKindDefinition[] = [
  artifactSurfaceKind,
  sketchSurfaceKind,
  reviewSurfaceKind,
  findingsSurfaceKind,
  dependenciesSurfaceKind,
  pipelineSurfaceKind,
  dataSurfaceKind,
  diagramSurfaceKind,
] as SurfaceKindDefinition[];

const BY_KIND = new Map(SURFACE_KINDS.map((definition) => [definition.kind, definition]));

export function getSurfaceKind(kind: string): SurfaceKindDefinition | undefined {
  return BY_KIND.get(kind);
}
