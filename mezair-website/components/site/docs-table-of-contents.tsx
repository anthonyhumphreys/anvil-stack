"use client";

import { useEffect, useState } from "react";
import type { DocHeading } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function DocsTableOfContents({ headings }: { headings: DocHeading[] }) {
  const [activeId, setActiveId] = useState(headings[0]?.id ?? "");

  useEffect(() => {
    const elements = headings
      .map((heading) => document.getElementById(heading.id))
      .filter((element): element is HTMLElement => Boolean(element));
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -68% 0px", threshold: [0, 1] }
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav aria-label="On this page">
      <p className="text-xs font-semibold text-foreground">On this page</p>
      <ol className="mt-3 grid gap-1.5 text-xs leading-5">
        {headings.map((heading) => (
          <li key={heading.id} className={heading.depth === 3 ? "pl-3" : undefined}>
            <a
              href={`#${heading.id}`}
              aria-current={activeId === heading.id ? "location" : undefined}
              className={cn(
                "block rounded-sm py-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeId === heading.id && "font-medium text-foreground"
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
