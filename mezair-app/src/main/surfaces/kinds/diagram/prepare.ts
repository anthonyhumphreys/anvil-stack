// Trust-boundary checks for Diagram sources: normalise, validate and
// extract node anchors before anything is published.
import { inflateRawSync } from 'node:zlib';
import {
  DIAGRAM_MAX_NODES,
  DIAGRAM_MAX_SOURCE,
  type DiagramFormat,
  type DiagramNodeRef,
} from '../../../../shared/surfaces/kinds/diagram.js';
import {
  extractMermaidNodes,
  normaliseMermaidSource,
  validateMermaidSource,
} from '../../../../shared/surfaces/kinds/diagram/mermaid.js';
import {
  extractDrawioNodes,
  parseDrawio,
  validateDrawioSource,
} from '../../../../shared/surfaces/kinds/diagram/drawio.js';
import { AgentToolError } from '../../../agent-tools/dispatch.js';

export interface PreparedDiagramSource {
  source: string;
  nodes: DiagramNodeRef[];
  /** Notes for the agent (not errors), e.g. "draw.io page 1 of 3 shown". */
  notes: string[];
}

const MAX_INFLATED_BYTES = DIAGRAM_MAX_SOURCE * 2;

/**
 * draw.io stores pages compressed by default (deflate-raw, base64, then
 * URI-encoded). Inflate them so the surface can draw geometry and extract
 * nodes; draw.io opens the uncompressed form just the same.
 */
export function inflateDrawioPages(xml: string): string {
  return xml.replace(
    /(<diagram\b[^>]*>)([^<]+)(<\/diagram>)/g,
    (match, open: string, content: string, close: string) => {
      const encoded = content.trim();
      if (!encoded || !/^[A-Za-z0-9+/=\s]+$/.test(encoded)) return match;
      try {
        const inflated = inflateRawSync(Buffer.from(encoded, 'base64'), {
          maxOutputLength: MAX_INFLATED_BYTES,
        }).toString('utf8');
        const decoded = decodeURIComponent(inflated);
        return decoded.trimStart().startsWith('<mxGraphModel')
          ? `${open}${decoded}${close}`
          : match;
      } catch {
        return match;
      }
    },
  );
}

function stripXmlProlog(xml: string): string {
  return xml.replace(/^\uFEFF/, '').trim();
}

/** Validates and normalises a diagram source; throws AgentToolError('invalid-params') on bad input. */
export function prepareDiagramSource(format: DiagramFormat, raw: string): PreparedDiagramSource {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new AgentToolError('Diagram source is empty.', 'invalid-params');
  }
  const notes: string[] = [];
  if (format === 'mermaid') {
    const source = normaliseMermaidSource(raw);
    const errors = validateMermaidSource(source);
    if (errors.length > 0) {
      throw new AgentToolError(`Invalid Mermaid diagram: ${errors.join(' ')}`, 'invalid-params');
    }
    assertSize(source);
    const nodes = extractMermaidNodes(source, DIAGRAM_MAX_NODES);
    return { source, nodes, notes };
  }
  const original = stripXmlProlog(raw);
  const fenced = /^```[ \t]*(?:xml|drawio)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(original);
  const xml = fenced ? fenced[1].trim() : original;
  const errors = validateDrawioSource(xml);
  if (errors.length > 0) {
    throw new AgentToolError(`Invalid draw.io XML: ${errors.join(' ')}`, 'invalid-params');
  }
  let source = inflateDrawioPages(xml);
  if (
    source !== xml &&
    ((source.length > DIAGRAM_MAX_SOURCE && xml.length <= DIAGRAM_MAX_SOURCE) ||
      validateDrawioSource(source).length > 0)
  ) {
    // Inflated form is too big to store or not well-formed; keep the original.
    source = xml;
  }
  assertSize(source);
  const parsed = parseDrawio(source);
  if (parsed.compressed) {
    notes.push('The first page is compressed and could not be read; it renders as source only.');
  }
  if (parsed.pageCount > 1) {
    notes.push(`Only the first of ${parsed.pageCount} pages is drawn inline.`);
  }
  const nodes = extractDrawioNodes(parsed, DIAGRAM_MAX_NODES);
  if (!parsed.compressed && !parsed.cells.some((cell) => cell.vertex)) {
    notes.push('The diagram has no shapes yet.');
  }
  return { source, nodes, notes };
}

function assertSize(source: string): void {
  if (source.length > DIAGRAM_MAX_SOURCE) {
    throw new AgentToolError(
      `Diagram source is too large (${source.length} characters; ${DIAGRAM_MAX_SOURCE} maximum). Split it into smaller diagrams.`,
      'invalid-params',
    );
  }
}

export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'diagram'
  );
}
