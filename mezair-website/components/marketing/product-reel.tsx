"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { Pause, Play } from "lucide-react";
import { screen, type ScreenId } from "@/lib/screens";
import { useReel } from "./use-reel";

const chapters: Array<{ id: string; label: string; hint: string; shot: ScreenId; fit?: "panel" }> = [
  { id: "work", label: "Watch it work", hint: "Each command and edit", shot: "desktop-run-steps" },
  { id: "result", label: "Read the result", hint: "The answer and changed files", shot: "desktop-run-complete" },
  { id: "review", label: "Review the change", hint: "Findings before you commit", shot: "surface-review" },
  { id: "move", label: "Move the session", hint: "Continue on another machine", shot: "mesh-session", fit: "panel" }
];

const DURATIONS = [6200, 5600, 6200, 5600] as const;

/**
 * The homepage projection: four real captures of Mezair Desktop, cut together
 * as one job from first step to handoff. Autoplays only while on screen and
 * never under reduced motion; any choice holds that chapter.
 */
export function ProductReel() {
  const { rootRef, chapter, barProgress, reduced, playing, select, toggle } = useReel(DURATIONS);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = chapters[chapter];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const last = chapters.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = chapter === last ? 0 : chapter + 1;
    else if (event.key === "ArrowLeft") next = chapter === 0 ? last : chapter - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div ref={rootRef}>
      <div className="cine-tilt">
        <div
          role="tabpanel"
          id="reel-panel"
          aria-labelledby={`reel-tab-${current.id}`}
          tabIndex={0}
          className="reel-frame cine-rise focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          {chapters.map((item, index) => {
            const shot = screen(item.shot);
            return (
              <div key={item.id} className="reel-slide" data-active={index === chapter} data-fit={item.fit} aria-hidden={index !== chapter}>
                <Image
                  src={shot.file}
                  width={shot.width}
                  height={shot.height}
                  alt={index === chapter ? shot.alt : ""}
                  priority={index < 2}
                  sizes="(min-width: 1400px) 1300px, 94vw"
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="reel">
        <div role="tablist" aria-label="From first step to handoff" className="reel-tabs" onKeyDown={onKeyDown}>
          {chapters.map((item, index) => {
            const selected = index === chapter;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`reel-tab-${item.id}`}
                aria-selected={selected}
                aria-controls="reel-panel"
                tabIndex={selected ? 0 : -1}
                className="reel-tab"
                onClick={() => select(index)}
              >
                <span className="reel-bar" style={{ "--p": selected ? barProgress : 0 } as CSSProperties} aria-hidden="true" />
                <span className="reel-tab-label">{item.label}</span>
                <span className="reel-tab-hint">{item.hint}</span>
              </button>
            );
          })}
        </div>
        {reduced ? null : (
          <button type="button" className="reel-toggle" onClick={toggle} aria-label={playing ? "Pause the reel" : "Play the reel"}>
            {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
          </button>
        )}
      </div>

      <p className="cine-fine mt-3">
        {screen(current.shot).caption}{" "}
        <Link href="/docs/project/screenshots" className="cine-link">
          About these screenshots
        </Link>
      </p>
    </div>
  );
}
