import type { WorkflowTemplate } from '../../shared/types';

export type WorkflowChatIntent =
  | { kind: 'run'; template: WorkflowTemplate; kickoff: string }
  | { kind: 'draft'; request: string; kickoff: string }
  | { kind: 'choose'; kickoff: string };

export function parseWorkflowChatIntent(
  message: string,
  templates: WorkflowTemplate[],
): WorkflowChatIntent | null {
  const trimmed = message.trim();
  const normalised = normalise(trimmed);
  if (!normalised.includes('workflow')) return null;

  const asksToCreate =
    /\b(?:create|build|make|design|draft)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:new\s+)?workflow\b/i.test(
      trimmed,
    );
  if (asksToCreate) {
    return { kind: 'draft', request: trimmed, kickoff: stripWorkflowLead(trimmed) };
  }

  if (!/\b(?:use|run|start|launch)\b/i.test(trimmed)) return null;
  const template = templates
    .filter((candidate) => normalised.includes(normalise(candidate.name)))
    .toSorted((left, right) => right.name.length - left.name.length)[0];
  const kickoff = stripWorkflowLead(trimmed);
  if (template) return { kind: 'run', template, kickoff };
  return { kind: 'choose', kickoff };
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripWorkflowLead(value: string): string {
  const separated = value.match(/\b(?:to|for|with)\b\s+(.+)$/i)?.[1]?.trim();
  return separated || value.trim();
}
