import type { SurfaceKindView, SurfaceViewProps } from '../../types';

// Owned by the workstream building the 'pipeline' surface. Replace this stub.
function Placeholder({ intent }: SurfaceViewProps) {
  return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
}

export const pipelineSurfaceView: SurfaceKindView = { Inline: Placeholder };
