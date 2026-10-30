import { MARK_LEG, MARK_NECK, MARK_TAIL, MARK_VIEWBOX } from "@/components/site/mark-geometry";

/**
 * The approved monochrome horse-M mark, following the surrounding text colour.
 * The three shapes move as one body; only the separate foreleg folds. A
 * `.mk-hover` ancestor lifts the horse in a small controlled rise; the
 * geometry itself is never altered.
 */
export function MezairMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      overflow="visible"
    >
      {title ? <title>{title}</title> : null}
      <g className="mk-body">
        <path d={MARK_TAIL.d} transform={MARK_TAIL.transform} fill="currentColor" />
        <path d={MARK_NECK.d} transform={MARK_NECK.transform} fill="currentColor" />
        <g className="mk-leg">
          <path d={MARK_LEG.d} transform={MARK_LEG.transform} fill="currentColor" />
        </g>
      </g>
    </svg>
  );
}
