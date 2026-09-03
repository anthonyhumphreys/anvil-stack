import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  Container,
  FileCheck2,
  PackageSearch,
  ShieldCheck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { groupProductDocs, type DocMeta } from "@/lib/docs";
import { journeyById, type ProductId } from "@/lib/docs-navigation";
import { productLines } from "@/lib/site";

const startHref: Record<Exclude<ProductId, "start" | "project">, string> = {
  desktop: "/docs/desktop/installation",
  cloud: "/docs/cloud/quickstart",
  registry: "/docs/registry/quickstart",
  "node-base": "/docs/node-base/safe-mode"
};

const statusLabel: Record<Exclude<ProductId, "start" | "project">, string> = {
  desktop: "Active development",
  cloud: "Alpha",
  registry: "Alpha",
  "node-base": "Companion surface"
};

export function ProductDocsLanding({
  productId,
  docs
}: {
  productId: Exclude<ProductId, "start" | "project">;
  docs: Array<DocMeta & { slug: string; segments: string[] }>;
}) {
  const product = productLines.find((entry) => entry.id === productId);
  if (!product) return null;
  const journeys = groupProductDocs(docs, productId);

  return (
    <div className="pb-8">
      <section className="border-b pb-12">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="gap-2 bg-muted/35 text-muted-foreground">
            <product.icon className="size-3.5 text-accent" aria-hidden="true" />
            {product.repoName}
          </Badge>
          <span className="text-xs text-muted-foreground">Open source · {statusLabel[productId]}</span>
        </div>
        <h1 className="mt-6 max-w-4xl text-balance text-4xl font-semibold leading-[1.05] tracking-[-0.025em] sm:text-5xl lg:text-6xl">
          {product.title}
        </h1>
        <p className="mt-5 max-w-[68ch] text-pretty text-lg leading-8 text-muted-foreground">{product.description}</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href={startHref[productId]}>
              Open the setup guide
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={product.repoHref}>Inspect the repository</Link>
          </Button>
        </div>
      </section>

      <section className="py-12" aria-labelledby={`${productId}-proof-title`}>
        <div className="mb-6 grid gap-3 sm:grid-cols-[12rem_1fr]">
          <h2 id={`${productId}-proof-title`} className="text-sm font-semibold">Working proof</h2>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">A concrete view of the boundary this product owns today.</p>
        </div>
        <ProductProof productId={productId} />
      </section>

      <section className="border-y py-10" aria-labelledby={`${productId}-boundary-title`}>
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <h2 id={`${productId}-boundary-title`} className="text-xl font-semibold">What it owns</h2>
            <p className="mt-3 max-w-[62ch] text-sm leading-6 text-muted-foreground">{product.boundary}</p>
          </div>
          <div>
            <h2 className="text-xl font-semibold">Current status</h2>
            <p className="mt-3 max-w-[62ch] text-sm leading-6 text-muted-foreground">{product.status}</p>
          </div>
        </div>
        <ul className="mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {product.points.slice(0, 6).map((point) => (
            <li key={point} className="flex items-start gap-3 text-sm leading-6 text-muted-foreground">
              <Check className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="pt-12" aria-labelledby={`${productId}-paths-title`}>
        <h2 id={`${productId}-paths-title`} className="text-3xl font-semibold tracking-[-0.02em]">Choose a path</h2>
        <div className="mt-7 border-y">
          {journeys.map((journey) => (
            <div key={journey.id} className="grid gap-5 border-b py-7 last:border-b-0 lg:grid-cols-[12rem_1fr]">
              <div>
                <p className="text-lg font-semibold">{journey.label}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{journeyById.get(journey.id)?.description}</p>
              </div>
              <div>
                <div className="grid gap-1 sm:grid-cols-2">
                  {journey.entries.slice(0, 6).map((entry) => (
                    <JourneyLink key={entry.slug} entry={entry} />
                  ))}
                </div>
                {journey.entries.length > 6 ? (
                  <details className="group/more mt-2 border-t pt-2">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 transition-transform group-open/more:rotate-180" aria-hidden="true" />
                      Show {journey.entries.length - 6} more {journey.label.toLowerCase()} pages
                    </summary>
                    <div className="mt-1 grid gap-1 sm:grid-cols-2">
                      {journey.entries.slice(6).map((entry) => (
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
      className="group flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{entry.navTitle}</span>
      <ArrowRight className="size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100" aria-hidden="true" />
    </Link>
  );
}

function ProductProof({ productId }: { productId: Exclude<ProductId, "start" | "project"> }) {
  if (productId === "desktop") {
    return (
      <figure className="overflow-hidden rounded-lg border bg-[oklch(0.13_0.014_205)]">
        <div className="flex h-10 items-center gap-2 border-b border-white/10 px-4 text-xs text-white/65">
          <CircleDot className="size-3.5 text-accent" aria-hidden="true" />
          Repository, conversation, and evidence in one workspace
        </div>
        <div className="relative aspect-[16/9]">
          <Image src="/anvil-app-homepage.png" alt="Anvil Desktop with repository navigation and an agent conversation." fill className="object-cover object-left-top" sizes="(min-width: 1280px) 896px, 100vw" priority />
        </div>
      </figure>
    );
  }

  if (productId === "registry") {
    const steps = [
      { label: "npm request", detail: "metadata or tarball", icon: PackageSearch },
      { label: "deterministic policy", detail: "signals and cached analysis", icon: ShieldCheck },
      { label: "recorded decision", detail: "allow, quarantine, or block", icon: FileCheck2 }
    ];
    return (
      <div className="rounded-lg border bg-muted/20 px-5 py-7">
        <ol className="grid gap-3 lg:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.label} className="relative flex min-h-28 items-start gap-4 border-t pt-4 lg:border-t-0 lg:pt-0">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-[oklch(var(--accent)/0.14)] text-foreground">
                <step.icon className="size-5 text-accent" aria-hidden="true" />
              </span>
              <span>
                <span className="block font-mono text-xs text-muted-foreground">0{index + 1}</span>
                <span className="mt-1 block font-semibold">{step.label}</span>
                <span className="mt-1 block text-sm leading-5 text-muted-foreground">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-5 border-t pt-5 text-sm leading-6 text-muted-foreground">
          LLM review can explain the evidence. Deterministic policy remains the enforcement authority.
        </p>
      </div>
    );
  }

  if (productId === "cloud") {
    return (
      <div className="overflow-hidden rounded-lg bg-[oklch(0.145_0.014_205)] text-[oklch(0.94_0.008_205)]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-xs text-white/60">
          <span>src/cells/orders.cell.ts</span>
          <span>contract → manifest → runtime</span>
        </div>
        <pre className="overflow-x-auto p-5 font-mono text-[0.8125rem] leading-7"><code>{`export const Orders = cell({
  queries: { listOrders },
  mutations: { createOrder },
  capabilities: ["database"]
});

$ anvil cloud check --json
{ "buildReady": true }`}</code></pre>
      </div>
    );
  }

  return (
    <div className="grid overflow-hidden rounded-lg border md:grid-cols-2">
      <div className="bg-background p-6">
        <Container className="size-5 text-accent" aria-hidden="true" />
        <h3 className="mt-4 text-xl font-semibold">Safe mode</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Install dependencies with lifecycle scripts disabled.</p>
        <code className="mt-5 block overflow-x-auto rounded-md bg-muted px-3 py-3 font-mono text-xs">anvil-npm-ci-safe</code>
      </div>
      <div className="border-t bg-muted/25 p-6 md:border-l md:border-t-0">
        <FileCheck2 className="size-5 text-accent" aria-hidden="true" />
        <h3 className="mt-4 text-xl font-semibold">Observed mode</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Run lifecycle scripts deliberately and write an inspection report.</p>
        <code className="mt-5 block overflow-x-auto rounded-md bg-background px-3 py-3 font-mono text-xs">anvil-npm-ci-observed</code>
      </div>
    </div>
  );
}
