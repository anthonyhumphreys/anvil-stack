import { useContext, useMemo, useRef, useState } from 'react';
import { Loader2, Shapes } from 'lucide-react';
import { SketchFrame } from '../surfaces/kinds/sketch/SketchFrame';
import { SurfaceHost } from '../surfaces/SurfaceHost';
import { ArtifactIcon } from '../surfaces/surface-icons';
import { useSurfaces } from '../surfaces/surfaces-context';
import { buildArtifactSurfaceIntent } from '../surfaces/surface-utils';
import { useViewportMount } from '../surfaces/useViewportMount';
import {
  MessageStreamingContext,
  fenceTitleFromPath,
  findFenceArtifact,
  parseFenceInfo,
} from './surface-fences';

function FenceSource({ code }: { code: string }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        Show source
      </summary>
      <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border-subtle bg-bg-tertiary p-3 font-mono text-xs leading-relaxed text-text-secondary">
        <code>{code}</code>
      </pre>
    </details>
  );
}

/**
 * An ```artifact fence. Once the artifact is persisted after the turn it renders
 * as the same inline surface a tool-published artifact gets (preview, stage,
 * pop-out window); until then it is a compact writing / unsaved card.
 */
export function ArtifactFencePlaceholder({
  language,
  meta,
  code,
}: {
  language: string;
  meta?: string;
  code: string;
}) {
  const streaming = useContext(MessageStreamingContext);
  const { artifacts } = useSurfaces();
  const info = parseFenceInfo(language, meta);
  const artifact = findFenceArtifact(artifacts, info);
  const intent = useMemo(
    () => (artifact ? buildArtifactSurfaceIntent(artifact) : null),
    [artifact],
  );

  if (intent) {
    return (
      <div className="my-3" data-artifact-fence>
        <SurfaceHost intent={intent} />
      </div>
    );
  }

  const title = info.title ?? fenceTitleFromPath(info.relativePath) ?? 'Artifact';
  return (
    <div className="my-2" data-artifact-fence>
      <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-tertiary text-text-secondary">
          {streaming ? (
            <Loader2 size={15} aria-hidden="true" className="animate-spin" />
          ) : (
            <ArtifactIcon kind="text" size={15} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{title}</span>
          <span className="block truncate text-xs text-text-tertiary" aria-live="polite">
            {streaming ? 'Writing…' : 'Not saved to this thread'}
          </span>
        </span>
      </div>
      {!streaming && <FenceSource code={code} />}
    </div>
  );
}

/** A ```sketch fence: a throwaway sketch rendered straight from the fence body. */
export function SketchFence({ meta, code }: { meta?: string; code: string }) {
  const streaming = useContext(MessageStreamingContext);
  const info = parseFenceInfo('sketch', meta);
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useViewportMount(ref);
  const [showSource, setShowSource] = useState(false);
  const title = info.title ?? 'Sketch';

  return (
    <div ref={ref} className="my-3" data-sketch-fence>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs text-text-tertiary">
        <Shapes size={13} aria-hidden="true" />
        <span className="truncate font-medium text-text-secondary">{title}</span>
        <span aria-hidden="true">·</span>
        <span>{streaming ? 'Drawing…' : 'Sketch'}</span>
        {!streaming && (
          <button
            type="button"
            onClick={() => setShowSource((value) => !value)}
            aria-expanded={showSource}
            className="ml-auto rounded-md px-1.5 py-0.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {showSource ? 'Hide source' : 'Source'}
          </button>
        )}
      </p>
      {streaming || !mounted ? (
        <div
          role="status"
          aria-label={streaming ? 'The agent is drawing a sketch' : 'Loading sketch'}
          className="rounded-lg bg-bg-tertiary/50 motion-safe:animate-pulse"
          style={{ height: Math.min(info.height ?? 160, 1600) }}
        />
      ) : (
        <SketchFrame html={code} title={title} initialHeight={info.height} />
      )}
      {showSource && (
        <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border-subtle bg-bg-tertiary p-3 font-mono text-xs leading-relaxed text-text-secondary">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
