"use client";

import { useId, useState, type CSSProperties } from "react";
import { MARK_BRUSH, MARK_LEG, MARK_NECK, MARK_TAIL } from "@/components/site/mark-geometry";

type StrokeKey = keyof typeof MARK_BRUSH;
type Shape = { d: string; transform: string };

/** Two strokes, left to right: one gesture through the tail and neck, then the foreleg. */
const strokes: Array<{ key: StrokeKey; brush: (typeof MARK_BRUSH)[StrokeKey] }> = [
  { key: "sweep", brush: MARK_BRUSH.sweep },
  { key: "leg", brush: MARK_BRUSH.leg }
];

/*
 * Bristles: thin copies of the brush centreline, offset across the stroke and
 * running ahead of the body of ink by `lead` (scaled per stroke in CSS). The
 * gap between them and the main stroke is the dry-brush streaking (kasure).
 * Offsets and widths are fractions of the brush width.
 */
const bristles = [
  { dx: -0.3, dy: -0.16, w: 0.11, lead: 0.13 },
  { dx: 0.27, dy: 0.2, w: 0.09, lead: 0.09 },
  { dx: -0.08, dy: 0.31, w: 0.13, lead: 0.15 },
  { dx: 0.19, dy: -0.29, w: 0.08, lead: 0.06 },
  { dx: 0.02, dy: 0.03, w: 0.17, lead: 0.17 },
  { dx: -0.37, dy: 0.1, w: 0.07, lead: 0.04 },
  { dx: 0.36, dy: -0.04, w: 0.06, lead: 0.11 }
];

/* Droplets flicked off the brush as it lifts from the hoof. */
const splash = [
  { cx: 1262, cy: 826, r: 10 },
  { cx: 1294, cy: 858, r: 6 },
  { cx: 1240, cy: 876, r: 5 },
  { cx: 1316, cy: 806, r: 4 },
  { cx: 1306, cy: 884, r: 3 }
];

/**
 * The mark's signature moment, painted like sumi-e, left to right: a dry-brush
 * ground line, then one continuous stroke up the tail, over into the valley,
 * up the neck and to a firm stop at the muzzle, then a short foreleg stroke
 * with a flick of ink at the hoof. Bristles run ahead of the ink, edges are
 * fibrous, ink pools where the brush lands and a wet bleed dries into the
 * crisp canonical mark. Then the whole horse rises once on its haunches, as
 * one body, and lands a little further forward.
 *
 * Pure CSS on SVG. Every keyframe only fills backwards, so reduced motion,
 * no-JS and the end of the animation all show the canonical mark. Pressing
 * it replays the movement.
 */
export function AnimatedMark({ className, label = "Replay the Mezair mark" }: { className?: string; label?: string }) {
  const [take, setTake] = useState(0);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const inked = (shape: Shape, stroke: StrokeKey) => (
    <>
      <g mask={`url(#${id}-${stroke})`}>
        <path d={shape.d} transform={shape.transform} fill="currentColor" />
      </g>
      {/* Wet ink: bleeds past the edge while fresh, then dries away. */}
      <g mask={`url(#${id}-${stroke})`} className={`mk-wet mk-s-${stroke}`}>
        <path d={shape.d} transform={shape.transform} fill="currentColor" filter={`url(#${id}-bleed)`} />
      </g>
    </>
  );

  return (
    <button
      type="button"
      className={`mk-stage mk-hover ${className ?? ""}`}
      onClick={() => setTake((value) => value + 1)}
      aria-label={label}
    >
      <svg key={take} viewBox="160 160 1216 760" className="mk-anim" aria-hidden="true" focusable="false">
        <defs>
          {/* Paper fibre: roughens every brush edge. */}
          <filter id={`${id}-fiber`} filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1100">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="3" seed="11" result="grain" />
            <feDisplacementMap in="SourceGraphic" in2="grain" scale="28" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id={`${id}-bleed`} filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1100">
            <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="4" result="wash" />
            <feDisplacementMap in="SourceGraphic" in2="wash" scale="40" xChannelSelector="R" yChannelSelector="G" result="spread" />
            <feGaussianBlur in="spread" stdDeviation="6" />
          </filter>

          {strokes.map(({ key, brush }) => (
            <mask key={key} id={`${id}-${key}`} maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1100">
              <g filter={`url(#${id}-fiber)`} className={`mk-s-${key}`}>
                <circle className="mk-pool" cx={brush.start[0]} cy={brush.start[1]} r={brush.width * 0.36} fill="#fff" />
                {bristles.map((bristle, index) => (
                  <path
                    key={index}
                    className="mk-bristle"
                    d={brush.d}
                    transform={`translate(${bristle.dx * brush.width} ${bristle.dy * brush.width})`}
                    pathLength={1}
                    fill="none"
                    stroke="#fff"
                    strokeWidth={bristle.w * brush.width}
                    strokeLinecap="round"
                    style={{ "--mk-lead": bristle.lead } as CSSProperties}
                  />
                ))}
                <path
                  className="mk-brush"
                  d={brush.d}
                  pathLength={1}
                  fill="none"
                  stroke="#fff"
                  strokeWidth={brush.width}
                  strokeLinejoin="round"
                />
              </g>
              {/* Seals any sliver the brush missed, so the dried mark is exact. */}
              <rect className={`mk-settle mk-s-${key}`} x="0" y="0" width="1600" height="1100" fill="#fff" />
            </mask>
          ))}

          <linearGradient id={`${id}-ground`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.2" stopColor="currentColor" stopOpacity="0.3" />
            <stop offset="0.75" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`${id}-shadow`}>
            <stop offset="0" stopColor="#000" stopOpacity="0.55" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse className="mk-shadow" cx="760" cy="852" rx="460" ry="22" fill={`url(#${id}-shadow)`} />
        <path
          className="mk-ground"
          d="M176 846 C 520 842, 980 849, 1362 844"
          pathLength={1}
          stroke={`url(#${id}-ground)`}
          strokeWidth="7"
          strokeLinecap="round"
          fill="none"
          filter={`url(#${id}-fiber)`}
        />

        {/* One rigid body: it rises on its haunches without ever coming apart. */}
        <g className="mk-body">
          {inked(MARK_TAIL, "sweep")}
          {inked(MARK_NECK, "sweep")}
          <g className="mk-leg">{inked(MARK_LEG, "leg")}</g>
        </g>

        <g className="mk-splash" filter={`url(#${id}-fiber)`}>
          {splash.map((drop) => (
            <circle key={`${drop.cx}-${drop.cy}`} cx={drop.cx} cy={drop.cy} r={drop.r} fill="currentColor" />
          ))}
        </g>
      </svg>
    </button>
  );
}
