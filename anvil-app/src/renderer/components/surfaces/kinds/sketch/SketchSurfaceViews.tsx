import { useEffect, useState } from 'react';
import { BookmarkPlus, Check, Copy, Crosshair, Download } from 'lucide-react';
import {
  DEFAULT_SKETCH_TOKENS,
  buildSketchDocument,
} from '../../../../../shared/surfaces/sketch-runtime';
import type { ChatSketch } from '../../../../../shared/surfaces/types';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import { Button } from '../../../ui';
import { SurfaceSkeleton } from '../../SurfaceSkeleton';
import { readSketchSurfaceData } from '../../surface-utils';
import type { SurfaceViewProps } from '../../types';
import { SketchFrame } from './SketchFrame';

function useSketch(sketchId: string | undefined, refreshKey: unknown) {
  const [state, setState] = useState<{
    sketch: ChatSketch | null;
    loading: boolean;
    error: string | null;
  }>({ sketch: null, loading: true, error: null });

  useEffect(() => {
    if (!sketchId) return;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void window.anvil.surfaces
      .getSketch(sketchId)
      .then((sketch) => {
        if (cancelled) return;
        setState({
          sketch,
          loading: false,
          error: sketch ? null : 'This sketch is no longer available.',
        });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: caught instanceof Error ? caught.message : 'The sketch could not be loaded.',
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [sketchId, refreshKey]);

  return {
    ...state,
    markKept: (artifactId: string) =>
      setState((current) =>
        current.sketch
          ? { ...current, sketch: { ...current.sketch, keptArtifactId: artifactId } }
          : current,
      ),
  };
}

export function sketchFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'sketch'}.html`;
}

function downloadSketch(sketch: ChatSketch, title: string) {
  const document_ = buildSketchDocument(sketch.html, {
    tokens: DEFAULT_SKETCH_TOKENS,
    mode: 'share',
  });
  const url = URL.createObjectURL(new Blob([document_], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = sketchFileName(title);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SketchToolbar({
  sketch,
  title,
  selecting,
  onToggleSelecting,
  onKept,
}: {
  sketch: ChatSketch;
  title: string;
  selecting: boolean;
  onToggleSelecting: () => void;
  onKept: (artifactId: string) => void;
}) {
  const [keeping, setKeeping] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keep = async () => {
    setKeeping(true);
    setError(null);
    try {
      const artifact = await window.anvil.surfaces.keepSketch(sketch.id, title);
      onKept(artifact.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The sketch could not be kept.');
    } finally {
      setKeeping(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant={selecting ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={selecting}
        onClick={onToggleSelecting}
      >
        <Crosshair size={12} aria-hidden="true" />
        {selecting ? 'Cancel selection' : 'Comment on a region'}
      </Button>
      {sketch.keptArtifactId ? (
        <span className="inline-flex items-center gap-1 px-2 text-xs text-text-tertiary">
          <Check size={12} aria-hidden="true" className="text-success" />
          Kept as an artifact
        </span>
      ) : (
        <Button variant="ghost" size="sm" disabled={keeping} onClick={() => void keep()}>
          <BookmarkPlus size={12} aria-hidden="true" />
          Keep
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => downloadSketch(sketch, title)}>
        <Download size={12} aria-hidden="true" />
        Download .html
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void copyTextToClipboard(sketch.html).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          })
        }
      >
        {copied ? (
          <Check size={12} aria-hidden="true" className="text-success" />
        ) : (
          <Copy size={12} aria-hidden="true" />
        )}
        {copied ? 'Copied' : 'Copy HTML'}
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

function SketchView({ intent, onComment, presentation }: SurfaceViewProps) {
  const data = readSketchSurfaceData(intent.payload.data);
  const { sketch, loading, error, markKept } = useSketch(
    data?.sketchId,
    `${intent.revision}:${intent.updatedAt}`,
  );
  const [selecting, setSelecting] = useState(false);

  if (!data) return <p className="text-sm text-text-secondary">{intent.payload.digest}</p>;
  if (!sketch) {
    return loading ? (
      <SurfaceSkeleton label="Loading sketch" />
    ) : (
      <p className="text-sm text-text-secondary">{error ?? intent.payload.digest}</p>
    );
  }

  const keptFromPayload = (intent.payload.data as { keptArtifactId?: unknown }).keptArtifactId;
  const shownSketch =
    !sketch.keptArtifactId && typeof keptFromPayload === 'string'
      ? { ...sketch, keptArtifactId: keptFromPayload }
      : sketch;
  const toolbar = (
    <SketchToolbar
      sketch={shownSketch}
      title={intent.payload.title}
      selecting={selecting}
      onToggleSelecting={() => setSelecting((value) => !value)}
      onKept={markKept}
    />
  );

  return (
    <div className={presentation === 'inline' ? 'space-y-1.5' : 'mx-auto max-w-5xl space-y-3'}>
      {presentation !== 'inline' && toolbar}
      <SketchFrame
        html={sketch.html}
        title={intent.payload.title}
        initialHeight={sketch.height ?? data.height}
        selectingRegion={selecting}
        onCancelRegion={() => setSelecting(false)}
        onRegion={(region) => {
          setSelecting(false);
          onComment({ type: 'region', rect: region.rect, label: region.label });
        }}
      />
      {presentation === 'inline' && toolbar}
    </div>
  );
}

export const SketchInline = SketchView;
export const SketchStage = SketchView;
