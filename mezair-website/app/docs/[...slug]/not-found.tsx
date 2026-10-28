import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DocsSearch } from "@/components/site/docs-search";
import { getDocs, toSearchItems } from "@/lib/docs";

export default async function DocsNotFound() {
  const docs = await getDocs();
  return (
    <main id="main-content" className="mx-auto flex min-h-[70vh] max-w-2xl flex-col justify-center px-4 py-16 sm:px-6">
      <p className="font-mono text-sm text-accent">404 / docs</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-[-0.025em] sm:text-5xl">That page is not in the index.</h1>
      <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">It may have moved during the documentation refresh. Search by product, command, or heading.</p>
      <div className="mt-8"><DocsSearch docs={toSearchItems(docs)} className="min-h-14 text-base" /></div>
      <Link href="/docs" className="mt-6 inline-flex min-h-11 items-center gap-2 self-start text-sm font-medium"><ArrowLeft className="size-4" aria-hidden="true" />Back to documentation</Link>
    </main>
  );
}
