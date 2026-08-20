import Link from "next/link";
import { ChevronDown, Layers3 } from "lucide-react";
import { DocsNavLink } from "@/components/site/docs-nav-link";
import { groupProductDocs, type DocMeta } from "@/lib/docs";
import { docsProducts, productById, type ProductId } from "@/lib/docs-navigation";

export function DocsNav({
  docs,
  activeSlug,
  productId
}: {
  docs: Array<DocMeta & { slug: string; segments: string[] }>;
  activeSlug?: string;
  productId: ProductId;
}) {
  const currentProduct = productById.get(productId) ?? docsProducts[0];
  const journeys = groupProductDocs(docs, productId);
  const activeDoc = docs.find((doc) => doc.slug === activeSlug);

  return (
    <nav className="flex flex-col gap-5" aria-label={`${currentProduct.label} documentation`}>
      <div className="border-b pb-5">
        <p className="px-3 text-xs font-medium text-muted-foreground">Documentation</p>
        <details className="group/product relative mt-1">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span className="flex min-w-0 items-center gap-2.5">
              <Layers3 className="size-4 shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate">{currentProduct.label}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-open/product:rotate-180" aria-hidden="true" />
          </summary>
          <div className="mt-2 grid gap-1 rounded-lg border bg-background p-1.5 shadow-sm">
            {docsProducts.map((product) => (
              <Link
                key={product.id}
                href={product.href}
                aria-current={product.id === productId ? "page" : undefined}
                className="flex min-h-10 items-center justify-between rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span>{product.shortLabel}</span>
                <span className="font-mono text-[0.6875rem] text-muted-foreground">{product.repoName}</span>
              </Link>
            ))}
          </div>
        </details>
      </div>

      {productId !== "start" && productId !== "project" ? (
        <DocsNavLink href={currentProduct.href} active={activeSlug === productId}>
          Product overview
        </DocsNavLink>
      ) : null}

      <div className="grid gap-2">
        {journeys.map((journey) => {
          const isActiveJourney = activeDoc?.journey === journey.id;
          return (
            <details key={journey.id} className="group/journey" open={isActiveJourney || (!activeDoc && journey.id === "learn")}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {journey.label}
                <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 ease-out group-open/journey:rotate-180" aria-hidden="true" />
              </summary>
              <div className="mt-1 grid gap-4 pb-3">
                {journey.groups.map(([section, entries]) => (
                  <div key={`${journey.id}-${section}`}>
                    {journey.groups.length > 1 ? (
                      <p className="px-3 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">{section}</p>
                    ) : null}
                    <div className="grid gap-0.5">
                      {entries.map((entry) => (
                        <DocsNavLink key={entry.slug} href={`/docs/${entry.slug}`} active={activeSlug === entry.slug}>
                          {entry.navTitle}
                        </DocsNavLink>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </nav>
  );
}
