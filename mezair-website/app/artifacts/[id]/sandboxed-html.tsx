"use client";

import DOMPurify from "dompurify";
import { useEffect, useRef } from "react";

const PREVIEW_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 4000;

function resolveImages(html: string, images: Record<string, string> | undefined): string {
  if (!images) return html;
  return html.replace(/mezair-image:([A-Za-z0-9_.-]{1,128})/g, (match, key: string) => {
    const uri = images[key];
    return typeof uri === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(uri) ? uri : match;
  });
}

/**
 * Shared-HTML preview. The sandbox attribute deliberately omits
 * allow-scripts and allow-same-origin: shared markup renders as an
 * opaque-origin static document — no scripts, no storage, no forms.
 *
 * Because the frame is opaque and script-free, this page cannot measure
 * its content. When the sharer's app measured the snapshot (`height`),
 * the frame starts at that height; otherwise it uses a fixed height. The
 * frame is vertically resizable either way.
 */
export function SandboxedHtml({
  html,
  title,
  css,
  images,
  height,
  describedBy
}: {
  html: string;
  title: string;
  /** Extra stylesheet injected ahead of the markup (share bundle snapshots). */
  css?: string;
  /** Snapshot images, referenced from the markup as `mezair-image:<key>`. */
  images?: Record<string, string>;
  /** Measured content height in CSS px, when known. */
  height?: number;
  describedBy?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Strip navigation directives as well as executable markup before adding
    // a policy that blocks image, stylesheet and nested-frame network requests.
    const sanitized = DOMPurify.sanitize(resolveImages(html, images), {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["meta", "base", "link", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["srcset"]
    });
    const style = css ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : "";
    if (frame.current) {
      frame.current.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${style}${sanitized}`;
    }
  }, [html, css, images]);

  const sized =
    typeof height === "number" && Number.isFinite(height)
      ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height) + 4))
      : null;

  return (
    <iframe
      sandbox=""
      ref={frame}
      srcDoc=""
      referrerPolicy="no-referrer"
      title={title}
      aria-describedby={describedBy}
      style={sized === null ? undefined : { height: `${sized}px` }}
      className={`w-full resize-y rounded-lg border bg-white ${sized === null ? "h-[70vh]" : ""}`}
    />
  );
}
