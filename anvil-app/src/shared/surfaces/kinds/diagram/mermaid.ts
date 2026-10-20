// Mermaid helpers for the Diagram surface (§8.7): cheap, dependency-free
// sanity checks and node extraction. The renderer does the real parse when
// it draws the diagram; these only catch obvious mistakes at the trust
// boundary and give the surface anchors for node comments.

export interface DiagramNodeRef {
  id: string;
  label: string;
}

/** Diagram type keywords Mermaid 11 recognises on the first meaningful line. */
export const MERMAID_DIAGRAM_TYPES: readonly string[] = [
  'graph',
  'flowchart',
  'flowchart-elk',
  'sequenceDiagram',
  'classDiagram',
  'classDiagram-v2',
  'stateDiagram',
  'stateDiagram-v2',
  'erDiagram',
  'journey',
  'gantt',
  'pie',
  'quadrantChart',
  'requirementDiagram',
  'gitGraph',
  'C4Context',
  'C4Container',
  'C4Component',
  'C4Dynamic',
  'C4Deployment',
  'mindmap',
  'timeline',
  'zenuml',
  'sankey-beta',
  'sankey',
  'xychart-beta',
  'xychart',
  'block-beta',
  'block',
  'packet-beta',
  'packet',
  'architecture-beta',
  'architecture',
  'kanban',
  'radar-beta',
  'treemap-beta',
];

const TYPE_BY_LOWER = new Map(MERMAID_DIAGRAM_TYPES.map((type) => [type.toLowerCase(), type]));

const FLOWCHART_TYPES = new Set(['graph', 'flowchart', 'flowchart-elk']);

/** Strips a surrounding ```mermaid fence and normalises line endings. */
export function normaliseMermaidSource(source: string): string {
  let text = source.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[ \t]*(?:mermaid|mmd)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

/** Lines after front matter, with comments and directives removed. */
function meaningfulLines(source: string): Array<{ text: string; index: number }> {
  const lines = source.split('\n');
  const result: Array<{ text: string; index: number }> = [];
  let index = 0;
  // YAML front matter (`---` … `---`) may precede the type line.
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (lines[index]?.trim() === '---') {
    index += 1;
    while (index < lines.length && lines[index].trim() !== '---') index += 1;
    index += 1;
  }
  for (; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text || text.startsWith('%%')) continue;
    result.push({ text, index });
  }
  return result;
}

/** The recognised diagram type of the first meaningful line, or null. */
export function mermaidDiagramType(source: string): string | null {
  const first = meaningfulLines(normaliseMermaidSource(source))[0];
  if (!first) return null;
  const keyword = /^([A-Za-z][\w-]*)/.exec(first.text)?.[1];
  return keyword ? (TYPE_BY_LOWER.get(keyword.toLowerCase()) ?? null) : null;
}

