import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { normaliseRegion } from '../../surface-utils';

export interface DiagramRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Drag-a-rectangle overlay (same interaction as the sketch frame). Sits over
 * the drawing at its natural size, so the reported 0..1 rectangle is
 * relative to the diagram regardless of pan and zoom.
 */
export function RegionOverlay({
  onRegion,
  onCancel,
}: {
  onRegion: (rect: DiagramRegion) => void;
  onCancel: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  // Positions in the overlay's own (unscaled) coordinate space.
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const scaleX = rect.width / (element.offsetWidth || rect.width || 1);
    const scaleY = rect.height / (element.offsetHeight || rect.height || 1);
    return {
      x: (event.clientX - rect.left) / (scaleX || 1),
      y: (event.clientY - rect.top) / (scaleY || 1),
    };
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!start) return;
    const element = event.currentTarget;
    const region = normaliseRegion(start, point(event), {
      width: element.offsetWidth,
      height: element.offsetHeight,
    });
    setStart(null);
    setCurrent(null);
    if (region) onRegion(region);
  };

  const selection =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      ref={overlayRef}
      tabIndex={0}
      role="application"
      aria-label="Drag to select a region of the diagram to comment on. Press Escape to cancel."
      className="absolute inset-0 cursor-crosshair rounded-md bg-bg-primary/10 outline outline-1 outline-border focus-visible:outline-2 focus-visible:outline-accent"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const next = point(event);
        setStart(next);
        setCurrent(next);
      }}
      onPointerMove={(event) => {
        if (start) setCurrent(point(event));
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        setStart(null);
        setCurrent(null);
      }}
    >
      {selection && (
        <div
          aria-hidden="true"
          className="absolute border-2 border-accent bg-accent/10"
          style={selection}
        />
      )}
    </div>
  );
}
