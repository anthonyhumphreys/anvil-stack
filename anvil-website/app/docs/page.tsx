import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import { DocsSearch } from "@/components/site/docs-search";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { getDocs, groupDocs, toSearchItems } from "@/lib/docs";
import { docsJourneys } from "@/lib/docs-navigation";
import { productLines } from "@/lib/site";

export const metadata = {
  title: "Docs | Anvil",
  description: "Documentation for Anvil Desktop, Cloud, Registry, and Node Base."
};

const journeyStarts = {
  learn: "/docs/overview",
  build: "/docs/desktop/installation",
  reference: "/docs/project/repositories"
} as const;

export default async function DocsIndexPage() {
  const docs = await getDocs();
  const groupedDocs = groupDocs(docs.filter((doc) => doc.kind !== "product"));

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="docs" />
      <main id="main-content">
        <section className="border-b py-14 sm:py-20">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,0.7fr)] lg:items-end lg:px-8">
            <div>
              <p className="text-sm font-medium text-accent">Anvil documentation</p>
              <h1 className="mt-4 max-w-3xl text-balance text-5xl font-semibold leading-[1.02] tracking-[-0.035em] sm:text-6xl">Find the right surface. Follow the work.</h1>
              <p className="mt-5 max-w-[65ch] text-pretty text-lg leading-8 text-muted-foreground">Choose a product when you know where you are working, or a path when you know what you need to do.</p>
            </div>
            <DocsSearch docs={toSearchItems(docs)} className="min-h-14 text-base" />
          </div>
        </section>

        <section className="border-b py-12" aria-labelledby="paths-heading">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <h2 id="paths-heading" className="text-3xl font-semibold tracking-[-0.02em]">Choose a path</h2>
            <div className="mt-7 border-y">
              {docsJourneys.map((journey, index) => (
                <Link key={journey.id} href={journeyStarts[journey.id]} className="group grid gap-4 border-b py-6 last:border-b-0 sm:grid-cols-[3rem_10rem_1fr_auto] sm:items-center">
                  <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
                  <span className="text-xl font-semibold">{journey.label}</span>
                  <span className="max-w-2xl text-sm leading-6 text-muted-foreground">{journey.description}</span>
                  <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-accent" aria-hidden="true" />
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b bg-muted/20 py-14" aria-labelledby="products-heading">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl"><h2 id="products-heading" className="text-3xl font-semibold tracking-[-0.02em]">Documentation by product</h2><p className="mt-3 text-sm leading-6 text-muted-foreground">Each product has its own overview, status, proof, and local navigation.</p></div>
            <div className="mt-8 border-y">
              {productLines.map((product) => (
                <article key={product.id} className="grid gap-5 border-b py-7 last:border-b-0 lg:grid-cols-[13rem_minmax(0,1fr)_15rem] lg:items-center">
                  <div><product.icon className="size-5 text-accent" aria-hidden="true" /><h3 className="mt-3 text-lg font-semibold">{product.title}</h3><p className="mt-1 font-mono text-xs text-muted-foreground">{product.repoName}</p></div>
                  <div><p className="max-w-[68ch] text-sm leading-6 text-muted-foreground">{product.boundary}</p><code className="mt-3 inline-block rounded-md bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">{product.command}</code></div>
                  <div className="flex flex-col items-start gap-2 lg:items-end"><Link href={`/docs/${product.id}`} className="group inline-flex min-h-11 items-center gap-2 font-medium">Open {product.title.replace("Anvil ", "")} docs<ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden="true" /></Link><Link href={product.repoHref} className="text-sm text-muted-foreground hover:text-foreground">Repository</Link></div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-12">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <details className="group border-y">
              <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">Browse every page<ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
              <div className="border-t">
                {groupedDocs.map(({ product, sections }) => (
                  <div key={product} className="grid gap-6 border-b py-8 last:border-b-0 lg:grid-cols-[13rem_1fr]">
                    <h3 className="font-semibold">{product}</h3>
                    <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">{sections.map(([section, entries]) => <div key={`${product}-${section}`}><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{section}</p><ul className="mt-3 grid gap-2">{entries.map((entry) => <li key={entry.slug}><Link href={`/docs/${entry.slug}`} className="text-sm text-muted-foreground hover:text-foreground">{entry.navTitle}</Link></li>)}</ul></div>)}</div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
