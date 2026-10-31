import Link from "next/link";
import { ArrowRight, BookOpen, Compass, Wrench } from "lucide-react";
import { DocsSearch } from "@/components/site/docs-search";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { getDocs, toSearchItems } from "@/lib/docs";
import { pageMetadata } from "@/lib/metadata";
import { products } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Docs | Mezair",
  description: "Guides and reference for Mezair Desktop, Sync & Mesh, Registry, Node Base and Cloud.",
  path: "/docs"
});

const ways = [
  {
    icon: Compass,
    title: "New to Mezair",
    body: "What each part does, which one you need, and how they fit together.",
    href: "/docs/overview",
    cta: "Start here"
  },
  {
    icon: Wrench,
    title: "Setting it up",
    body: "Install the app, connect an agent, and take your first task from prompt to reviewed change.",
    href: "/docs/desktop/quickstart",
    cta: "Quickstart"
  },
  {
    icon: BookOpen,
    title: "Looking something up",
    body: "Commands, settings, limits and fixes for common problems.",
    href: "/docs/desktop/troubleshooting",
    cta: "Troubleshooting"
  }
];

export default async function DocsIndexPage() {
  const docs = await getDocs();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="docs" />
      <main id="main-content">
        <section className="page-shell pb-16 pt-16 sm:pt-24">
          <h1 className="font-display text-display-1 max-w-[13ch]">Everything you need to run Mezair.</h1>
          <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center">
            <p className="lede">
              Start with the part you&apos;re using, or search. Every page says plainly what works today
              and what doesn&apos;t yet.
            </p>
            <DocsSearch docs={toSearchItems(docs)} className="min-h-14 text-base" />
          </div>
        </section>

        <section className="border-t py-16 lg:py-20" aria-label="Ways in">
          <ul className="page-shell grid gap-4 md:grid-cols-3">
            {ways.map((way) => (
              <li key={way.title}>
                <Link
                  href={way.href}
                  className="group flex h-full flex-col rounded-xl border p-6 transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <way.icon className="size-5 text-accent" aria-hidden="true" />
                  <span className="mt-5 text-lg font-semibold">{way.title}</span>
                  <span className="mt-2 flex-1 text-[0.9375rem] leading-7 text-muted-foreground">{way.body}</span>
                  <span className="mt-5 inline-flex items-center gap-2 text-sm font-medium">
                    {way.cta}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t bg-muted/40 py-20 lg:py-24" aria-labelledby="products-heading">
          <div className="page-shell">
            <h2 id="products-heading" className="font-display text-display-2">By product</h2>
            <ul className="mt-12 divide-y border-y">
              {products.map((product) => (
                <li key={product.id} className="grid gap-5 py-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,5fr)_minmax(0,3fr)] lg:gap-10">
                  <div className="flex gap-4">
                    <product.icon className="mt-1 size-5 shrink-0 text-accent" aria-hidden="true" />
                    <div>
                      <h3 className="text-xl font-semibold">
                        <Link href={product.href} className="underline-offset-4 hover:underline">
                          {product.title}
                        </Link>
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">{product.statusLabel}</p>
                    </div>
                  </div>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{product.tagline}</p>
                  <ul className="grid gap-1.5 text-[0.9375rem]">
                    <li>
                      <Link href={product.startHref} className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground">
                        {product.startLabel}
                      </Link>
                    </li>
                    {product.links.slice(0, 2).map((link) => (
                      <li key={link.href}>
                        <Link href={link.href} className="text-muted-foreground hover:text-foreground">
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
