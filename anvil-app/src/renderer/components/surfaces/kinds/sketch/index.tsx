import type { SurfaceKindView, SurfaceViewProps } from '../../types';

// Owned by the workstream building the 'sketch' surface. Replace this stub.
function Placeholder({ intent }: SurfaceViewProps) {
  return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
}

export const sketchSurfaceView: SurfaceKindView = { Inline: Placeholder };
