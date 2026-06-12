import { createHighlighterCore, createCssVariablesTheme } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { LRUCache } from 'lru-cache';
import DOMPurify from 'dompurify';

// Static language imports — Vite can statically analyze these (no dynamic template literals)
import langTypescript from '@shikijs/langs/typescript';
import langJavascript from '@shikijs/langs/javascript';
import langJson from '@shikijs/langs/json';
import langCss from '@shikijs/langs/css';
import langHtml from '@shikijs/langs/html';
import langPython from '@shikijs/langs/python';
import langCsharp from '@shikijs/langs/csharp';
import langBash from '@shikijs/langs/bash';
import langYaml from '@shikijs/langs/yaml';
import langMarkdown from '@shikijs/langs/markdown';
import langSql from '@shikijs/langs/sql';
import langDiff from '@shikijs/langs/diff';

const DEFAULT_LANGS = [
  langTypescript,
  langJavascript,
  langJson,
  langCss,
  langHtml,
  langPython,
  langCsharp,
  langBash,
  langYaml,
  langMarkdown,
  langSql,
  langDiff,
];

// Create CSS variables theme — emits var(--shiki-*) references defined in global.css
const cssVarsTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  variableDefaults: {},
  fontStyle: true,
});

const LANGUAGE_REGISTRY: Record<string, { id: string; grammar: unknown }> = {
  typescript: { id: 'typescript', grammar: langTypescript },
  ts: { id: 'typescript', grammar: langTypescript },
  tsx: { id: 'typescript', grammar: langTypescript },
  javascript: { id: 'javascript', grammar: langJavascript },
  js: { id: 'javascript', grammar: langJavascript },
  jsx: { id: 'javascript', grammar: langJavascript },
  json: { id: 'json', grammar: langJson },
  css: { id: 'css', grammar: langCss },
  html: { id: 'html', grammar: langHtml },
  htm: { id: 'html', grammar: langHtml },
  python: { id: 'python', grammar: langPython },
  py: { id: 'python', grammar: langPython },
  csharp: { id: 'csharp', grammar: langCsharp },
  cs: { id: 'csharp', grammar: langCsharp },
  bash: { id: 'bash', grammar: langBash },
  sh: { id: 'bash', grammar: langBash },
  shell: { id: 'bash', grammar: langBash },
  zsh: { id: 'bash', grammar: langBash },
  yaml: { id: 'yaml', grammar: langYaml },
  yml: { id: 'yaml', grammar: langYaml },
  markdown: { id: 'markdown', grammar: langMarkdown },
  md: { id: 'markdown', grammar: langMarkdown },
  sql: { id: 'sql', grammar: langSql },
  diff: { id: 'diff', grammar: langDiff },
};

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [cssVarsTheme],
      langs: DEFAULT_LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

const MAX_HIGHLIGHT_CACHE_BYTES = 4_000_000;
const MAX_CACHEABLE_CODE_CHARS = 12_000;

const cache = new LRUCache<string, string>({
  maxSize: MAX_HIGHLIGHT_CACHE_BYTES,
  sizeCalculation: (value, key) => value.length + key.length,
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
        await highlighter.loadLanguage(
          registryEntry.grammar as Parameters<typeof highlighter.loadLanguage>[0],
        );
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
