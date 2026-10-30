// Diagram surface (§8.7): a Mermaid or draw.io diagram authored by the agent
// (skill guidance: prompts/diagram-generate.md via mezair_skill_get).
import type { JsonSchema, SurfaceAnchor, SurfaceKindDefinition } from '../types.js';
import { mermaidDiagramType, type DiagramNodeRef } from './diagram/mermaid.js';

export type { DiagramNodeRef } from './diagram/mermaid.js';

export type DiagramFormat = 'mermaid' | 'drawio';

export interface DiagramSurfaceData {
  format: DiagramFormat;
  /** Mermaid text or draw.io XML. */
  source: string;
  title: string;
  description?: string;
  /** Repository the diagram is about (and where Save to repo writes). */
  repoId?: string;
  /** Repo-relative path once saved, e.g. docs/diagrams/auth-flow.mmd. */
  savedPath?: string;
  /** Node ids and labels for anchored comments, where cheap to extract. */
  nodes?: DiagramNodeRef[];
}

export type DiagramActionId = 'save_to_repo' | 'open_drawio' | 'ask_revise';

export const DIAGRAM_FORMATS: readonly DiagramFormat[] = ['mermaid', 'drawio'];
/** Source cap (characters). draw.io XML is verbose; Mermaid rarely gets near this. */
export const DIAGRAM_MAX_SOURCE = 400_000;
export const DIAGRAM_MAX_NODES = 500;
export const DIAGRAM_MAX_DESCRIPTION = 2000;

export const diagramSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['format', 'source', 'title'],
  properties: {
    format: { type: 'string', enum: DIAGRAM_FORMATS },
    source: { type: 'string', minLength: 1, maxLength: DIAGRAM_MAX_SOURCE },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: DIAGRAM_MAX_DESCRIPTION },
    repoId: { type: 'string', minLength: 1, maxLength: 200 },
    savedPath: { type: 'string', maxLength: 1000 },
    nodes: {
      type: 'array',
      maxItems: DIAGRAM_MAX_NODES,
      items: {
        type: 'object',
        required: ['id', 'label'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          label: { type: 'string', maxLength: 300 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const DIAGRAM_FORMAT_LABELS: Record<DiagramFormat, string> = {
  mermaid: 'Mermaid',
  drawio: 'draw.io',
};

/** Human label for the diagram flavour, e.g. "Mermaid flowchart" or "draw.io". */
export function describeDiagramFormat(data: Pick<DiagramSurfaceData, 'format' | 'source'>): string {
  if (data.format === 'drawio') return DIAGRAM_FORMAT_LABELS.drawio;
  const type = mermaidDiagramType(data.source);
  return type ? `Mermaid ${type}` : DIAGRAM_FORMAT_LABELS.mermaid;
}

export function digestDiagram(data: DiagramSurfaceData): string {
  const count = data.nodes?.length ?? 0;
  const parts = [`Diagram (${data.format}): ${data.title}`];
  if (count > 0) parts.push(`${count} node${count === 1 ? '' : 's'}`);
  if (data.savedPath) parts.push(`saved to ${data.savedPath}`);
  const lines = [parts.join(' · ')];
  if (data.description) lines.push(data.description.slice(0, 300));
  if (count > 0) {
    const shown = data.nodes!.slice(0, 12).map((node) => `${node.label || node.id} [${node.id}]`);
    lines.push(`Nodes: ${shown.join(', ')}${count > 12 ? `, +${count - 12} more` : ''}`);
  }
  return lines.join('\n');
}

export function diagramNodeAnchor(node: DiagramNodeRef): SurfaceAnchor {
  return { type: 'node', targetId: node.id, label: node.label || node.id };
}

export const diagramSurfaceKind: SurfaceKindDefinition<DiagramSurfaceData> = {
  kind: 'diagram',
  label: 'Diagram',
  schema: diagramSurfaceSchema,
  actions: {
    save_to_repo: {
      label: 'Save to repo',
      semantics: { type: 'mutation', command: 'diagram.save', approval: true },
      shortcut: 's',
      targets: 'none',
    },
    open_drawio: {
      label: 'Open in draw.io',
      semantics: { type: 'mezair-command', command: 'diagram.open-drawio' },
      shortcut: 'o',
      targets: 'none',
    },
    ask_revise: {
      label: 'Ask agent to revise',
      semantics: {
        type: 'agent-message',
        template: 'Please revise the diagram "{title}" and update the same surface.\n{targets}',
      },
      shortcut: 'r',
    },
  },
  anchors: ['surface', 'node', 'region'],
  digest: digestDiagram,
  feature: 'diagrams',
  shareable: true,
};