/** Plain-language problems with the source; empty when it looks renderable. */
export function validateMermaidSource(source: string): string[] {
  const text = normaliseMermaidSource(source);
  if (!text) return ['Mermaid source is empty.'];
  const lines = meaningfulLines(text);
  if (lines.length === 0) return ['Mermaid source has no diagram content.'];
  const first = lines[0].text;
  const type = mermaidDiagramType(text);
  if (!type) {
    const keyword = /^([^\s;]+)/.exec(first)?.[1] ?? first;
    return [
      `The first line must name a Mermaid diagram type (e.g. "flowchart TD", "sequenceDiagram"); got "${keyword.slice(0, 60)}".`,
    ];
  }
  // A flowchart header may carry content on the same line ("graph TD; A-->B").
  const inlineBody = /;\s*\S/.test(first);
  if (lines.length < 2 && !inlineBody && type !== 'pie') {
    return [`The ${type} has no content after its type line.`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Node extraction
// ---------------------------------------------------------------------------

// Shape openers/closers, longest first. Labels are captured lazily.
const SHAPED_NODE =
  /([A-Za-z0-9_][\w.]*)\s*(?:\(\(\((.*?)\)\)\)|\(\((.*?)\)\)|\[\[(.*?)\]\]|\[\((.*?)\)\]|\(\[(.*?)\]\)|\{\{(.*?)\}\}|\[[/\\](.*?)[/\\]\]|\[(.*?)\]|\((.*?)\)|\{(.*?)\}|>(.*?)\]|@\{(.*?)\})/g;

const FLOWCHART_SKIP =
  /^(?:subgraph|end\b|classDef|class\b|style\b|linkStyle|click\b|direction\b|accTitle|accDescr)/;
// Edge operators: -->, ---, -.->, ==>, ~~~, --o, --x, <-->, with optional length.
const EDGE_OPERATOR = /\s*<?(?:-{2,}|={2,}|-\.+-|~{3,})(?:>|[ox](?=\s))?\s*/g;
const RESERVED_WORDS = new Set(['end', 'graph', 'flowchart', 'subgraph', 'direction']);

export function cleanMermaidLabel(raw: string): string {
  let label = raw.trim();
  if (
    (label.startsWith('"') && label.endsWith('"')) ||
    (label.startsWith('`') && label.endsWith('`'))
  ) {
    label = label.slice(1, -1);
  }
  return label
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/#quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelFromNodeMetadata(raw: string): string | undefined {
  // Mermaid 11 shape syntax: A@{ shape: rect, label: "Text" }
  const match = /label\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/.exec(raw);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? cleanMermaidLabel(value) : undefined;
}

function extractFlowchartNodes(lines: string[], max: number): DiagramNodeRef[] {
  const nodes = new Map<string, string>();
  const add = (id: string, label?: string) => {
    if (!id || RESERVED_WORDS.has(id) || /^\d+$/.test(id)) return;
    const existing = nodes.get(id);
    if (existing === undefined) {
      if (nodes.size >= max) return;
      nodes.set(id, label || id);
    } else if (label && existing === id) {
      nodes.set(id, label);
    }
  };
  for (const raw of lines) {
    if (FLOWCHART_SKIP.test(raw)) continue;
    for (const statement of raw.split(';')) {
      let line = statement.trim();
      if (!line || FLOWCHART_SKIP.test(line)) continue;
      // Drop the class shorthand (A:::cls) and edge labels before scanning.
      line = line
        .replace(/:::[\w-]+/g, '')
        .replace(/\|[^|]*\|/g, ' ')
        .replace(/--\s+[^-<>=|][^>]*?\s+-->/g, ' --> ')
        .replace(/==\s+[^=<>|][^>]*?\s+==>/g, ' ==> ')
        .replace(/-\.\s+[^.<>|][^>]*?\s+\.->/g, ' -.-> ');
      SHAPED_NODE.lastIndex = 0;
      line = line.replace(SHAPED_NODE, (match, id: string, ...groups: unknown[]) => {
        const captures = groups.slice(0, 12) as Array<string | undefined>;
        const metadata = captures[11];
        const label =
          metadata !== undefined
            ? labelFromNodeMetadata(metadata)
            : captures.find((value) => value !== undefined);
        add(id, label !== undefined ? cleanMermaidLabel(label) : undefined);
        return ` ${id} `;
      });
      for (const part of line.split(EDGE_OPERATOR)) {
        for (const piece of part.split('&')) {
          const id = piece.trim();
          if (/^[A-Za-z0-9_][\w.]*$/.test(id)) add(id);
        }
      }
    }
  }
  return [...nodes.entries()].map(([id, label]) => ({ id, label }));
}

function extractSequenceParticipants(lines: string[], max: number): DiagramNodeRef[] {
  const nodes = new Map<string, string>();
  for (const line of lines) {
    const match = /^(?:participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/.exec(line);
    if (match && !nodes.has(match[1]) && nodes.size < max) {
      nodes.set(match[1], cleanMermaidLabel(match[2] ?? match[1]));
    }
  }
  return [...nodes.entries()].map(([id, label]) => ({ id, label }));
}

/**
 * Node ids and labels for flowcharts (shaped and bare ids) and sequence
 * diagram participants. Other diagram types return an empty list.
 */
export function extractMermaidNodes(source: string, max = 500): DiagramNodeRef[] {
  const text = normaliseMermaidSource(source);
  const type = mermaidDiagramType(text);
  const lines = meaningfulLines(text).map((line) => line.text);
  if (!type || lines.length === 0) return [];
  if (FLOWCHART_TYPES.has(type)) {
    // The header may carry statements after a semicolon ("graph TD; A-->B").
    const [header, ...rest] = lines;
    const headerBody = header.includes(';') ? header.slice(header.indexOf(';') + 1) : '';
    return extractFlowchartNodes([headerBody, ...rest].filter(Boolean), max);
  }
  if (type === 'sequenceDiagram') return extractSequenceParticipants(lines.slice(1), max);
  return [];
}
