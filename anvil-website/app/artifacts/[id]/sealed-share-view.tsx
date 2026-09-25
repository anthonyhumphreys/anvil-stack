"use client";

import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { Button } from "@/components/ui/button";
import { mediaTypeLabel, formatBytes, parseCsv } from "./csv";
import { SandboxedHtml } from "./sandboxed-html";

type Status =
  | { kind: "working"; step: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; bytes: Uint8Array };

function base64UrlDecode(input: string): Uint8Array | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Client-side decryptor for sealed shares. The share key lives only in the
 * URL fragment (`#k=…`), which browsers never send to a server: this page
 * fetches the ciphertext, verifies the stored sha256, and opens the
 * AES-256-GCM blob (`nonce‖ct‖tag`) locally with WebCrypto. The server
 * only ever sees the share id and ciphertext.
 */
export function SealedShareView(props: {
  id: string;
  mediaType: string;
  title: string;
  sha256: string;
  plaintextBytes: number | null;
  ciphertextBytes: number;
}) {
  const [status, setStatus] = useState<Status>({ kind: "working", step: "decrypt" });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const keyParam = fragment.get("k");
      if (keyParam === null) {
        setStatus({
          kind: "error",
          message:
            "このリンクには復号キーが含まれていません。#以降の部分を含む完全なリンクを開いてください。",
        });
        return;
      }
      const key = base64UrlDecode(keyParam);
      if (key === null || key.byteLength !== 32) {
        setStatus({ kind: "error", message: "リンク内の復号キーが壊れています。" });
        return;
      }
      const response = await fetch(`/artifacts/${props.id}/raw`, { cache: "no-store" });
      if (!response.ok) {
        setStatus({
          kind: "error",
          message: "共有データを取得できませんでした。リンクが取り消された可能性があります。",
        });
        return;
      }
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const actual = await sha256Hex(ciphertext);
      if (actual !== props.sha256) {
        setStatus({ kind: "error", message: "取得したデータのチェックサムが一致しません。" });
        return;
      }
      let plain: ArrayBuffer;
      try {
        const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
          "decrypt",
        ]);
        plain = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: ciphertext.subarray(0, 12) as BufferSource,
            additionalData: new TextEncoder().encode(`anvil/share-seal/v1|${props.mediaType}`),
          },
          cryptoKey,
          ciphertext.subarray(12) as BufferSource,
        );
      } catch {
        setStatus({
          kind: "error",
          message: "復号に失敗しました。リンクのキーが正しくないか、データが改ざんされています。",
        });
        return;
      }
      const bytes = new Uint8Array(plain);
      if (props.plaintextBytes !== null && bytes.byteLength !== props.plaintextBytes) {
        setStatus({ kind: "error", message: "復号後のデータ長が一致しません。" });
        return;
      }
      if (!cancelled) setStatus({ kind: "ready", bytes });
    };
    void run().catch(() => {
      if (!cancelled) {
        setStatus({ kind: "error", message: "復号処理に失敗しました。" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.id, props.mediaType, props.sha256, props.plaintextBytes]);

  if (status.kind === "working") {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">ブラウザ内で復号しています…</p>
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">{status.message}</p>
      </div>
    );
  }

  const { bytes } = status;
  const isTextual = props.mediaType.startsWith("text/") || props.mediaType === "application/json";
  const text = isTextual ? new TextDecoder().decode(bytes) : null;

  let body: React.ReactNode;
  if (props.mediaType === "text/markdown" && text !== null) {
    body = <MarkdownBody text={text} />;
  } else if (props.mediaType === "text/html" && text !== null) {
    body = <SandboxedHtml html={text} title={props.title} />;
  } else if (props.mediaType === "text/csv" && text !== null) {
    const [head, ...rest] = parseCsv(text);
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
  } else if (props.mediaType === "application/pdf") {
    body = <PdfFrame bytes={bytes} title={props.title} />;
  } else if (text === null) {
    body = (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {mediaTypeLabel(props.mediaType)}形式（
          {formatBytes(props.plaintextBytes ?? bytes.byteLength)}
          ）はプレビューできません。
        </p>
        <Button asChild className="mt-4">
          <DownloadLink bytes={bytes} mediaType={props.mediaType} filename={props.title} />
        </Button>
      </div>
    );
  } else {
    const note = props.mediaType === "text/vnd.mermaid" ? "Mermaidソース（図としては未描画）" : null;
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
    <div>
      {body}
      <p className="mt-4 text-xs text-muted-foreground">
        このアーティファクトは発行者のデバイスで暗号化され、お使いのブラウザで復号されました。
        サーバは暗号文のみを保管しています。
      </p>
    </div>
  );
}

function MarkdownBody({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Shared markdown is untrusted: marked emits raw HTML, so the output
    // is sanitized in-browser before it reaches dangerouslySetInnerHTML.
    void Promise.resolve(marked.parse(text)).then((rendered: string) => {
      if (!cancelled) setHtml(DOMPurify.sanitize(rendered));
    });
    return () => {
      cancelled = true;
    };
  }, [text]);
  if (html === null) {
    return <p className="text-sm text-muted-foreground">レンダリングしています…</p>;
  }
  return (
    <div
      className="doc-markdown rounded-lg border bg-card p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function DownloadLink({
  bytes,
  mediaType,
  filename
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string;
}) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType })),
    [bytes, mediaType]
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <a href={url} download={filename}>
      復号してダウンロード
    </a>
  );
}

function PdfFrame({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" })),
    [bytes]
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <iframe src={url} title={title} className="h-[80vh] w-full rounded-lg border" />;
}
