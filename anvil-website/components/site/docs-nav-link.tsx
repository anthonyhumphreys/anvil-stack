"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export function DocsNavLink({
  href,
  active,
  children
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Link
      ref={ref}
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-[background-color,color] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active && "bg-[oklch(var(--accent)/0.13)] font-semibold text-foreground"
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        <span className={cn("size-1 rounded-full bg-border transition-[transform,background-color]", active && "size-2 bg-accent")} />
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </Link>
  );
}
