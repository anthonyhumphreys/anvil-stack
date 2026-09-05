import { createHighlighterCore, createCssVariablesTheme } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { LRUCache } from 'lru-cache';
import DOMPurify from 'dompurify';

// Create CSS variables theme — emits var(--shiki-*) references defined in global.css
const cssVarsTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  variableDefaults: {},
  fontStyle: true,
});

const LANGUAGE_REGISTRY: Record<
  string,
  {
    id: string;
    grammar: () => Promise<{
      default: Parameters<Awaited<ReturnType<typeof createHighlighterCore>>['loadLanguage']>[0];
    }>;
  }
> = {
  typescript: { id: 'typescript', grammar: () => import('@shikijs/langs/typescript') },
  ts: { id: 'typescript', grammar: () => import('@shikijs/langs/typescript') },
  tsx: { id: 'typescript', grammar: () => import('@shikijs/langs/typescript') },
  javascript: { id: 'javascript', grammar: () => import('@shikijs/langs/javascript') },
  js: { id: 'javascript', grammar: () => import('@shikijs/langs/javascript') },
  jsx: { id: 'javascript', grammar: () => import('@shikijs/langs/javascript') },
  json: { id: 'json', grammar: () => import('@shikijs/langs/json') },
  css: { id: 'css', grammar: () => import('@shikijs/langs/css') },
  html: { id: 'html', grammar: () => import('@shikijs/langs/html') },
  htm: { id: 'html', grammar: () => import('@shikijs/langs/html') },
  python: { id: 'python', grammar: () => import('@shikijs/langs/python') },
  py: { id: 'python', grammar: () => import('@shikijs/langs/python') },
  csharp: { id: 'csharp', grammar: () => import('@shikijs/langs/csharp') },
  cs: { id: 'csharp', grammar: () => import('@shikijs/langs/csharp') },
  bash: { id: 'bash', grammar: () => import('@shikijs/langs/bash') },
  sh: { id: 'bash', grammar: () => import('@shikijs/langs/bash') },
  shell: { id: 'bash', grammar: () => import('@shikijs/langs/bash') },
  zsh: { id: 'bash', grammar: () => import('@shikijs/langs/bash') },
  yaml: { id: 'yaml', grammar: () => import('@shikijs/langs/yaml') },
  yml: { id: 'yaml', grammar: () => import('@shikijs/langs/yaml') },
  markdown: { id: 'markdown', grammar: () => import('@shikijs/langs/markdown') },
  md: { id: 'markdown', grammar: () => import('@shikijs/langs/markdown') },
  sql: { id: 'sql', grammar: () => import('@shikijs/langs/sql') },
  diff: { id: 'diff', grammar: () => import('@shikijs/langs/diff') },
};

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [cssVarsTheme],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

const MAX_HIGHLIGHT_CACHE_BYTES = 4_000_000;
const MAX_CACHEABLE_CODE_CHARS = 12_000;

const cache = new LRUCache<string, string>({
  maxSize: MAX_HIGHLIGHT_CACHE_BYTES,
  sizeCalculation: (value, key) => 2 * (value.length + key.length),
});

/**
 * Highlight code using Shiki. Returns sanitized HTML string.
 * Results are cached in an LRU cache for performance.
 */
export async function highlightCode(code: string, language: string): Promise<string> {
  const cacheable = code.length <= MAX_CACHEABLE_CODE_CHARS;
  const key = cacheable ? `${language}:${code}` : '';
  const cached = cacheable ? cache.get(key) : undefined;
  if (cached) return cached;

  try {
    const highlighter = await getHighlighter();
    const normalizedLanguage = language.trim().toLowerCase();
    const registryEntry = LANGUAGE_REGISTRY[normalizedLanguage];
    const resolvedLanguage = registryEntry?.id ?? normalizedLanguage;

    const loadedLangs = highlighter.getLoadedLanguages();
    if (!loadedLangs.includes(resolvedLanguage as any)) {
      if (registryEntry) {
        await highlighter.loadLanguage((await registryEntry.grammar()).default);
      } else {
        const plaintext = wrapPlaintext(code);
        if (cacheable) cache.set(key, plaintext);
        return plaintext;
      }
    }

    const html = highlighter.codeToHtml(code, {
      lang: resolvedLanguage,
      theme: 'css-variables',
    });

    // Sanitize with restrictive allowlist — defense-in-depth for Electron
    const sanitized = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['pre', 'code', 'span'],
      ALLOWED_ATTR: ['class', 'style'],
    });

    if (cacheable) cache.set(key, sanitized);
    return sanitized;
  } catch {
    // Total failure — return escaped plaintext
    return wrapPlaintext(code);
  }
}

/** Map common file extensions to Shiki language IDs */
export function extToLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    cs: 'csharp',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    json: 'json',
    css: 'css',
    html: 'html',
    htm: 'html',
    sql: 'sql',
  };
  return map[ext] ?? 'text';
}

function wrapPlaintext(code: string): string {
  const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre><code>${escaped}</code></pre>`;
}
