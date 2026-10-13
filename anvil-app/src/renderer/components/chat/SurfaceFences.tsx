import { useContext, useRef, useState } from 'react';
import { Loader2, Maximize2, Shapes } from 'lucide-react';
import { SketchFrame } from '../surfaces/kinds/sketch/SketchFrame';
import { ArtifactIcon } from '../surfaces/surface-icons';
import { useSurfaces } from '../surfaces/surfaces-context';
import { syntheticArtifactSurfaceId } from '../surfaces/surface-utils';
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

/** Compact card for an ```artifact fence, linked to the artifact persisted after the turn. */
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
  const { artifacts, openStage } = useSurfaces();
  const info = parseFenceInfo(language, meta);
  const artifact = findFenceArtifact(artifacts, info);
  const title =
    artifact?.title ?? info.title ?? fenceTitleFromPath(info.relativePath) ?? 'Artifact';
  const status = artifact
    ? `v${artifact.version} · ${artifact.storage === 'session' ? 'Session only' : artifact.relativePath}`
    : streaming
      ? 'Writing…'
      : 'Not saved to this thread';

  return (
    <div className="my-2" data-artifact-fence>
      <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-tertiary text-text-secondary">
          {artifact ? (
            <ArtifactIcon kind={artifact.kind} size={15} />
          ) : streaming ? (
            <Loader2 size={15} aria-hidden="true" className="animate-spin" />
          ) : (
            <ArtifactIcon kind="text" size={15} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text-primary">{title}</span>
          <span className="block truncate text-xs text-text-tertiary" aria-live="polite">
            {status}
          </span>
        </span>
        {artifact && openStage && (
          <button
            type="button"
            onClick={(event) =>
              openStage(syntheticArtifactSurfaceId(artifact.id), {
                returnFocus: event.currentTarget,
              })
            }
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <Maximize2 size={12} aria-hidden="true" />
            Open
          </button>
        )}
      </div>
      {!streaming && !artifact && <FenceSource code={code} />}
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
