"use client";

import Link from "next/link";
import { ArrowRight, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { journeyById } from "@/lib/docs-navigation";
import type { DocSearchItem } from "@/lib/docs";
import { cn } from "@/lib/utils";

function rankResult(doc: DocSearchItem, query: string) {
  const title = `${doc.title} ${doc.navTitle}`.toLowerCase();
  const headings = doc.searchHeadings.join(" ").toLowerCase();
  const description = doc.description.toLowerCase();
  const context = `${doc.product} ${doc.section} ${doc.journey}`.toLowerCase();

  if (title.includes(query)) return title.startsWith(query) ? 5 : 4;
  if (headings.includes(query)) return 3;
  if (description.includes(query)) return 2;
  if (context.includes(query)) return 1;
  return 0;
}

export function DocsSearch({
  docs,
  className,
  compact = false
}: {
  docs: DocSearchItem[];
  className?: string;
  compact?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const resultsId = useId();

  const results = useMemo(() => {
    if (!deferredQuery) {
      return docs.filter((doc) => doc.kind === "product" || doc.slug === "overview" || doc.slug === "cli").slice(0, 8);
    }
    return docs
      .map((doc) => ({ doc, rank: rankResult(doc, deferredQuery) }))
      .filter((entry) => entry.rank > 0)
      .sort((left, right) => right.rank - left.rank || left.doc.title.localeCompare(right.doc.title))
      .slice(0, 12)
      .map((entry) => entry.doc);
  }, [deferredQuery, docs]);

  function openSearch() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function closeSearch() {
    dialogRef.current?.close();
    setQuery("");
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditing = target?.matches("input, textarea, select, [contenteditable='true']");
      if (isEditing) return;
      if (event.key === "/" || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        openSearch();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={openSearch}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-md border bg-background px-3 text-left text-sm text-muted-foreground transition-[border-color,background-color,color] hover:border-foreground/25 hover:bg-muted/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          compact ? "w-11 justify-center px-0 sm:w-64 sm:justify-start sm:px-3" : "w-full",
          className
        )}
        aria-label="Search documentation"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn("min-w-0 flex-1 truncate", compact && "hidden sm:block")}>Search documentation</span>
        <kbd className={cn("hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground sm:inline", compact && "lg:inline")}>⌘ K</kbd>
      </button>

      <dialog
        ref={dialogRef}
        className="docs-search-dialog m-auto max-h-[min(44rem,calc(100dvh-2rem))] w-[min(44rem,calc(100vw-2rem))] overflow-hidden rounded-xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-[oklch(0.12_0.012_205_/_0.64)]"
        aria-labelledby={`${resultsId}-title`}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSearch();
        }}
      >
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b px-4">
            <Search className="size-5 shrink-0 text-accent" aria-hidden="true" />
            <label id={`${resultsId}-title`} htmlFor={`${resultsId}-input`} className="sr-only">Search Anvil documentation</label>
            <input
              ref={inputRef}
              id={`${resultsId}-input`}
              name="docs-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages, commands, and headings…"
              autoComplete="off"
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
              aria-controls={`${resultsId}-results`}
            />
            <button
              type="button"
              onClick={closeSearch}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Close search"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div id={`${resultsId}-results`} className="min-h-0 overflow-y-auto p-2" aria-live="polite">
            <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {deferredQuery ? `${results.length} ${results.length === 1 ? "result" : "results"}` : "Start with a product or guide"}
            </p>
            {results.length > 0 ? (
              <ul className="grid gap-1">
                {results.map((doc) => (
                  <li key={doc.slug}>
                    <Link
                      href={`/docs/${doc.slug}`}
                      onClick={closeSearch}
                      className="group flex min-h-14 items-center gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-foreground">{doc.title}</span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {doc.product} · {journeyById.get(doc.journey)?.label ?? doc.section}
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-3 py-10 text-center">
                <p className="font-medium">No matching documentation</p>
                <p className="mt-2 text-sm text-muted-foreground">Try a product name, command, or broader task.</p>
              </div>
            )}
          </div>

          <div className="border-t px-4 py-3 text-xs text-muted-foreground">
            Press <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">Esc</kbd> to close. Use Tab to move through results.
          </div>
        </div>
      </dialog>
    </>
  );
}
