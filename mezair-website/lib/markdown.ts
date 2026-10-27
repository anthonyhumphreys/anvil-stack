import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.use({ gfm: true, breaks: false });

/**
 * Renders UNTRUSTED markdown (shared artifacts) to sanitized HTML.
 * marked does not sanitize — raw HTML, `javascript:` links, and
 * event-handler attributes pass straight through — so the output is
 * always run through an allowlist before it reaches
 * dangerouslySetInnerHTML on a site-origin page.
 *
 * Trusted doc content (lib/docs.ts) deliberately bypasses this; the
 * allowlist only permits the formatting tags the doc-markdown styles
 * cover.
 */
export async function renderSharedMarkdown(markdown: string): Promise<string> {
  const html = await marked.parse(markdown);
  return sanitizeHtml(html, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "code",
      "pre",
      "em",
      "strong",
      "del",
      "hr",
      "br",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "img"
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      th: ["align"],
      td: ["align"],
      code: ["class"]
    },
    allowedSchemes: ["https", "http", "mailto"],
    // Shared artifacts may inline images as data URIs; javascript: and
    // other scriptable schemes are rejected everywhere.
    allowedSchemesByTag: { img: ["https", "http", "data"] },
    allowProtocolRelative: false
  });
}
