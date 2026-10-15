import Link from "next/link";
import { ArrowRight, Check, ChevronDown, FileCheck2, PackageSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { WorkbenchStill } from "@/components/site/workbench";
import { groupProductDocs, type DocMeta } from "@/lib/docs";
import { journeyById, type ProductId } from "@/lib/docs-navigation";
import { productById, type ProductId as SiteProductId } from "@/lib/site";

export function ProductDocsLanding({
  productId,
  docs
}: {
  productId: Exclude<ProductId, "start" | "project">;
  docs: Array<DocMeta & { slug: string; segments: string[] }>;
}) {
  const product = productById.get(productId as SiteProductId);
  if (!product) return null;
  const journeys = groupProductDocs(docs, productId);

  return (
    <div className="pb-8">
      <section className="pb-12">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <product.icon className="size-4 text-accent" aria-hidden="true" />
          {product.statusLabel}
          <span aria-hidden="true">/</span>
          <span className="font-mono text-[0.8125rem]">{product.repoName}</span>
        </p>
        <h1 className="font-display text-display-2 mt-5">{product.title}</h1>
        <p className="mt-4 text-xl font-medium leading-8">{product.tagline}</p>
        <p className="mt-4 max-w-[66ch] text-lg leading-8 text-muted-foreground">{product.description}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href={product.startHref}>{product.startLabel}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={product.repoHref}>Read the source</Link>
          </Button>
        </div>
      </section>

      <section aria-label={`${product.title} at work`}>
        <ProductProof productId={productId} />
      </section>

      <section className="mt-14 grid gap-10 border-y py-10 lg:grid-cols-2" aria-labelledby={`${productId}-scope`}>
        <div>
          <h2 id={`${productId}-scope`} className="text-lg font-semibold">What it&apos;s for</h2>
          <p className="mt-3 max-w-[56ch] text-[0.9375rem] leading-7 text-muted-foreground">{product.boundary}</p>
          <h2 className="mt-8 text-lg font-semibold">Where it&apos;s at</h2>
          <p className="mt-3 max-w-[56ch] text-[0.9375rem] leading-7 text-muted-foreground">{product.status}</p>
        </div>
        <ul className="grid content-start gap-3">
          {product.points.map((point) => (
            <li key={point} className="flex gap-3 text-[0.9375rem] leading-7">
              <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="pt-14" aria-labelledby={`${productId}-paths-title`}>
        <h2 id={`${productId}-paths-title`} className="font-display text-display-3">Read the docs</h2>
        <div className="mt-8 border-y">
          {journeys.map((journey) => (
            <div key={journey.id} className="grid gap-5 border-b py-7 last:border-b-0 lg:grid-cols-[12rem_1fr]">
              <div>
                <p className="text-lg font-semibold">{journey.label}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{journeyById.get(journey.id)?.description}</p>
              </div>
              <div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {journey.entries.slice(0, 8).map((entry) => (
                    <JourneyLink key={entry.slug} entry={entry} />
                  ))}
                </div>
                {journey.entries.length > 8 ? (
                  <details className="group/more mt-2 border-t pt-2">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 transition-transform group-open/more:rotate-180" aria-hidden="true" />
                      {journey.entries.length - 8} more
                    </summary>
                    <div className="mt-1 grid gap-1 sm:grid-cols-2">
                      {journey.entries.slice(8).map((entry) => (
                        <JourneyLink key={entry.slug} entry={entry} />
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function JourneyLink({ entry }: { entry: { slug: string; navTitle: string } }) {
  return (
    <Link
      href={`/docs/${entry.slug}`}
      className="group flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-[0.9375rem] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{entry.navTitle}</span>
      <ArrowRight
        className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </Link>
  );
}

function ProductProof({ productId }: { productId: Exclude<ProductId, "start" | "project"> }) {
  if (productId === "sync") return <EnvelopeBoundary />;
  if (productId === "desktop") return <WorkbenchStill step={2} />;

  if (productId === "registry") {
    const steps = [
      { label: "A package is requested", detail: "npm, pnpm or Yarn asks for metadata or a tarball.", icon: PackageSearch },
      { label: "Policy decides", detail: "Rules, provenance and cached analysis are checked.", icon: ShieldCheck },
      { label: "The decision is recorded", detail: "Allowed, quarantined or blocked, with the reason.", icon: FileCheck2 }
    ];
    return (
      <div className="rounded-xl border bg-card p-6 sm:p-7">
        <ol className="grid gap-6 lg:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.label} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/15">
                <step.icon className="size-5 text-accent" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm text-muted-foreground">Step {index + 1}</span>
                <span className="mt-0.5 block font-semibold">{step.label}</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-6 border-t pt-5 text-sm leading-6 text-muted-foreground">
          An optional LLM review can explain the evidence. It never decides; the policy does.
        </p>
      </div>
    );
  }

  if (productId === "cloud") {
    return (
      <figure className="forge-panel">
        <div className="forge-window-bar" aria-hidden="true">
          <span className="dot dot--ember" />
          <span className="dot" />
          <span className="dot" />
          <span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">src/cells/orders.cell.ts</span>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[0.8125rem] leading-7 sm:p-6">
          <code>{`export const Orders = cell({
  queries: { listOrders },
  mutations: { createOrder },
  capabilities: ["database"]
});

$ anvil-cloud check --json
{ "buildReady": true }`}</code>
        </pre>
        <figcaption className="sr-only">An example Cell definition and a passing check.</figcaption>
      </figure>
    );
  }

  return (
    <div className="grid overflow-hidden rounded-xl border md:grid-cols-2">
      <div className="bg-card p-6">
        <h3 className="text-lg font-semibold">Safe mode</h3>
        <p className="mt-2 text-[0.9375rem] leading-7 text-muted-foreground">
          Install dependencies with lifecycle scripts switched off.
        </p>
        <code className="mt-5 block overflow-x-auto rounded-md bg-muted px-3 py-3 font-mono text-[0.8125rem]">anvil-npm-ci-safe</code>
      </div>
      <div className="border-t bg-card p-6 md:border-l md:border-t-0">
        <h3 className="text-lg font-semibold">Observed mode</h3>
        <p className="mt-2 text-[0.9375rem] leading-7 text-muted-foreground">
          Let the scripts run, and get a report of what they did.
        </p>
        <code className="mt-5 block overflow-x-auto rounded-md bg-muted px-3 py-3 font-mono text-[0.8125rem]">anvil-npm-ci-observed</code>
      </div>
    </div>
  );
}
