import { marked } from "marked";
import type { Metadata } from "next";

import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchSharedArtifact, HostedApiError } from "@/lib/hosted/client";
import { parseCsv, mediaTypeLabel, formatBytes } from "./csv";
import { SandboxedHtml } from "./sandboxed-html";
import { SealedShareView } from "./sealed-share-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared artifact | Anvil",
  description: "Anvilユーザーが共有したアーティファクト"
};

marked.use({ gfm: true, breaks: false });

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
          <h1 className="mt-6 text-2xl font-semibold">この共有リンクは利用できません</h1>
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
    return <UnavailablePage reason="共有リンクの形式が正しくありません。" />;
  }

  let upstream: Response;
  try {
    upstream = await fetchSharedArtifact(id);
  } catch (error) {
    if (error instanceof HostedApiError && error.code === "unconfigured") {
      return (
        <UnavailablePage reason="共有アーティファクトの配信は現在この環境では設定されていません。" />
      );
    }
    return (
      <UnavailablePage reason="配信サーバに接続できませんでした。時間をおいて再度お試しください。" />
    );
  }

  if (!upstream.ok) {
    return (
      <UnavailablePage reason="この共有リンクは取り消されたか、期限切れです。発行者に新しいリンクを確認してください。" />
    );
  }

  const mediaType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const titleHeader = upstream.headers.get("x-anvil-share-title");
  const title = titleHeader === null ? "Shared artifact" : decodeURIComponent(titleHeader);
  const expiresHeader = upstream.headers.get("x-anvil-share-expires-at");
  const expiresLabel =
    expiresHeader === null ? null : new Date(expiresHeader).toLocaleDateString("ja-JP");
  const byteLength = Number(upstream.headers.get("content-length") ?? "0");

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
                Shared artifact · {mediaTypeLabel(mediaType)} · 暗号化
              </Badge>
              {expiresLabel && (
                <span className="text-xs text-muted-foreground">共有期限: {expiresLabel}</span>
              )}
            </div>
            <h1 className="mt-4 text-2xl font-semibold leading-snug">{title}</h1>
            <p className="mt-2 text-xs text-muted-foreground">
              Anvilユーザーが共有したアーティファクトです。共有リンクは発行者が取り消せます。
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
    mediaType.startsWith("text/") || mediaType === "application/json";
  const text =
    isTextual && bytes.byteLength <= MAX_TEXT_BYTES
      ? new TextDecoder().decode(bytes)
      : null;

  let body: React.ReactNode;
  if (mediaType === "text/markdown" && text !== null) {
    const html = await marked.parse(text);
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
          {mediaTypeLabel(mediaType)}形式（{formatBytes(byteLength)}）はプレビューできません。
        </p>
        <Button asChild className="mt-4">
          <a href={`/artifacts/${id}/raw`}>ダウンロード</a>
        </Button>
      </div>
    );
  } else {
    const note =
      mediaType === "text/vnd.mermaid" ? "Mermaidソース（図としては未描画）" : null;
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
            {expiresLabel && (
              <span className="text-xs text-muted-foreground">共有期限: {expiresLabel}</span>
            )}
            <span className="text-xs text-muted-foreground">{formatBytes(byteLength)}</span>
            <a
              href={`/artifacts/${id}/raw`}
              className="ml-auto text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
            >
              元ファイルをダウンロード
            </a>
          </div>
          <h1 className="mt-4 text-2xl font-semibold leading-snug">{title}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Anvilユーザーが共有したアーティファクトです。共有リンクは発行者が取り消せます。
          </p>
          <div className="mt-6">{body}</div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
