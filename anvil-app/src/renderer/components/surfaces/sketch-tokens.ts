import { useEffect, useState } from 'react';
import {
  DEFAULT_SKETCH_TOKENS,
  inferSketchColorScheme,
  type SketchTokenName,
  type SketchTokenSet,
} from '../../../shared/surfaces/sketch-runtime';

/** Where each sketch token comes from in the active app theme. */
const TOKEN_SOURCES: Record<SketchTokenName, string> = {
  '--anvil-canvas': '--color-bg-primary',
  '--anvil-surface': '--color-bg-secondary',
  '--anvil-surface-raised': '--color-bg-tertiary',
  '--anvil-border': '--color-border',
  '--anvil-focus': '--color-accent',
  '--anvil-ink': '--color-text-primary',
  '--anvil-ink-secondary': '--color-text-secondary',
  '--anvil-ink-muted': '--color-text-tertiary',
  '--anvil-accent': '--color-accent',
  '--anvil-on-accent': '--color-accent-foreground',
  '--anvil-success': '--color-success',
  '--anvil-warning': '--color-warning',
  '--anvil-info': '--color-info',
  '--anvil-error': '--color-error',
  '--anvil-code-bg': '--color-bg-tertiary',
  '--anvil-code-ink': '--color-text-primary',
  '--anvil-series-1': '--color-info',
  '--anvil-series-2': '--color-success',
  '--anvil-series-3': '--color-warning',
  '--anvil-series-4': '--color-persona-docs',
  '--anvil-series-5': '--color-error',
  '--anvil-series-6': '--color-text-tertiary',
  '--anvil-radius-sm': '--radius-sm',
  '--anvil-radius-md': '--radius-md',
  '--anvil-radius-lg': '--radius-lg',
  '--anvil-radius-xl': '--radius-xl',
  '--anvil-font-sans': '--font-sans',
  '--anvil-font-mono': '--font-mono',
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
