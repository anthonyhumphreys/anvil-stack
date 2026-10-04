"use client";

import DOMPurify from "dompurify";
import { useEffect, useRef } from "react";

const PREVIEW_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'";

/**
 * Shared-HTML preview. The sandbox attribute deliberately omits
 * allow-scripts and allow-same-origin: shared markup renders as an
 * opaque-origin static document — no scripts, no storage, no forms.
 */
export function SandboxedHtml({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    // Strip navigation directives as well as executable markup before adding
    // a policy that blocks image, stylesheet and nested-frame network requests.
    const sanitized = DOMPurify.sanitize(html, {
      WHOLE_DOCUMENT: true,
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["meta", "base", "link", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["srcset"]
    });
    if (frame.current) {
      frame.current.srcdoc = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${sanitized}`;
    }
  }, [html]);

  return (
    <iframe
      sandbox=""
      ref={frame}
      srcDoc=""
      referrerPolicy="no-referrer"
      title={title}
      className="h-[70vh] w-full rounded-lg border bg-white"
    />
  );
}
