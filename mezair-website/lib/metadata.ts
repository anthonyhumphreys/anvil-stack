import type { Metadata } from "next";

export const siteUrl = "https://mezair.dev";
export const siteName = "Mezair";

/**
 * Title, description, canonical URL and matching Open Graph and Twitter fields
 * for a public page. Social images come from the route's opengraph-image and
 * twitter-image files, which Next attaches automatically.
 */
export function pageMetadata({
  title,
  description,
  path,
  type = "website",
  image
}: {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
  /** Explicit card for routes that cannot hold an opengraph-image file (catch-all docs). */
  image?: { url: string; alt: string };
}): Metadata {
  const images = image ? [{ ...image, width: 1200, height: 630, type: "image/png" }] : undefined;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName, type, locale: "en_GB", ...(images ? { images } : {}) },
    twitter: { card: "summary_large_image", title, description, ...(images ? { images } : {}) }
  };
}
