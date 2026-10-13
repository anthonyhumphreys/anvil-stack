import type { Metadata } from "next";

import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchSharedArtifact, HostedApiError } from "@/lib/hosted/client";
import { renderSharedMarkdown } from "@/lib/markdown";
import { parseCsv, mediaTypeLabel, formatBytes, SHARE_BUNDLE_MEDIA_TYPE } from "./csv";
import { SandboxedHtml } from "./sandboxed-html";
import { SealedShareView } from "./sealed-share-view";
import { ShareBundleView } from "./share-bundle-view";

function formatShareDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "Version 4 · updated 12 Nov 2026" once a share has been updated in place. */
function versionLine(headers: Headers): string | null {
  const version = Number(headers.get("x-anvil-share-version") ?? "1");
  const updatedAt = headers.get("x-anvil-share-updated-at");
  if (!updatedAt && !(Number.isInteger(version) && version > 1)) return null;
  const label = Number.isInteger(version) && version > 0 ? `Version ${version}` : "Updated";
  return updatedAt ? `${label} · updated ${formatShareDate(updatedAt)}` : label;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared artifact | Anvil",
  description: "An item shared from Anvil, decrypted in your browser."
};

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

function UnavailablePage({ reason }: { reason: string }) {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main id="main-content">
        <section className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
          <Badge variant="secondary" className="border bg-muted/70">
            Shared artifact
          </Badge>
          <h1 className="mt-6 text-2xl font-semibold">This share link isn&apos;t available</h1>
          <p className="mt-4 text-sm leading-7 text-muted-foreground">{reason}</p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

export default async function SharedArtifactPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return <UnavailablePage reason="This share link isn't in a valid format. Check that it was copied in full." />;
  }

  let upstream: Response;
  try {
    upstream = await fetchSharedArtifact(id);
  } catch (error) {
    if (error instanceof HostedApiError && error.code === "unconfigured") {
      return (
        <UnavailablePage reason="Shared items aren't served from this deployment: the hosted share service isn't configured." />
      );
    }
    return (
      <UnavailablePage reason="Couldn't reach the share service. Try again in a few minutes." />
    );
  }

  if (!upstream.ok) {
    return (
      <UnavailablePage reason="This link was revoked or has expired. Ask the person who shared it for a new link." />
    );
  }

  const mediaType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const titleHeader = upstream.headers.get("x-anvil-share-title");
  const title = titleHeader === null ? "Shared artifact" : decodeURIComponent(titleHeader);
  const expiresHeader = upstream.headers.get("x-anvil-share-expires-at");
  const expiresLabel =
    expiresHeader === null ? null : formatShareDate(expiresHeader);
  const byteLength = Number(upstream.headers.get("content-length") ?? "0");
  const updatedLabel = versionLine(upstream.headers);

  // Sealed shares: the stored bytes are ciphertext under a key carried in
  // the URL fragment — which never reaches this server. Render the shell
  // plus a client-side decryptor; the ciphertext body is never consumed
  // here.
  const sealed = upstream.headers.get("x-anvil-share-sealed") === "1";
  if (sealed) {
    const plaintextHeader = upstream.headers.get("x-anvil-share-plaintext-bytes");
    const sha256 = upstream.headers.get("x-anvil-share-sha256") ?? "";
    void upstream.body?.cancel().catch(() => undefined);
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <main id="main-content">
          <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="secondary" className="border bg-muted/70">
                Shared artifact · {mediaTypeLabel(mediaType)} · encrypted
              </Badge>
              {updatedLabel && (
                <span className="text-xs text-muted-foreground">{updatedLabel}</span>
              )}
              {expiresLabel && (
                <span className="text-xs text-muted-foreground">Expires {expiresLabel}</span>
              )}
            </div>
            <h1 className="mt-4 text-2xl font-semibold leading-snug">{title}</h1>
            <p className="mt-2 text-xs text-muted-foreground">
              Shared from Anvil. The person who shared it can revoke this link at any time.
            </p>
            <div className="mt-6">
              <SealedShareView
                id={id}
                mediaType={mediaType}
                title={title}
                sha256={sha256}
                plaintextBytes={
                  plaintextHeader === null ? null : Number(plaintextHeader)
                }
                ciphertextBytes={byteLength}
              />
            </div>
          </section>
        </main>
        <SiteFooter />
      </div>
    );
  }

  const bytes = await upstream.arrayBuffer();
  const isTextual =
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === SHARE_BUNDLE_MEDIA_TYPE;
  const text =
    isTextual && bytes.byteLength <= MAX_TEXT_BYTES
      ? new TextDecoder().decode(bytes)
      : null;

  let body: React.ReactNode;
  if (mediaType === SHARE_BUNDLE_MEDIA_TYPE && text !== null) {
    body = <ShareBundleView text={text} fallbackTitle={title} />;
  } else if (mediaType === "text/markdown" && text !== null) {
    const html = await renderSharedMarkdown(text);
    body = (
      <div
        className="doc-markdown rounded-lg border bg-card p-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } else if (mediaType === "text/html" && text !== null) {
    body = <SandboxedHtml html={text} title={title} />;
  } else if (mediaType === "text/csv" && text !== null) {
    const rows = parseCsv(text);
    const [head, ...rest] = rows;
    body = (
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-muted/70">
              {(head ?? []).map((cell, i) => (
                <th key={i} className="px-3 py-2 text-left font-medium">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rest.map((row, i) => (
              <tr key={i} className="border-b last:border-0 odd:bg-muted/30">
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-pre-wrap px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (mediaType === "application/pdf") {
    body = (
      <iframe
        src={`/artifacts/${id}/raw`}
        title={title}
        className="h-[80vh] w-full rounded-lg border"
      />
    );
  } else if (text === null) {
    body = (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {mediaTypeLabel(mediaType)} files ({formatBytes(byteLength)}) can&apos;t be previewed here.
        </p>
        <Button asChild className="mt-4">
          <a href={`/artifacts/${id}/raw`}>Download</a>
        </Button>
      </div>
    );
  } else {
    const note =
      mediaType === "text/vnd.mermaid" ? "Mermaid source (not rendered as a diagram)" : null;
    body = (
      <div>
        {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}
        <pre className="max-h-[80vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-xs leading-6">
          {text}
        </pre>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main id="main-content">
        <section className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary" className="border bg-muted/70">
              Shared artifact · {mediaTypeLabel(mediaType)}
            </Badge>
            {updatedLabel && (
              <span className="text-xs text-muted-foreground">{updatedLabel}</span>
            )}
            {expiresLabel && (
              <span className="text-xs text-muted-foreground">Expires {expiresLabel}</span>
            )}
            <span className="text-xs text-muted-foreground">{formatBytes(byteLength)}</span>
            <a
              href={`/artifacts/${id}/raw`}
              className="ml-auto text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
            >
              Download original file
            </a>
          </div>
          <h1 className="mt-4 text-2xl font-semibold leading-snug">{title}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Shared from Anvil. The person who shared it can revoke this link at any time.
          </p>
          <div className="mt-6">{body}</div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
