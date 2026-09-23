import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseColor, relativeLuminance } from '../contrast';

describe('parseColor', () => {
  it('parses six-digit hex', () => {
    expect(parseColor('#ff8a3d')).toEqual({ r: 255, g: 138, b: 61 });
  });

  it('parses three-digit hex shorthand', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#0b1')).toEqual({ r: 0, g: 187, b: 17 });
  });

  it('parses rgb() and ignores alpha in rgba()', () => {
    expect(parseColor('rgb(11, 16, 32)')).toEqual({ r: 11, g: 16, b: 32 });
    expect(parseColor('rgba(11, 16, 32, 0.5)')).toEqual({ r: 11, g: 16, b: 32 });
  });

  it('throws on unsupported values', () => {
    expect(() => parseColor('orange')).toThrow(/Unsupported colour/);
    expect(() => parseColor('var(--color-accent)')).toThrow(/Unsupported colour/);
  });
});

describe('relativeLuminance', () => {
  it('returns 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });
});

describe('contrastRatio', () => {
  it('returns 21:1 for black on white and 1:1 for identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ff8a3d', '#ff8a3d')).toBe(1);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#ffffff', '#ff8a3d')).toBeCloseTo(
      contrastRatio('#ff8a3d', '#ffffff'),
      10,
    );
  });

  it('documents the DS1 failure: white on the dark-theme accent fails AA', () => {
    // ~2.3:1 — below both 4.5:1 (normal) and 3:1 (large text).
    expect(contrastRatio('#ffffff', '#ff8a3d')).toBeLessThan(3);
  });

  it('passes AA for the dark canvas on the accent', () => {
    expect(contrastRatio('#0b1020', '#ff8a3d')).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Parse styles/global.css and collect the custom properties declared in the
 * default `@theme` block plus every `html[data-theme='…']` override block.
 * Blocks contain no nested braces, so a flat capture is sufficient; multiple
 * blocks for the same theme are merged.
 */
function themeVariables(css: string): Map<string, Map<string, string>> {
  const themes = new Map<string, Map<string, string>>();
  const merge = (name: string, body: string) => {
    const vars = themes.get(name) ?? new Map<string, string>();
    for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      vars.set(match[1], match[2].trim());
    }
    themes.set(name, vars);
  };

  const themeMatch = /@theme\s*\{([^}]*)\}/.exec(css);
  if (themeMatch) merge('default', themeMatch[1]);
  for (const match of css.matchAll(/html\[data-theme='([^']+)'\]\s*\{([^}]*)\}/g)) {
    merge(match[1], match[2]);
  }
  return themes;
}

describe('accent-foreground tokens (DS1)', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../styles/global.css', import.meta.url)),
    'utf8',
  );
  const themes = themeVariables(css);

  it('every theme defines both --color-accent and --color-accent-foreground', () => {
    expect(themes.size).toBeGreaterThanOrEqual(6);
    for (const [name, vars] of themes) {
      expect(vars.get('color-accent'), `theme "${name}"`).toBeTruthy();
      expect(vars.get('color-accent-foreground'), `theme "${name}"`).toBeTruthy();
    }
  });

  it('accent-foreground meets WCAG AA 4.5:1 on accent in every theme', () => {
    for (const [name, vars] of themes) {
      const accent = vars.get('color-accent');
      const foreground = vars.get('color-accent-foreground');
      if (!accent || !foreground) continue;
      expect(
        contrastRatio(foreground, accent),
        `theme "${name}": ${foreground} on ${accent}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
