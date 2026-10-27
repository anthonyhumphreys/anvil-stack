import type { SurfaceKindView } from '../../types';
import { ArtifactInline, ArtifactStage } from './ArtifactSurfaceViews';

export const artifactSurfaceView: SurfaceKindView = {
  Inline: ArtifactInline,
  Stage: ArtifactStage,
};
