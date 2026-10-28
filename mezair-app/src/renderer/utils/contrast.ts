/**
 * WCAG 2.x contrast helpers (pure functions — no DOM dependency).
 *
 * Used to verify token pairs such as `--color-accent` /
 * `--color-accent-foreground` stay above the AA 4.5:1 threshold in every
 * theme. See utils/__tests__/contrast.test.ts, which parses
 * styles/global.css and asserts the pairs directly.
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb`, `#rrggbb`, or `rgb(r, g, b)` into channel values 0-255. */
export function parseColor(color: string): RgbColor {
  const value = color.trim();

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    };
  }

  throw new Error(`Unsupported colour value: ${color}`);
}

function channelToLinear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/**
 * WCAG contrast ratio between two colours, 1:1 to 21:1.
 * Order-independent. Alpha channels are ignored — callers comparing text on a
 * translucent surface should resolve the effective colour first.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
