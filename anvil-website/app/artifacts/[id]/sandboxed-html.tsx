"use client";

/**
 * Shared-HTML preview. The sandbox attribute deliberately omits
 * allow-scripts and allow-same-origin: shared markup renders as an
 * opaque-origin static document — no scripts, no storage, no forms.
 */
export function SandboxedHtml({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      sandbox=""
      srcDoc={html}
      title={title}
      className="h-[70vh] w-full rounded-lg border bg-white"
    />
  );
}
