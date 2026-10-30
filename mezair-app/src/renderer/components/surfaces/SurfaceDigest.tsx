import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import { SurfaceKindIcon } from './surface-icons';

/** Plain-text fallback wherever a surface can't render (remote transcripts, exports). */
export function SurfaceDigest({ intent }: { intent: AgentUISurfaceIntent }) {
  return (
    <div className="flex max-w-[72ch] items-start gap-2 px-1 text-sm">
      <SurfaceKindIcon kind={intent.payload.surfaceKind} className="mt-1 text-text-tertiary" />
      <div className="min-w-0">
        <p className="font-semibold text-text-primary">{intent.payload.title}</p>
        <p className="whitespace-pre-wrap break-words text-text-secondary">
          {intent.payload.digest}
        </p>
      </div>
    </div>
  );
}
