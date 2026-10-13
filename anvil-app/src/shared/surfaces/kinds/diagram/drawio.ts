// draw.io helpers for the Diagram surface (§8.7). A small, dependency-free
// tokenizer (main has no DOMParser) that checks well-formedness, reads
// mxCell geometry and labels, and builds a read-only SVG model the renderer
// and the share snapshot both draw. Deliberately simple: boxes, labels and
// straight/waypointed edges. Full fidelity lives in draw.io itself.

import type { DiagramNodeRef } from './mermaid.js';

export interface DrawioPoint {
  x: number;
  y: number;
}

export interface DrawioGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  relative: boolean;
}

export interface DrawioCell {
  id: string;
  parent?: string;
  label: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  geometry?: DrawioGeometry;
  points: DrawioPoint[];
  sourcePoint?: DrawioPoint;
  targetPoint?: DrawioPoint;
}

export interface ParsedDrawio {
  /** Cells of the first page. */
  cells: DrawioCell[];
  pageCount: number;
  pageName?: string;
  /** The first page is stored compressed (deflate + base64), so no cells were read. */
  compressed: boolean;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface XmlTag {
  type: 'open' | 'close' | 'self';
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      if (lower === 'nbsp') return ' ';
      const code = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    },
  );
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(raw))) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

interface Tokenized {
  tags: XmlTag[];
  errors: string[];
  doctype: boolean;
}

function tokenize(source: string): Tokenized {
  const tags: XmlTag[] = [];
  const errors: string[] = [];
  let doctype = false;
  let cursor = 0;
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(source))) {
    const text = source.slice(cursor, match.index);
    if (text.includes('<') && errors.length < 5) {
      errors.push(
        `Malformed markup near "${text.slice(text.indexOf('<'), text.indexOf('<') + 40)}".`,
      );
    }
    cursor = match.index + match[0].length;
    if (match[0].startsWith('<!DOCTYPE')) {
      doctype = true;
      continue;
    }
    if (!match[2]) continue; // comment, CDATA, processing instruction
    tags.push({
      type: match[1] ? 'close' : match[4] ? 'self' : 'open',
      name: match[2],
      attrs: match[1] ? {} : parseAttributes(match[3] ?? ''),
      start: match.index,
      end: cursor,
    });
  }
  const tail = source.slice(cursor);
  if (tail.includes('<') && errors.length < 5) {
    errors.push(
      `Malformed markup near "${tail.slice(tail.indexOf('<'), tail.indexOf('<') + 40)}".`,
    );
  }
  return { tags, errors, doctype };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Plain-language problems with the XML; empty when it is a well-formed draw.io document. */
