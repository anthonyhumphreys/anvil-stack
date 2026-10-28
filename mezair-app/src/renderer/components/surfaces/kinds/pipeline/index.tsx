import type { SurfaceKindView } from '../../types';
import { PipelineInline } from './PipelineInline';
import { PipelineStage } from './PipelineStage';

export const pipelineSurfaceView: SurfaceKindView = {
  Inline: PipelineInline,
  Stage: PipelineStage,
};
