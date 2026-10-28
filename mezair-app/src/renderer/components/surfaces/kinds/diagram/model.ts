// Pure helpers for the Diagram surface views (§8.7).
import type { MermaidConfig } from 'mermaid';
import type {
  DiagramFormat,
  DiagramNodeRef,
  DiagramSurfaceData,
} from '../../../../../shared/surfaces/kinds/diagram';
import {
  buildDrawioSvgModel,
  parseDrawio,
  type DrawioSvgModel,
} from '../../../../../shared/surfaces/kinds/diagram/drawio';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';
import type { SketchTokenSet } from '../../../../../shared/surfaces/sketch-runtime';
import { describeRegion } from '../../surface-utils';

export const INLINE_MAX_HEIGHT = 360;

export function readDiagramData(raw: unknown): DiagramSurfaceData {
  const value = (raw ?? {}) as Partial<DiagramSurfaceData>;
  const format: DiagramFormat = value.format === 'drawio' ? 'drawio' : 'mermaid';
  return {
    ...value,
    format,
    source: typeof value.source === 'string' ? value.source : '',
    title: typeof value.title === 'string' ? value.title : '',
    nodes: Array.isArray(value.nodes)
      ? value.nodes.filter(
          (node): node is DiagramNodeRef =>
            typeof node?.id === 'string' && typeof node?.label === 'string',
        )
      : [],
  };
}

export interface DrawioView {
  model: DrawioSvgModel | null;
  compressed: boolean;
  pageCount: number;
}

/** draw.io XML → read-only SVG model (null when nothing is drawable). */
export function drawioView(source: string): DrawioView {
  try {
    const parsed = parseDrawio(source);
    if (parsed.compressed) return { model: null, compressed: true, pageCount: parsed.pageCount };
    const model = buildDrawioSvgModel(parsed);
    return {
      model: model.nodes.length > 0 || model.edges.length > 0 ? model : null,
      compressed: false,
      pageCount: parsed.pageCount,
    };
  } catch {
    return { model: null, compressed: false, pageCount: 1 };
  }
}

export function nodeAnchor(node: DiagramNodeRef): SurfaceAnchor {
  return { type: 'node', targetId: node.id, label: node.label || node.id };
}

export function regionAnchor(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): SurfaceAnchor {
  return { type: 'region', rect, label: describeRegion(rect) };
}

/** Case-insensitive filter over node labels and ids. */
export function filterNodes(nodes: readonly DiagramNodeRef[], query: string): DiagramNodeRef[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...nodes];
  return nodes.filter(
    (node) => node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle),
  );
}

/**
 * Node id for a clicked Mermaid SVG element: Mermaid 11 sets `data-id` on
 * flowchart nodes and ids like `flowchart-<id>-<n>` (older builds).
 */
export function mermaidNodeIdFromElement(
  element: { getAttribute(name: string): string | null } | null,
  knownIds: ReadonlySet<string>,
): string | null {
  if (!element) return null;
  const dataId = element.getAttribute('data-id');
  if (dataId && knownIds.has(dataId)) return dataId;
  const id = element.getAttribute('id') ?? '';
  const match = /(?:^|-)(?:flowchart|state|classId|entity)-(.+?)(?:-\d+)?$/.exec(id);
  if (match && knownIds.has(match[1])) return match[1];
  // Sequence participants: `root-<n>` groups carry the name in a <text> child; not mapped.
  return null;
}

/**
 * Gives a Mermaid SVG explicit pixel dimensions from its viewBox (Mermaid
 * emits width="100%"), so pan/zoom has a stable natural size.
 */
export function sizeMermaidSvg(svg: string): { svg: string; width: number; height: number } {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return { svg, width: 0, height: 0 };
  const viewBox =
    /\bviewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
      open[0],
    );
  if (!viewBox) return { svg, width: 0, height: 0 };
  const width = Math.ceil(Number(viewBox[3]));
  const height = Math.ceil(Number(viewBox[4]));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { svg, width: 0, height: 0 };
  }
  const tag = open[0]
    .replace(/\s(?:width|height)\s*=\s*(["'])[^"']*\1/gi, '')
    .replace(/\sstyle\s*=\s*(["'])([^"']*)\1/i, (_match, quote: string, style: string) => {
      const kept = style
        .split(';')
        .filter((rule) => rule.trim() && !/^\s*max-width\s*:/i.test(rule))
        .join(';');
      return kept ? ` style=${quote}${kept}${quote}` : '';
    })
    .replace(/^<svg\b/i, `<svg width="${width}" height="${height}"`);
  return { svg: svg.replace(open[0], tag), width, height };
}

const SAFE_COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

function colour(tokens: SketchTokenSet, name: string): string | undefined {
  const value = tokens[name]?.trim();
  return value && SAFE_COLOUR.test(value) ? value : undefined;
}

/**
 * Mermaid config following the active app theme. Uses Mermaid's `base`
 * theme with Mezair token colours when they are plain colours Mermaid can
 * parse; otherwise falls back to its stock light/dark theme.
 */
export function mermaidConfigForTokens(
  tokens: SketchTokenSet,
  scheme: 'light' | 'dark',
): MermaidConfig {
  const base: MermaidConfig = {
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: tokens['--mezair-font-sans'] || 'IBM Plex Sans, system-ui, sans-serif',
  };
  const canvas = colour(tokens, '--mezair-canvas');
  const surface = colour(tokens, '--mezair-surface');
  const raised = colour(tokens, '--mezair-surface-raised');
  const border = colour(tokens, '--mezair-border');
  const ink = colour(tokens, '--mezair-ink');
  const muted = colour(tokens, '--mezair-ink-muted');
  const secondary = colour(tokens, '--mezair-ink-secondary');
  if (!canvas || !surface || !raised || !border || !ink || !muted) {
    return { ...base, theme: scheme === 'light' ? 'default' : 'dark' };
  }
  return {
    ...base,
    theme: 'base',
    themeVariables: {
      darkMode: scheme === 'dark',
      background: canvas,
      fontFamily: base.fontFamily,
      primaryColor: raised,
      primaryTextColor: ink,
      primaryBorderColor: border,
      secondaryColor: surface,
      secondaryTextColor: ink,
      secondaryBorderColor: border,
      tertiaryColor: canvas,
      tertiaryTextColor: ink,
      tertiaryBorderColor: border,
      lineColor: muted,
      textColor: ink,
      mainBkg: raised,
      nodeBorder: border,
      nodeTextColor: ink,
      clusterBkg: surface,
      clusterBorder: border,
      edgeLabelBackground: surface,
      titleColor: ink,
      actorBkg: raised,
      actorBorder: border,
      actorTextColor: ink,
      actorLineColor: muted,
      signalColor: secondary ?? ink,
      signalTextColor: ink,
      labelBoxBkgColor: surface,
      labelBoxBorderColor: border,
      labelTextColor: ink,
      loopTextColor: ink,
      noteBkgColor: surface,
      noteBorderColor: border,
      noteTextColor: ink,
    },
  };
}

export function formatMeta(data: DiagramSurfaceData, flavour: string): string {
  const count = data.nodes?.length ?? 0;
  return [flavour, count ? `${count} node${count === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
}
