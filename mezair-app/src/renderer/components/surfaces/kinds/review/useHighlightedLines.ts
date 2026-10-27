import { useEffect, useState } from 'react';

/** Splits shiki's `<pre><code><span class="line">…` output into per-line inner HTML. */
export function splitHighlightedLines(html: string): string[] | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = Array.from(doc.querySelectorAll('code > .line'));
  return lines.length ? lines.map((line) => line.innerHTML) : null;
}

/**
 * Highlights a block of source lines with the shared (sanitised, cached) shiki
 * highlighter and returns one HTML string per line, or null until ready / when
 * the language is unknown. Shiki loads lazily so inline surfaces stay cheap.
 */
export function useHighlightedLines(lines: readonly string[], language: string): string[] | null {
  const [html, setHtml] = useState<string[] | null>(null);
  const code = lines.join('\n');

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    if (!code || language === 'text') return;
    void import('../../../chat/shiki')
      .then(({ highlightCode }) => highlightCode(code, language))
      .then((result) => {
        if (cancelled) return;
        const split = splitHighlightedLines(result);
        setHtml(split && split.length === lines.length ? split : null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return html;
}
