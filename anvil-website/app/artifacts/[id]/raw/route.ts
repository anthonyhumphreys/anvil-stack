import { fetchSharedArtifact } from "@/lib/hosted/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilename(title: string, mediaType: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "artifact";
  if (/\.[a-z0-9]{1,8}$/i.test(base)) return base;
  const ext =
    mediaType === "text/markdown"
      ? ".md"
      : mediaType === "text/html"
        ? ".html"
        : mediaType === "text/csv"
          ? ".csv"
          : mediaType === "application/json"
            ? ".json"
            : mediaType === "application/pdf"
              ? ".pdf"
              : mediaType.includes("wordprocessingml")
                ? ".docx"
                : mediaType.includes("presentationml")
                  ? ".pptx"
                  : mediaType.includes("spreadsheetml")
                    ? ".xlsx"
                    : mediaType === "text/vnd.mermaid"
                      ? ".mmd"
                      : ".txt";
  return `${base}${ext}`;
}

/**
 * Download proxy for shared artifacts: streams the backend's bytes with a
 * content-disposition filename derived from the share title.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  let upstream: Response;
  try {
    upstream = await fetchSharedArtifact(id);
  } catch {
    return new Response("Unavailable", { status: 502 });
  }
  if (!upstream.ok || upstream.body === null) {
    return new Response("Not found", { status: 404 });
  }
  // Sealed shares carry ciphertext: serve them as opaque binary so a
  // direct /raw download never lands a ".md" full of encrypted bytes.
  const sealed = upstream.headers.get("x-anvil-share-sealed") === "1";
  const mediaType = sealed
    ? "application/octet-stream"
    : (upstream.headers.get("content-type") ?? "application/octet-stream");
  const titleHeader = upstream.headers.get("x-anvil-share-title");
  const title = titleHeader === null ? "artifact" : decodeURIComponent(titleHeader);
  const headers = new Headers();
  headers.set("content-type", mediaType);
  const filename = sealed
    ? `${safeFilename(title, mediaType).replace(/\.[a-z0-9]{1,8}$/i, "")}.bin`
    : safeFilename(title, mediaType);
  headers.set("content-disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
  const length = upstream.headers.get("content-length");
  if (length !== null) headers.set("content-length", length);
  headers.set("cache-control", "private, no-store");
  return new Response(upstream.body, { headers });
}
