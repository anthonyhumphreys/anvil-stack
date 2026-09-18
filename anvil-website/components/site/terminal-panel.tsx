"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

export type TerminalLine = {
  text: string;
  tone?: "dim" | "ok" | "accent" | "plain";
};

const toneClass: Record<NonNullable<TerminalLine["tone"]>, string> = {
  dim: "text-[oklch(var(--forge-dim))]",
  ok: "text-[oklch(0.78_0.13_150)]",
  accent: "text-[oklch(var(--forge-ember))]",
  plain: "text-[oklch(var(--forge-text))]"
};

function subscribeReducedMotion(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TerminalPanel({
  command,
  lines,
  title,
  className
}: {
  command: string;
  lines: TerminalLine[];
  title: string;
  className?: string;
}) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
  const [typed, setTyped] = useState(0);
  const [shown, setShown] = useState(0);
  const timers = useRef<number[]>([]);

  const fullText = useMemo(
    () => `$ ${command}\n${lines.map((line) => line.text).join("\n")}`,
    [command, lines]
  );

  useEffect(() => {
    if (reduced) return;
    timers.current.push(
      window.setTimeout(() => {
        setTyped(0);
        setShown(0);
      }, 0)
    );
    for (let i = 0; i < command.length; i += 1) {
      timers.current.push(window.setTimeout(() => setTyped(i + 1), 260 + i * 34));
    }
    const commandDone = 260 + command.length * 34;
    lines.forEach((_, index) => {
      timers.current.push(
        window.setTimeout(() => setShown(index + 1), commandDone + 320 + index * 150)
      );
    });
    return () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    };
  }, [reduced, command, lines]);

  const visibleCommand = reduced ? command : command.slice(0, typed);
  const visibleLines = reduced ? lines : lines.slice(0, shown);
  const commandDone = reduced || typed >= command.length;
  const allShown = reduced || shown >= lines.length;

  return (
    <div className={`forge-panel ${className ?? ""}`}>
      <div className="forge-window-bar" aria-hidden="true">
        <span className="dot dot--ember" />
        <span className="dot" />
        <span className="dot" />
        <span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">{title}</span>
      </div>
      <div className="terminal-body p-4 sm:p-5" aria-hidden="true">
        <span className="terminal-line">
          <span className="text-[oklch(var(--forge-ember))]">$</span>{" "}
          <span className="text-[oklch(var(--forge-text))]">{visibleCommand}</span>
          {commandDone ? null : <span className="terminal-cursor" />}
        </span>
        {visibleLines.map((line, index) => (
          <span key={index} className={`terminal-line ${toneClass[line.tone ?? "plain"]}`}>
            {line.text}
          </span>
        ))}
        {allShown ? (
          <span className="terminal-line">
            <span className="terminal-cursor" />
          </span>
        ) : null}
      </div>
      <pre className="sr-only">{fullText}</pre>
    </div>
  );
}
