import type { SurfaceKindView } from '../../types';
import { SketchInline, SketchStage } from './SketchSurfaceViews';

export { SketchFrame } from './SketchFrame';
export const sketchSurfaceView: SurfaceKindView = { Inline: SketchInline, Stage: SketchStage };
