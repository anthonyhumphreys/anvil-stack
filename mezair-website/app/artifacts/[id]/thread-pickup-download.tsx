"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { MezairShareBundle } from "@/lib/share-bundle";
import { buildThreadPickupPackage, threadPickupFilename } from "@/lib/thread-pickup";

export function ThreadPickupDownload({ bundle, shareId }: { bundle: MezairShareBundle; shareId: string }) {
  const [downloaded, setDownloaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (bundle.continuation === undefined) {
    return <p className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">To pick up this thread in Mezair, ask the author to update the shared snapshot from a version that includes continuation data.</p>;
  }
  return (
    <section className="rounded-lg border bg-card p-4" aria-label="Pick up the thread">
      <h2 className="text-sm font-semibold">Continue in your own Mezair workspace</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">Download a readable copy of the shared conversation and selected context. Anyone with the file can read it; the link&apos;s organisation access, revocation and expiry do not apply to downloaded copies. You’ll review the import in Mezair before creating a new thread.</p>
      <Button className="mt-3" onClick={() => {
        setError(null);
        try {
          const pkg = buildThreadPickupPackage(bundle, shareId, window.location.origin);
          const url = URL.createObjectURL(new Blob([JSON.stringify(pkg)], { type: "application/octet-stream" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = threadPickupFilename(pkg.title);
          link.rel = "noreferrer";
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          setDownloaded(true);
        } catch {
          setError("This snapshot cannot be exported as a continuation package. Ask the author to update the shared link.");
        }
      }}>Pick up the thread</Button>
      {downloaded && <div className="mt-4 space-y-2 text-sm text-muted-foreground" role="status">
        <p>Open the downloaded .mezair-thread file in Mezair, or choose Pick up shared thread… from Mezair’s command palette and select it. Choose your workspace and agent, review the contents, then import.</p>
        <a href="mezair://pick-up-thread" rel="noreferrer" className="inline-block font-medium text-foreground underline underline-offset-4">Open Mezair</a>
        <p className="text-xs">Opening Mezair sends no share link or key. Select the downloaded file in the app. Importing does not start an agent run.</p>
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-muted-foreground">{error}</p>}
    </section>
  );
}
