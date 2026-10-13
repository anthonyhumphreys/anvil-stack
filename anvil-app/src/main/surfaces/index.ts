import { registerAgentToolProvider } from '../agent-tools/dispatch.js';
import type { MainSurfaceHandler } from './types.js';
import { artifactSurfaceHandler } from './kinds/artifact.js';
import { sketchSurfaceHandler } from './kinds/sketch.js';
import { reviewSurfaceHandler } from './kinds/review.js';
import { findingsSurfaceHandler } from './kinds/findings.js';
import { dependenciesSurfaceHandler } from './kinds/dependencies.js';
import { pipelineSurfaceHandler } from './kinds/pipeline.js';
import { dataSurfaceHandler } from './kinds/data.js';

export const MAIN_SURFACE_HANDLERS: readonly MainSurfaceHandler[] = [
  artifactSurfaceHandler,
  sketchSurfaceHandler,
  reviewSurfaceHandler,
  findingsSurfaceHandler,
  dependenciesSurfaceHandler,
  pipelineSurfaceHandler,
  dataSurfaceHandler,
];

const BY_KIND = new Map(MAIN_SURFACE_HANDLERS.map((handler) => [handler.kind, handler]));

export function getMainSurfaceHandler(kind: string): MainSurfaceHandler | undefined {
  return BY_KIND.get(kind);
}

let registered = false;

/** Called once from main startup. Registers every kind's agent tools. */
export function registerSurfaceTools(): void {
  if (registered) return;
  registered = true;
  for (const handler of MAIN_SURFACE_HANDLERS) {
    if (handler.toolProvider) registerAgentToolProvider(handler.toolProvider);
  }
}
