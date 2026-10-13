import type { SurfaceKindView } from '../../types';
import { ReviewInline } from './ReviewInline';
import { ReviewStage } from './ReviewStage';

/** Review surface (spec §8.1): calm inline review, three-pane workbench on the stage. */
export const reviewSurfaceView: SurfaceKindView = { Inline: ReviewInline, Stage: ReviewStage };
