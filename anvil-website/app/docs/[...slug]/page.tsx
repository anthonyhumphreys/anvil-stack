import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocsNav } from "@/components/site/docs-nav";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { getDoc, getDocs } from "@/lib/docs";

export async function generateStaticParams() {
  const docs = await getDocs();
  return docs.map((doc) => ({ slug: doc.segments }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = await getDoc(slug.join("/"));
  if (!doc) return {};
  return {
    title: `${doc.title} | Anvil Docs`,
    description: doc.description
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const activeSlug = slug.join("/");
  const [doc, docs] = await Promise.all([getDoc(activeSlug), getDocs()]);
  if (!doc) notFound();
  const index = docs.findIndex((entry) => entry.slug === activeSlug);
  const previous = index > 0 ? docs[index - 1] : undefined;
  const next = index >= 0 && index < docs.length - 1 ? docs[index + 1] : undefined;

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[17rem_1fr] lg:px-8">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-4 pr-2">
            <DocsNav docs={docs} activeSlug={activeSlug} />
          </div>
        </aside>
        <main className="min-w-0">
          <details className="group mb-8 rounded-lg border bg-muted/35 lg:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-5 py-3.5 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              Browse all docs
              <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 ease-out group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t px-2 pb-4 pt-4">
              <DocsNav docs={docs} activeSlug={activeSlug} />
            </div>
          </details>
          <article className="mx-auto max-w-3xl">
            <p className="mb-3 text-sm font-medium text-muted-foreground">{doc.product} / {doc.section}</p>
            <div className="doc-markdown" dangerouslySetInnerHTML={{ __html: doc.contentHtml }} />
            <div className="mt-12 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
              {previous ? (
                <Button asChild variant="outline">
                  <Link href={`/docs/${previous.slug}`}>
                    <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                    {previous.title}
                  </Link>
                </Button>
              ) : (
                <span />
              )}
              {next ? (
                <Button asChild>
                  <Link href={`/docs/${next.slug}`}>
                    {next.title}
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
            </div>
          </article>
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
