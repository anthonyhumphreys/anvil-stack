import type { SketchSurfaceData, SurfaceKindDefinition } from '../types.js';

/** Sketch surface payload: the shared contract plus display metadata. */
export interface SketchSurfacePayload extends SketchSurfaceData {
  title?: string;
  /** Set once Keep promoted the sketch to an HTML artifact. */
  keptArtifactId?: string;
}

export const SKETCH_MAX_HEIGHT = 20_000;

export function sketchSurfaceDigest(data: SketchSurfacePayload): string {
  const title = data.title?.trim() ? ` "${data.title.trim()}"` : '';
  const height = data.height ? ` · ${data.height}px tall` : '';
  const kept = data.keptArtifactId ? ` · kept as artifact ${data.keptArtifactId}` : '';
  return `Sketch${title}${height}${kept}`;
}

export const sketchSurfaceKind: SurfaceKindDefinition<SketchSurfacePayload> = {
  kind: 'sketch',
  label: 'Sketch',
  schema: {
    type: 'object',
    properties: {
      sketchId: { type: 'string', minLength: 1, maxLength: 200 },
      height: { type: 'integer', minimum: 1, maximum: SKETCH_MAX_HEIGHT },
      title: { type: 'string', maxLength: 300 },
      keptArtifactId: { type: 'string', minLength: 1, maxLength: 200 },
    },
    required: ['sketchId'],
    additionalProperties: false,
  },
  actions: {
    keep: {
      label: 'Keep',
      semantics: { type: 'mezair-command', command: 'sketch.keep' },
      targets: 'none',
    },
  },
  anchors: ['surface', 'region'],
  digest: sketchSurfaceDigest,
  // Sharing keeps the sketch first and shares the resulting artifact (§8.10).
  shareable: false,
};
