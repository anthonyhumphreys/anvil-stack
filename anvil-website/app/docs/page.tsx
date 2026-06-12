import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { Button } from "@/components/ui/button";
import { getDocs, groupDocs } from "@/lib/docs";
import { docsProductGuides } from "@/lib/site";

export const metadata = {
  title: "Docs | Anvil",
  description: "Documentation for Anvil Desktop, Anvil Registry, Anvil Node Base, and Anvil Cloud."
};

export default async function DocsIndexPage() {
  const docs = await getDocs();
  const groupedDocs = groupDocs(docs);

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main>
        <section className="border-b bg-muted/20 py-14">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.72fr_1.28fr] lg:px-8">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Anvil documentation</p>
              <h1 className="mt-3 max-w-3xl text-5xl font-semibold leading-tight tracking-normal sm:text-6xl">
                Pick the boundary, then read the mechanics.
              </h1>
            </div>
            <div className="max-w-3xl self-end">
              <p className="text-lg leading-8 text-muted-foreground">
                These docs are written for developers and maintainers. They explain what each repo owns, how to run it locally, where policy and runtime boundaries sit, and what is still alpha.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/docs/overview">
                    Start at overview
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/docs/project/repositories">Monorepo map</Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="grid gap-4 lg:grid-cols-4">
              {docsProductGuides.map((guide) => (
                <article key={guide.product} className="flex flex-col rounded-lg border bg-card p-5 shadow-sm">
                  <guide.icon className="size-5 text-accent" aria-hidden="true" />
                  <h2 className="mt-4 text-xl font-semibold tracking-normal">{guide.product}</h2>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{guide.repoName}</p>
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">{guide.description}</p>
                  <div className="mt-5 grid gap-2 text-sm">
                    {guide.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                  <Button asChild size="sm" className="mt-5">
                    <Link href={guide.href}>
                      Open docs
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-normal">Full index</h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Every page is markdown under <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs">content/docs</code>.
              </p>
            </div>
            <div className="mt-10 flex flex-col">
              {groupedDocs.map(({ product, sections }) => (
                <div
                  key={product}
                  className="grid gap-x-10 gap-y-4 border-t py-8 lg:grid-cols-[14rem_1fr]"
                >
                  <h3 className="text-lg font-semibold tracking-normal">{product}</h3>
                  <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                    {sections.map(([section, entries]) => (
                      <div key={`${product}-${section}`} className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{section}</p>
                        <ul className="mt-2.5 flex flex-col gap-1">
                          {entries.map((entry) => (
                            <li key={entry.slug}>
                              <Link
                                href={`/docs/${entry.slug}`}
                                className="inline-block rounded-sm py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              >
                                {entry.navTitle}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
