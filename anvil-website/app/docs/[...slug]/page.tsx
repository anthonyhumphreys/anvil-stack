import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { DocsNav } from "@/components/site/docs-nav";
import { DocsSearch } from "@/components/site/docs-search";
import { DocsTableOfContents } from "@/components/site/docs-table-of-contents";
import { ProductDocsLanding } from "@/components/site/product-docs-landing";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { getDoc, getDocs, toSearchItems } from "@/lib/docs";
import { journeyById, productById, type ProductId } from "@/lib/docs-navigation";

export async function generateStaticParams() {
  return (await getDocs()).map((doc) => ({ slug: doc.segments }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const doc = await getDoc((await params).slug.join("/"));
  return doc ? { title: `${doc.title} | Anvil Docs`, description: doc.description } : {};
}

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const activeSlug = (await params).slug.join("/");
  const [doc, docs] = await Promise.all([getDoc(activeSlug), getDocs()]);
  if (!doc) notFound();

  const product = productById.get(doc.productId);
  const journey = journeyById.get(doc.journey);
  const productDocs = docs.filter((entry) => entry.productId === doc.productId && entry.kind !== "product");
  const index = productDocs.findIndex((entry) => entry.slug === activeSlug);
  const previous = index > 0 ? productDocs[index - 1] : undefined;
  const next = index >= 0 && index < productDocs.length - 1 ? productDocs[index + 1] : undefined;
  const productLandingId = doc.kind === "product" && isProductLandingId(doc.productId) ? doc.productId : undefined;

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="docs" />
      <div className="mx-auto grid max-w-[90rem] grid-cols-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:px-8 xl:grid-cols-[16rem_minmax(0,48rem)_13rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pb-6 pr-3">
            <DocsSearch docs={toSearchItems(docs)} />
            <div className="mt-6"><DocsNav docs={docs} activeSlug={activeSlug} productId={doc.productId} /></div>
          </div>
        </aside>

        <main id="main-content" className="min-w-0">
          <div className="mb-5 lg:hidden"><DocsSearch docs={toSearchItems(docs)} /></div>
          <details className="group mb-7 rounded-lg border bg-muted/25 lg:hidden">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <span><span className="text-muted-foreground">{product?.shortLabel}</span> · {doc.navTitle}</span>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t px-2 py-4"><DocsNav docs={docs} activeSlug={activeSlug} productId={doc.productId} /></div>
          </details>

          {productLandingId ? (
            <ProductDocsLanding productId={productLandingId} docs={docs} />
          ) : (
            <article className="mx-auto max-w-3xl">
              <nav aria-label="Breadcrumb" className="mb-7 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Link href="/docs" className="hover:text-foreground">Docs</Link><span aria-hidden="true">/</span>
                {product ? <><Link href={product.href} className="hover:text-foreground">{product.shortLabel}</Link><span aria-hidden="true">/</span></> : null}
                <span>{journey?.label}</span><span aria-hidden="true">/</span><span aria-current="page" className="text-foreground">{doc.navTitle}</span>
              </nav>
              <div className="doc-markdown" dangerouslySetInnerHTML={{ __html: doc.contentHtml }} />
              <nav aria-label="Previous and next pages" className="mt-14 grid gap-3 border-t pt-6 sm:grid-cols-2">
                {previous ? <DocPager doc={previous} direction="previous" /> : <span />}
                {next ? <DocPager doc={next} direction="next" /> : null}
              </nav>
            </article>
          )}
        </main>

        {!productLandingId && doc.headings.length > 1 ? (
          <aside className="hidden xl:block"><div className="sticky top-24"><DocsTableOfContents headings={doc.headings} /></div></aside>
        ) : <span className="hidden xl:block" />}
      </div>
      <SiteFooter />
    </div>
  );
}

function isProductLandingId(productId: ProductId): productId is Exclude<ProductId, "start" | "project"> {
  return productId !== "start" && productId !== "project";
}

function DocPager({ doc, direction }: { doc: { slug: string; navTitle: string }; direction: "previous" | "next" }) {
  const next = direction === "next";
  return (
    <Link href={`/docs/${doc.slug}`} className={`group rounded-lg border p-4 transition-colors hover:border-accent/60 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${next ? "text-right" : ""}`}>
      <span className={`flex items-center gap-2 text-xs text-muted-foreground ${next ? "justify-end" : ""}`}>
        {!next && <ArrowLeft className="size-3.5" aria-hidden="true" />}{next ? "Next" : "Previous"}{next && <ArrowRight className="size-3.5" aria-hidden="true" />}
      </span>
      <span className="mt-2 block text-sm font-medium">{doc.navTitle}</span>
    </Link>
  );
}
