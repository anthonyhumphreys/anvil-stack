import type { SurfaceKindView, SurfaceViewProps } from '../../types';

// Owned by the workstream building the 'artifact' surface. Replace this stub.
function Placeholder({ intent }: SurfaceViewProps) {
  return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
}

export const artifactSurfaceView: SurfaceKindView = { Inline: Placeholder };