export function validateDrawioSource(source: string): string[] {
  const text = source.trim();
  if (!text) return ['draw.io XML is empty.'];
  const { tags, errors, doctype } = tokenize(text);
  if (doctype) return ['draw.io XML must not contain a DOCTYPE.'];
  if (errors.length > 0) return errors;
  const root = tags[0];
  if (!root || (root.name !== 'mxfile' && root.name !== 'mxGraphModel')) {
    return [
      `The root element must be <mxfile> or <mxGraphModel>; got ${root ? `<${root.name}>` : 'no element'}.`,
    ];
  }
  const before = text.slice(0, root.start).replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '');
  if (before.trim()) return ['Unexpected text before the root element.'];
  const stack: string[] = [];
  let rootClosed = false;
  for (const tag of tags) {
    if (rootClosed)
      return [`Unexpected <${tag.type === 'close' ? '/' : ''}${tag.name}> after the root element.`];
    if (tag.type === 'open') stack.push(tag.name);
    else if (tag.type === 'close') {
      const expected = stack.pop();
      if (expected !== tag.name) {
        return [
          expected
            ? `Mismatched </${tag.name}>; expected </${expected}>.`
            : `Unexpected </${tag.name}>.`,
        ];
      }
    }
    if (stack.length === 0) rootClosed = true;
  }
  if (stack.length > 0) return [`Unclosed <${stack[stack.length - 1]}>.`];
  const last = tags[tags.length - 1];
  const after = text.slice(last.end).replace(/<!--[\s\S]*?-->/g, '');
  if (after.trim()) return ['Unexpected text after the root element.'];
  const hasModel = tags.some((tag) => tag.name === 'mxGraphModel');
  const hasDiagram = tags.some((tag) => tag.name === 'diagram');
  if (root.name === 'mxfile' && !hasDiagram) return ['<mxfile> must contain a <diagram> page.'];
  if (!hasModel && root.name === 'mxGraphModel') return ['<mxGraphModel> is missing.'];
  return [];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function num(value: string | undefined): number {
  const parsed = value === undefined ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function point(attrs: Record<string, string>): DrawioPoint {
  return { x: num(attrs.x), y: num(attrs.y) };
}

/** Label text from an mxCell `value` (which may hold HTML when the style has html=1). */
export function drawioLabelText(value: string | undefined): string {
  if (!value) return '';
  return decodeXmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const MAX_CELLS = 2000;

export function parseDrawio(source: string): ParsedDrawio {
  const { tags } = tokenize(source.trim());
  const cells: DrawioCell[] = [];
  let pageCount = 0;
  let pageName: string | undefined;
  let inFirstPage = false;
  let firstPageHasModel = false;
  let firstPageOpen: XmlTag | null = null;
  let firstPageClose: XmlTag | null = null;
  let isBareModel = tags[0]?.name === 'mxGraphModel';
  let wrapper: { id?: string; label?: string } | null = null;
  let cell: DrawioCell | null = null;
  let inGeometry = false;
  let inPoints = false;

  for (const tag of tags) {
    if (tag.name === 'diagram') {
      if (tag.type === 'open' || tag.type === 'self') {
        pageCount += 1;
        if (pageCount === 1) {
          pageName = tag.attrs.name || undefined;
          inFirstPage = tag.type === 'open';
          firstPageOpen = tag;
        }
      } else if (inFirstPage) {
        inFirstPage = false;
        firstPageClose = tag;
      }
      continue;
    }
    const active = isBareModel || inFirstPage;
    if (!active) continue;
    if (tag.name === 'mxGraphModel') {
      if (inFirstPage) firstPageHasModel = true;
      if (isBareModel && tag.type === 'close') isBareModel = false;
      continue;
    }
    if (tag.name === 'UserObject' || tag.name === 'object') {
      if (tag.type === 'close') wrapper = null;
      else wrapper = { id: tag.attrs.id, label: tag.attrs.label ?? tag.attrs.value };
      continue;
    }
    if (tag.name === 'mxCell') {
      if (tag.type === 'close') {
        cell = null;
        continue;
      }
      if (cells.length >= MAX_CELLS) continue;
      const attrs = tag.attrs;
      const next: DrawioCell = {
        id: attrs.id ?? wrapper?.id ?? `cell-${cells.length}`,
        ...(attrs.parent ? { parent: attrs.parent } : {}),
        label: drawioLabelText(attrs.value ?? wrapper?.label),
        style: attrs.style ?? '',
        vertex: attrs.vertex === '1',
        edge: attrs.edge === '1',
        ...(attrs.source ? { source: attrs.source } : {}),
        ...(attrs.target ? { target: attrs.target } : {}),
        points: [],
      };
      cells.push(next);
      cell = tag.type === 'open' ? next : null;
      continue;
    }
    if (!cell) continue;
    if (tag.name === 'mxGeometry') {
      if (tag.type === 'close') {
        inGeometry = false;
        continue;
      }
      cell.geometry = {
        x: num(tag.attrs.x),
        y: num(tag.attrs.y),
        width: num(tag.attrs.width),
        height: num(tag.attrs.height),
        relative: tag.attrs.relative === '1',
      };
      inGeometry = tag.type === 'open';
      continue;
    }
    if (!inGeometry) continue;
    if (tag.name === 'Array') {
      inPoints = tag.type === 'open' && tag.attrs.as === 'points';
      continue;
    }
    if (tag.name === 'mxPoint' && tag.type !== 'close') {
      if (inPoints) cell.points.push(point(tag.attrs));
      else if (tag.attrs.as === 'sourcePoint') cell.sourcePoint = point(tag.attrs);
      else if (tag.attrs.as === 'targetPoint') cell.targetPoint = point(tag.attrs);
    }
  }

  let compressed = false;
  if (firstPageOpen && firstPageClose && !firstPageHasModel) {
    const content = source.trim().slice(firstPageOpen.end, firstPageClose.start).trim();
    compressed = content.length > 0;
  }
  return {
    cells,
    pageCount: Math.max(pageCount, 1),
    ...(pageName ? { pageName } : {}),
    compressed,
  };
}

/** Vertices with a label (or id) for node anchors. Edge labels and containers' children included. */
export function extractDrawioNodes(parsed: ParsedDrawio, max = 500): DiagramNodeRef[] {
  const edgeIds = new Set(parsed.cells.filter((cell) => cell.edge).map((cell) => cell.id));
  const nodes: DiagramNodeRef[] = [];
  for (const cell of parsed.cells) {
    if (!cell.vertex || !cell.label) continue;
    if (cell.parent && edgeIds.has(cell.parent)) continue; // edge label
    nodes.push({ id: cell.id, label: cell.label.replace(/\n/g, ' ').slice(0, 300) });
    if (nodes.length >= max) break;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Read-only SVG model
// ---------------------------------------------------------------------------

export type DrawioShape =
  'rect' | 'rounded' | 'ellipse' | 'diamond' | 'cylinder' | 'text' | 'container';

export interface DrawioSvgNode {
  id: string;
  label: string;
  /** Label wrapped to fit the shape. */
  lines: string[];
  shape: DrawioShape;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawioSvgEdge {
  id: string;
  /** Polyline points in model space, start to end. */
  points: DrawioPoint[];
  label?: string;
  labelX: number;
  labelY: number;
  dashed: boolean;
  /** Arrow at the end (draw.io default unless endArrow=none). */
  arrow: boolean;
}

export interface DrawioSvgModel {
  width: number;
  height: number;
  nodes: DrawioSvgNode[];
  edges: DrawioSvgEdge[];
}

export function parseDrawioStyle(style: string): {
  base: Set<string>;
  values: Map<string, string>;
} {
  const base = new Set<string>();
  const values = new Map<string, string>();
  for (const part of style.split(';')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq < 0) base.add(entry);
    else values.set(entry.slice(0, eq).trim(), entry.slice(eq + 1).trim());
  }
  return { base, values };
}

export function drawioShape(style: string): DrawioShape {
  const { base, values } = parseDrawioStyle(style);
  const shape = values.get('shape') ?? '';
  const has = (name: string) => base.has(name) || shape === name;
  if (has('text') || base.has('edgeLabel')) return 'text';
  if (has('swimlane') || has('group') || values.get('container') === '1') return 'container';
  if (has('ellipse') || has('doubleEllipse') || shape.includes('ellipse')) return 'ellipse';
  if (has('rhombus') || shape.includes('rhombus') || shape.includes('decision')) return 'diamond';
  if (/cylinder|database|datastore/i.test(shape) || base.has('cylinder')) return 'cylinder';
  if (values.get('rounded') === '1') return 'rounded';
  return 'rect';
}

/** Wraps a label into at most `maxLines` lines of about `maxChars` characters. */
export function wrapLabel(label: string, maxChars: number, maxLines: number): string[] {
  const limit = Math.max(4, Math.floor(maxChars));
  const out: string[] = [];
  for (const paragraph of label.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const chunked = word.length > limit ? word.match(new RegExp(`.{1,${limit}}`, 'g'))! : [word];
      for (const chunk of chunked) {
        if (!line) line = chunk;
        else if (line.length + 1 + chunk.length <= limit) line += ` ${chunk}`;
        else {
          out.push(line);
          line = chunk;
        }
      }
    }
    if (line) out.push(line);
  }
  if (out.length <= maxLines) return out;
  const kept = out.slice(0, Math.max(1, maxLines));
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = `${last.slice(0, Math.max(1, limit - 1))}…`;
  return kept;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centre(box: Box): DrawioPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where the ray from the box centre towards `toward` leaves the box. */
export function clipToBox(box: Box, toward: DrawioPoint): DrawioPoint {
  const c = centre(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const halfW = box.width / 2 || 0.5;
  const halfH = box.height / 2 || 0.5;
  const scale = 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  return { x: c.x + dx * Math.min(1, scale), y: c.y + dy * Math.min(1, scale) };
}

function polylineMidpoint(points: DrawioPoint[]): DrawioPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const length = Math.hypot(
      points[index].x - points[index - 1].x,
      points[index].y - points[index - 1].y,
    );
    lengths.push(length);
    total += length;
  }
  let remaining = total / 2;
  for (let index = 1; index < points.length; index += 1) {
    const length = lengths[index - 1];
    if (remaining <= length || index === points.length - 1) {
      const t = length === 0 ? 0 : remaining / length;
      return {
        x: points[index - 1].x + (points[index].x - points[index - 1].x) * t,
        y: points[index - 1].y + (points[index].y - points[index - 1].y) * t,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

const PADDING = 16;
const CHAR_WIDTH = 6.6;
const LINE_HEIGHT = 15;
const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Absolute geometry for every drawable vertex and edge of the first page,
 * translated so the drawing starts at (PADDING, PADDING).
 */
export function buildDrawioSvgModel(parsed: ParsedDrawio): DrawioSvgModel {
  const byId = new Map(parsed.cells.map((cell) => [cell.id, cell]));
  const absolute = new Map<string, Box>();

  const offsetOf = (parentId: string | undefined, depth = 0): DrawioPoint => {
    if (!parentId || depth > 20) return { x: 0, y: 0 };
    const parent = byId.get(parentId);
    if (!parent?.vertex || !parent.geometry || parent.geometry.relative) return { x: 0, y: 0 };
    const above = offsetOf(parent.parent, depth + 1);
    return { x: above.x + parent.geometry.x, y: above.y + parent.geometry.y };
  };

  const nodes: DrawioSvgNode[] = [];
  const edgeLabels = new Map<string, string>();
  for (const cell of parsed.cells) {
    if (!cell.vertex || !cell.geometry) continue;
    const parent = cell.parent ? byId.get(cell.parent) : undefined;
    if (parent?.edge) {
      if (cell.label) edgeLabels.set(parent.id, cell.label);
      continue;
    }
    if (cell.geometry.relative) continue;
    const offset = offsetOf(cell.parent);
    const box = {
      x: offset.x + cell.geometry.x,
      y: offset.y + cell.geometry.y,
      width: Math.max(1, cell.geometry.width),
      height: Math.max(1, cell.geometry.height),
    };
    absolute.set(cell.id, box);
    const shape = drawioShape(cell.style);
    const textWidth = shape === 'diamond' || shape === 'ellipse' ? box.width * 0.7 : box.width - 8;
    const maxLines =
      shape === 'container'
        ? 1
        : Math.max(1, Math.floor((box.height - (shape === 'cylinder' ? 12 : 4)) / LINE_HEIGHT));
    nodes.push({
      id: cell.id,
      label: cell.label,
      lines: cell.label ? wrapLabel(cell.label, textWidth / CHAR_WIDTH, maxLines) : [],
      shape,
      ...box,
    });
  }

  const edges: DrawioSvgEdge[] = [];
  for (const cell of parsed.cells) {
    if (!cell.edge) continue;
    const offset = offsetOf(cell.parent);
    const waypoints = cell.points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
    const sourceBox = cell.source ? absolute.get(cell.source) : undefined;
    const targetBox = cell.target ? absolute.get(cell.target) : undefined;
    const sourceFree = cell.sourcePoint
      ? { x: cell.sourcePoint.x + offset.x, y: cell.sourcePoint.y + offset.y }
      : undefined;
    const targetFree = cell.targetPoint
      ? { x: cell.targetPoint.x + offset.x, y: cell.targetPoint.y + offset.y }
      : undefined;
    const towardStart = waypoints[0] ?? (targetBox ? centre(targetBox) : targetFree);
    const towardEnd =
      waypoints[waypoints.length - 1] ?? (sourceBox ? centre(sourceBox) : sourceFree);
    const start = sourceBox
      ? towardStart
        ? clipToBox(sourceBox, towardStart)
        : centre(sourceBox)
      : sourceFree;
    const end = targetBox
      ? towardEnd
        ? clipToBox(targetBox, towardEnd)
        : centre(targetBox)
      : targetFree;
    if (!start || !end) continue;
    const points = [start, ...waypoints, end].map((p) => ({ x: round(p.x), y: round(p.y) }));
    const mid = polylineMidpoint(points);
    const { values } = parseDrawioStyle(cell.style);
    const label = cell.label || edgeLabels.get(cell.id);
    edges.push({
      id: cell.id,
      points,
      ...(label ? { label: label.replace(/\n/g, ' ') } : {}),
      labelX: round(mid.x),
      labelY: round(mid.y),
      dashed: values.get('dashed') === '1',
      arrow: values.get('endArrow') !== 'none',
    });
  }

  if (nodes.length === 0 && edges.length === 0) return { width: 0, height: 0, nodes, edges };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const node of nodes) {
    extend(node.x, node.y);
    extend(node.x + node.width, node.y + node.height);
  }
  for (const edge of edges) {
    for (const p of edge.points) extend(p.x, p.y);
    if (edge.label) {
      const half = (edge.label.length * CHAR_WIDTH) / 2;
      extend(edge.labelX - half, edge.labelY - LINE_HEIGHT);
      extend(edge.labelX + half, edge.labelY + LINE_HEIGHT);
    }
  }
  const dx = PADDING - minX;
  const dy = PADDING - minY;
  return {
    width: Math.ceil(maxX - minX + PADDING * 2),
    height: Math.ceil(maxY - minY + PADDING * 2),
    nodes: nodes.map((node) => ({ ...node, x: round(node.x + dx), y: round(node.y + dy) })),
    edges: edges.map((edge) => ({
      ...edge,
      points: edge.points.map((p) => ({ x: round(p.x + dx), y: round(p.y + dy) })),
      labelX: round(edge.labelX + dx),
      labelY: round(edge.labelY + dy),
    })),
  };
}

export type DrawioOutline =
  | { kind: 'none' }
  | { kind: 'rect'; rx: number; dashed?: boolean }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'path'; d: string };

/** Outline of a node in its own coordinate space (0,0 at the node's top-left). */
export function drawioNodeOutline(
  node: Pick<DrawioSvgNode, 'shape' | 'width' | 'height'>,
): DrawioOutline {
  const { width: w, height: h } = node;
  switch (node.shape) {
    case 'text':
      return { kind: 'none' };
    case 'rounded':
      return { kind: 'rect', rx: Math.min(10, h / 4) };
    case 'container':
      return { kind: 'rect', rx: 4, dashed: true };
    case 'ellipse':
      return { kind: 'ellipse', cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 };
    case 'diamond':
      return { kind: 'path', d: `M${w / 2} 0 L${w} ${h / 2} L${w / 2} ${h} L0 ${h / 2} Z` };
    case 'cylinder': {
      const ry = Math.min(10, h / 6);
      return {
        kind: 'path',
        d: `M0 ${ry} A${w / 2} ${ry} 0 0 1 ${w} ${ry} L${w} ${h - ry} A${w / 2} ${ry} 0 0 1 0 ${h - ry} Z M0 ${ry} A${w / 2} ${ry} 0 0 0 ${w} ${ry}`,
      };
    }
    default:
      return { kind: 'rect', rx: 2 };
  }
}

/** Baseline y of each label line, vertically centred (containers: top-aligned). */
export function drawioLabelBaselines(
  node: Pick<DrawioSvgNode, 'shape' | 'height' | 'lines'>,
): number[] {
  const count = node.lines.length;
  if (node.shape === 'container') return count ? [LINE_HEIGHT] : [];
  const top = node.height / 2 - (count * LINE_HEIGHT) / 2 + LINE_HEIGHT * 0.75;
  return node.lines.map((_, index) => round(top + index * LINE_HEIGHT));
}

/** SVG path data for an edge polyline. */
export function drawioEdgePath(points: readonly DrawioPoint[]): string {
  return points.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
}
