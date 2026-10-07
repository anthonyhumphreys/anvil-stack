import type { MetadataRoute } from "next";

import { getDocs } from "@/lib/docs";

const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://anvil.dev";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const docs = await getDocs();
  const docEntries: MetadataRoute.Sitemap = docs.map((doc) => ({
    url: `${baseUrl}/docs/${doc.slug}`,
    changeFrequency: "weekly",
    priority: doc.kind === "product" ? 0.8 : 0.6
  }));

  return [
    { url: baseUrl, changeFrequency: "weekly", priority: 1 },
    { url: `${baseUrl}/sync`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/pricing`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/docs`, changeFrequency: "weekly", priority: 0.9 },
    ...docEntries
  ];
}
