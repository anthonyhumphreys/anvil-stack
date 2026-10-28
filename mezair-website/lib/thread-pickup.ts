import { validateThreadPickupPackage, type ThreadPickupPackage } from "../../mezair-app/cloud/contract/thread-pickup";
import type { MezairShareBundle } from "./share-bundle";

/** Copy allowlisted, already-redacted fields only. Never accept the browser's full share URL. */
export function buildThreadPickupPackage(bundle: MezairShareBundle, shareId: string, viewerOrigin?: string): ThreadPickupPackage {
  if (bundle.kind !== "thread" || bundle.continuation === undefined) {
    throw new Error("Ask the author to update this shared snapshot before picking it up in Mezair.");
  }
  let viewerUrl: string | undefined;
  if (viewerOrigin !== undefined) {
    const origin = new URL(viewerOrigin).origin;
    if (origin.startsWith("https://")) viewerUrl = `${origin}/artifacts/${shareId}`;
  }
  return validateThreadPickupPackage({
    format: "mezair-thread/v1",
    title: bundle.title,
    sharedAt: bundle.sharedAt,
    source: { shareId, version: bundle.version, ...(viewerUrl ? { viewerUrl } : {}) },
    continuation: bundle.continuation,
    ...(bundle.files ? { files: bundle.files } : {}),
    snapshot: { html: bundle.snapshot.html, css: bundle.snapshot.css },
  });
}

export function threadPickupFilename(title: string): string {
  const name = title.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80) || "shared-thread";
  return `${name}.mezair-thread`;
}
