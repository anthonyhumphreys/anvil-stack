import type { SurfaceKindView } from '../../types';
import { DiagramInline } from './DiagramInline';
import { DiagramStage } from './DiagramStage';

export const diagramSurfaceView: SurfaceKindView = {
  Inline: DiagramInline,
  Stage: DiagramStage,
};
