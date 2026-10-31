"use client";

import { useEffect } from "react";

/** Wires the Copy buttons that lib/docs.ts renders on every docs code block. */
export function DocCodeCopy() {
  useEffect(() => {
    const timers = new Map<HTMLButtonElement, number>();
    const onClick = async (event: MouseEvent) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy-code]");
      if (!button) return;
      const pre = button.closest(".doc-code")?.querySelector("pre");
      if (!pre) return;
      try {
        await navigator.clipboard.writeText((pre.textContent ?? "").replace(/\n$/, ""));
        button.textContent = "Copied";
        button.dataset.state = "copied";
      } catch {
        // Clipboard access can be refused; select the code so a keyboard copy works.
        const range = document.createRange();
        range.selectNodeContents(pre);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        button.textContent = "Selected";
      }
      window.clearTimeout(timers.get(button));
      timers.set(
        button,
        window.setTimeout(() => {
          button.textContent = button.dataset.copyLabel ?? "Copy";
          delete button.dataset.state;
        }, 1600)
      );
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);
  return null;
}
