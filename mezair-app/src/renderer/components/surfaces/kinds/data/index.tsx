import type { SurfaceKindView } from '../../types';
import { DataInline } from './DataInline';
import { DataStage } from './DataStage';

export const dataSurfaceView: SurfaceKindView = {
  Inline: DataInline,
  Stage: DataStage,
};
