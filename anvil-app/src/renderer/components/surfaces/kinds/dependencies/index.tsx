import type { SurfaceKindView } from '../../types';
import { DependenciesInline } from './DependenciesInline';
import { DependenciesStage } from './DependenciesStage';

export const dependenciesSurfaceView: SurfaceKindView = {
  Inline: DependenciesInline,
  Stage: DependenciesStage,
};
