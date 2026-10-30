"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useState } from "react";

/** Format agent replies without allowing scripts, embedded content or remote images. */
export function WorkspaceMessageContent({ content }: { content: string }) {
  const [rendered, setRendered] = useState<{ content: string; html: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(marked.parse(content, { gfm: true })).then((html) => {
      if (cancelled) return;
      setRendered({
        content,
        html: DOMPurify.sanitize(html, {
          ALLOWED_TAGS: [
            "p", "br", "strong", "em", "del", "a", "code", "pre", "blockquote",
            "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
            "table", "thead", "tbody", "tr", "th", "td",
          ],
          ALLOWED_ATTR: ["href", "title"],
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
        }),
      });
    });
    return () => { cancelled = true; };
  }, [content]);

  // Never show an old reply while a different machine's message is being formatted.
  if (rendered?.content !== content) return <span className="whitespace-pre-wrap">{content}</span>;

  return (
    <div
      className="min-w-0 whitespace-normal break-words [&>*+*]:mt-3 [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_li+li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted/40 [&_pre]:p-3 [&_pre]:whitespace-pre [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
