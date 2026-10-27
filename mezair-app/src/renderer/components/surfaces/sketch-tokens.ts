import { useEffect, useState } from 'react';
import {
  DEFAULT_SKETCH_TOKENS,
  inferSketchColorScheme,
  type SketchTokenName,
  type SketchTokenSet,
} from '../../../shared/surfaces/sketch-runtime';

/** Where each sketch token comes from in the active app theme. */
const TOKEN_SOURCES: Record<SketchTokenName, string> = {
  '--mezair-canvas': '--color-bg-primary',
  '--mezair-surface': '--color-bg-secondary',
  '--mezair-surface-raised': '--color-bg-tertiary',
  '--mezair-border': '--color-border',
  '--mezair-focus': '--color-accent',
  '--mezair-ink': '--color-text-primary',
  '--mezair-ink-secondary': '--color-text-secondary',
  '--mezair-ink-muted': '--color-text-tertiary',
  '--mezair-accent': '--color-accent',
  '--mezair-on-accent': '--color-accent-foreground',
  '--mezair-success': '--color-success',
  '--mezair-warning': '--color-warning',
  '--mezair-info': '--color-info',
  '--mezair-error': '--color-error',
  '--mezair-code-bg': '--color-bg-tertiary',
  '--mezair-code-ink': '--color-text-primary',
  '--mezair-series-1': '--color-info',
  '--mezair-series-2': '--color-success',
  '--mezair-series-3': '--color-warning',
  '--mezair-series-4': '--color-persona-docs',
  '--mezair-series-5': '--color-error',
  '--mezair-series-6': '--color-text-tertiary',
  '--mezair-radius-sm': '--radius-sm',
  '--mezair-radius-md': '--radius-md',
  '--mezair-radius-lg': '--radius-lg',
  '--mezair-radius-xl': '--radius-xl',
  '--mezair-font-sans': '--font-sans',
  '--mezair-font-mono': '--font-mono',
};

/**
 * Derives the sketch token set from a computed-style reader, falling back to
 * the default light or dark values for anything the theme leaves unset.
 */
export function deriveSketchTokens(
  read: (cssVariable: string) => string,
  theme?: string | null,
): SketchTokenSet {
  const fallback = theme === 'light' ? DEFAULT_SKETCH_TOKENS.light : DEFAULT_SKETCH_TOKENS.dark;
  const tokens: SketchTokenSet = {};
  for (const [token, source] of Object.entries(TOKEN_SOURCES)) {
    const value = read(source).trim();
    tokens[token] = value || fallback[token] || '';
  }
  return tokens;
}

export function readActiveSketchTokens(root?: HTMLElement): SketchTokenSet {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return DEFAULT_SKETCH_TOKENS.dark;
  }
  const element = root ?? document.documentElement;
  const style = window.getComputedStyle(element);
  return deriveSketchTokens(
    (name) => style.getPropertyValue(name),
    element.getAttribute('data-theme'),
  );
}

export function sketchThemeName(tokens: SketchTokenSet): 'light' | 'dark' {
  return inferSketchColorScheme(tokens);
}

/** Live token set; re-reads when the html theme attributes change. */
export function useSketchTokens(): SketchTokenSet {
  const [tokens, setTokens] = useState<SketchTokenSet>(() => readActiveSketchTokens());

  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const next = readActiveSketchTokens(root);
      setTokens((current) => (sameTokens(current, next) ? current : next));
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => observer.disconnect();
  }, []);

  return tokens;
}

function sameTokens(left: SketchTokenSet, right: SketchTokenSet): boolean {
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) => left[key] === right[key]);
}
