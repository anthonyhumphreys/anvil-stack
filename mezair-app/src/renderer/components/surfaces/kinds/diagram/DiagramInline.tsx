import { useEffect, useMemo, useRef, useState } from 'react';
import { describeDiagramFormat } from '../../../../../shared/surfaces/kinds/diagram';
import type { SurfaceViewProps } from '../../types';
import {
  ActionStatusLine,
  SurfaceSkeleton,
  useSurfaceActions,
} from '../../shared-ui/useSurfaceActions';
import { DiagramActions } from './DiagramActions';
import { DiagramDrawing, DiagramRenderStatus, useDiagramRender } from './DiagramContent';
import { INLINE_MAX_HEIGHT, formatMeta, readDiagramData } from './model';

export function DiagramInline({
  intent,
  onAction,
  onComment,
  onOpenStage,
  readOnly,
}: SurfaceViewProps) {
  const raw = intent.payload.data;
  const data = useMemo(() => readDiagramData(raw), [raw]);
  const render = useDiagramRender(data);
  const actions = useSurfaceActions(onAction);
  const frameRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = frameRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const update = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [render.ready, render.width, render.height]);

  if (intent.payload.streaming && !data.source) {
    return <SurfaceSkeleton label="Drawing diagram" />;
  }

  const meta = formatMeta(data, describeDiagramFormat(data));
  const waiting = !render.ready && render.mermaid?.status === 'pending';

  return (
    <section aria-label={intent.payload.title} className="flex flex-col gap-2">
      <p className="text-xs text-text-tertiary">{meta}</p>
      {data.description && (
        <p className="max-w-[72ch] text-sm leading-relaxed text-text-secondary">
          {data.description}
        </p>
      )}
      <DiagramRenderStatus render={render} />
      {waiting ? (
        <div
          aria-hidden="true"
          className="h-40 rounded-lg bg-bg-tertiary motion-safe:animate-pulse"
        />
      ) : (
        <div className="relative">
          <div
            ref={frameRef}
            className="overflow-hidden [&_svg]:h-auto [&_svg]:max-w-full"
            style={{ maxHeight: INLINE_MAX_HEIGHT }}
          >
            <DiagramDrawing data={data} render={render} />
          </div>
          {overflowing && (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-bg-primary to-transparent"
              />
              <button
                type="button"
                onClick={() => onOpenStage()}
                className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-md border border-border bg-bg-secondary px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Show the whole diagram
              </button>
            </>
          )}
        </div>
      )}
      <DiagramActions
        data={data}
        readOnly={readOnly}
        actions={actions}
        compact
        onCommentSurface={() => onComment({ type: 'surface', label: data.title || undefined })}
      />
      <ActionStatusLine status={actions.status} />
      {actions.confirmDialog}
    </section>
  );
}
