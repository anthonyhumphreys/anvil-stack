import type { SurfaceKindView } from './types';
import { artifactSurfaceView } from './kinds/artifact';
import { sketchSurfaceView } from './kinds/sketch';
import { reviewSurfaceView } from './kinds/review';
import { findingsSurfaceView } from './kinds/findings';
import { dependenciesSurfaceView } from './kinds/dependencies';
import { pipelineSurfaceView } from './kinds/pipeline';
import { dataSurfaceView } from './kinds/data';
import { diagramSurfaceView } from './kinds/diagram';
import { validationSurfaceView } from './kinds/validation';

const VIEWS: Record<string, SurfaceKindView> = {
  artifact: artifactSurfaceView,
  sketch: sketchSurfaceView,
  review: reviewSurfaceView,
  findings: findingsSurfaceView,
  dependencies: dependenciesSurfaceView,
  pipeline: pipelineSurfaceView,
  data: dataSurfaceView,
  diagram: diagramSurfaceView,
  validation: validationSurfaceView,
};

export function getSurfaceView(kind: string): SurfaceKindView | undefined {
  return VIEWS[kind];
}
