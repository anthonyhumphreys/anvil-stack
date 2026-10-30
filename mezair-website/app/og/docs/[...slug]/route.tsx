import { getDoc, getDocs } from "@/lib/docs";
import { journeyById, productById } from "@/lib/docs-navigation";
import { renderCard } from "../../../_og/card";

/** Social card for one documentation page: /og/docs/<slug>. */
export async function generateStaticParams() {
  return (await getDocs()).map((doc) => ({ slug: doc.segments }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const doc = await getDoc((await params).slug.join("/"));
  if (!doc) return new Response("Not found", { status: 404 });
  const product = productById.get(doc.productId);
  const journey = journeyById.get(doc.journey);
  return renderCard({
    title: doc.title,
    description: doc.description,
    label: ["Docs", product?.shortLabel, journey?.label].filter(Boolean).join(" / "),
    facts: [`mezair.dev/docs/${doc.slug}`]
  });
}
