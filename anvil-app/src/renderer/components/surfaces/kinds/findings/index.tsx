import type { SurfaceKindView } from '../../types';
import { FindingsInline } from './FindingsInline';
import { FindingsStage } from './FindingsStage';

export const findingsSurfaceView: SurfaceKindView = {
  Inline: FindingsInline,
  Stage: FindingsStage,
};
