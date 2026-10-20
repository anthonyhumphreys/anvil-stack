"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, CornerDownLeft, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
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

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query);
  if (index === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
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
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [active, setActive] = useState<{ query: string; index: number } | null>(null);
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

  const groups = useMemo(() => {
    const grouped = new Map<string, { doc: DocSearchItem; index: number }[]>();
    results.forEach((doc, index) => {
      const label = deferredQuery ? doc.product : "Start here";
      const list = grouped.get(label) ?? [];
      list.push({ doc, index });
      grouped.set(label, list);
    });
    return [...grouped.entries()];
  }, [results, deferredQuery]);

  const activeIndex =
    active?.query === deferredQuery ? Math.max(0, Math.min(active.index, results.length - 1)) : 0;

  function setActiveIndex(index: number) {
    setActive({ query: deferredQuery, index });
  }

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function openSearch() {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function closeSearch() {
    dialogRef.current?.close();
    setQuery("");
    setActive(null);
  }

  function goTo(index: number) {
    const doc = results[index];
    if (!doc) return;
    closeSearch();
    router.push(`/docs/${doc.slug}`);
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(activeIndex + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      goTo(activeIndex);
    }
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

  const activeOptionId = `${resultsId}-option-${activeIndex}`;

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
              role="combobox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search pages, commands, and headings…"
              autoComplete="off"
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
              aria-controls={`${resultsId}-results`}
              aria-expanded="true"
              aria-activedescendant={results.length > 0 ? activeOptionId : undefined}
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

          <div className="min-h-0 overflow-y-auto p-2" aria-live="polite">
            <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
              {deferredQuery ? `${results.length} ${results.length === 1 ? "result" : "results"}` : "Start with a product or guide"}
            </p>
            {results.length > 0 ? (
              <ul ref={listRef} id={`${resultsId}-results`} role="listbox" aria-label="Documentation results" className="grid gap-1">
                {groups.map(([product, entries]) => (
                  <li key={product} role="presentation">
                    <p className="px-3 pb-1 pt-3 font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground first:pt-1">
                      {product}
                    </p>
                    <ul role="group" aria-label={product} className="grid gap-1">
                      {entries.map(({ doc, index }) => {
                        const active = index === activeIndex;
                        return (
                          <li key={doc.slug} role="option" id={`${resultsId}-option-${index}`} aria-selected={active}>
                            <button
                              type="button"
                              data-active={active}
                              onClick={() => goTo(index)}
                              onMouseEnter={() => setActiveIndex(index)}
                              className={cn(
                                "group flex min-h-14 w-full items-center gap-4 rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                active ? "bg-muted" : "hover:bg-muted/60"
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-foreground">
                                  <Highlight text={doc.title} query={deferredQuery} />
                                </span>
                                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                  {doc.section} · <Highlight text={doc.description} query={deferredQuery} />
                                </span>
                              </span>
                              <ArrowRight
                                className={cn(
                                  "size-4 shrink-0 text-muted-foreground transition-[opacity,transform]",
                                  active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100"
                                )}
                                aria-hidden="true"
                              />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
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

          <div className="flex items-center gap-4 border-t px-4 py-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">↑</kbd>
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">↓</kbd>
              to move
            </span>
            <span className="flex items-center gap-1.5">
              <CornerDownLeft className="size-3" aria-hidden="true" />
              to open
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border bg-muted px-1 py-0.5 font-mono">Esc</kbd>
              to close
            </span>
          </div>
        </div>
      </dialog>
    </>
  );
}
