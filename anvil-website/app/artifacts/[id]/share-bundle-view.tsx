"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { SandboxedHtml } from "./sandboxed-html";

/**
 * Policy injected ahead of an interactive document. The frame is also
 * sandboxed with `allow-scripts` only, so its origin is opaque: no
 * cookies, storage, popups, forms, modals or top-level navigation.
 */
const INTERACTIVE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

const MIN_FRAME_HEIGHT = 80;
const MAX_FRAME_HEIGHT = 4000;

interface AnvilShareBundle {
  format: "anvil-share/v1";
  title: string;
  kind: string;
  version: number;
  sharedAt: string;
  digest: string;
  snapshot: { html: string; css: string; images?: Record<string, string>; height?: number };
  interactive?: { html: string; kitVersion?: string };
}

function parseBundle(text: string): AnvilShareBundle | null {
  try {
    const value = JSON.parse(text) as Partial<AnvilShareBundle> | null;
    if (
      !value ||
      value.format !== "anvil-share/v1" ||
      typeof value.title !== "string" ||
      typeof value.kind !== "string" ||
      !value.snapshot ||
      typeof value.snapshot.html !== "string" ||
      typeof value.snapshot.css !== "string"
    ) {
      return null;
    }
    if (value.interactive !== undefined && typeof value.interactive?.html !== "string") return null;
    return value as AnvilShareBundle;
  } catch {
    return null;
  }
}

/** "artifact:html" → "HTML page", "surface:review" → "Review". */
export function bundleKindLabel(kind: string): string {
  const [family, name = ""] = kind.split(":");
  if (family === "artifact") {
    if (name === "html") return "HTML page";
    if (name === "mermaid" || name === "diagram") return "Diagram";
  }
  if (!name) return "Shared item";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Builds the interactive frame's document: the CSP meta goes first (right
 * after a doctype, so the page keeps standards mode), so it applies before
 * any of the shared document's own markup or scripts are parsed.
 */
function interactiveDocument(html: string): string {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${INTERACTIVE_POLICY}">${body}`;
}

function sizeFromMessage(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { method?: unknown; params?: unknown };
  if (message.method !== "ui/notifications/size-changed") return null;
  const params = message.params as { height?: unknown } | undefined;
  const height = params?.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)));
}

function InteractiveFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const srcDoc = useMemo(() => interactiveDocument(html), [html]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame may resize itself; any other window is ignored.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const next = sizeFromMessage(event.data);
      if (next !== null) setHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <iframe
      ref={frame}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      title={`${title} (interactive)`}
      style={{ height: `${height}px` }}
      className="w-full rounded-lg border bg-white"
    />
  );
}

/**
 * Renders a decrypted share bundle: the static, script-free snapshot
 * always; for interactive bundles, a trust interstitial and then — only
 * if the reader chooses — the full document in a scripts-only sandbox.
 */
export function ShareBundleView({ text, fallbackTitle }: { text: string; fallbackTitle: string }) {
  const bundle = useMemo(() => parseBundle(text), [text]);
  const [loadInteractive, setLoadInteractive] = useState(false);
  const digestId = useId();
  const warningId = useId();

  if (bundle === null) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This share uses a format this page doesn’t understand. Ask the sender to share it again
          from an up-to-date version of Anvil.
        </p>
      </div>
    );
  }

  const title = bundle.title || fallbackTitle;
  const showInteractive = bundle.interactive !== undefined && loadInteractive;

  return (
    <div className="space-y-4">
      {bundle.digest && (
        <p id={digestId} className="text-sm leading-6 text-muted-foreground">
          {bundle.digest}
        </p>
      )}

      {bundle.interactive && !loadInteractive && (
        <section
          aria-labelledby={warningId}
          className="rounded-lg border bg-muted/50 p-4"
        >
          <h2 id={warningId} className="text-sm font-semibold">
            This share runs interactive code
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            This page runs code that came with the link. Only continue if you trust the person who
            shared it. It can&apos;t access your Anvil account, this site&apos;s cookies, or the
            network.
          </p>
          <Button className="mt-3" onClick={() => setLoadInteractive(true)}>
            Load interactive version
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Below is a static snapshot taken when it was shared. It runs no code.
          </p>
        </section>
      )}

      {showInteractive && bundle.interactive ? (
        <div>
          <InteractiveFrame html={bundle.interactive.html} title={title} />
          <button
            type="button"
            onClick={() => setLoadInteractive(false)}
            className="mt-2 text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
          >
            Back to the static snapshot
          </button>
        </div>
      ) : (
        <SandboxedHtml
          html={bundle.snapshot.html}
          css={bundle.snapshot.css}
          images={bundle.snapshot.images}
          height={bundle.snapshot.height}
          title={bundle.interactive ? `${title} (static snapshot)` : title}
          describedBy={bundle.digest ? digestId : undefined}
        />
      )}
    </div>
  );
}
