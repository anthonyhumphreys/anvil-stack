import type { WorkflowTemplate } from '../../shared/types';

export type WorkflowChatIntent =
  | { kind: 'run'; template: WorkflowTemplate; kickoff: string }
  | { kind: 'draft'; request: string; kickoff: string }
  | { kind: 'choose'; kickoff: string };

const REQUEST_LEAD = String.raw`^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|i(?:'d| would)\s+like\s+(?:you\s+)?to\s+|help\s+me\s+)?`;
const CREATE_WORKFLOW_PATTERN = new RegExp(
  String.raw`${REQUEST_LEAD}(?:create|build|make|design|draft)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:new\s+)?workflow\b`,
  'i',
);
const RUN_GENERIC_WORKFLOW_PATTERN = new RegExp(
  String.raw`${REQUEST_LEAD}(?:run|start|launch)\s+(?:(?:the|a|an|my|this|that)\s+)?(?:(?:saved|existing)\s+)?workflow\b`,
  'i',
);
const USE_GENERIC_WORKFLOW_PATTERN = new RegExp(
  String.raw`${REQUEST_LEAD}use\s+(?:the|a|an|my|this|that)\s+(?:(?:saved|existing)\s+)?workflow\b(?:\s+(?:to|for|with)\b|[.!?]?\s*$)`,
  'i',
);
const POSSIBLE_NAMED_WORKFLOW_PATTERN = new RegExp(
  String.raw`${REQUEST_LEAD}(?:use|run|start|launch)\b.{0,120}\bworkflow\b(?:\s+(?:to|for|with)\b|[.!?]?\s*$)`,
  'i',
);

export function hasExplicitWorkflowCommand(message: string): boolean {
  const trimmed = message.trim();
  return (
    CREATE_WORKFLOW_PATTERN.test(trimmed) ||
    RUN_GENERIC_WORKFLOW_PATTERN.test(trimmed) ||
    USE_GENERIC_WORKFLOW_PATTERN.test(trimmed) ||
    POSSIBLE_NAMED_WORKFLOW_PATTERN.test(trimmed)
  );
}

export function parseWorkflowChatIntent(
  message: string,
  templates: WorkflowTemplate[],
): WorkflowChatIntent | null {
  const trimmed = message.trim();
  if (CREATE_WORKFLOW_PATTERN.test(trimmed)) {
    return { kind: 'draft', request: trimmed, kickoff: stripWorkflowLead(trimmed) };
  }

  const template = templates
    .filter((candidate) => matchesNamedWorkflowCommand(trimmed, candidate.name))
    .toSorted((left, right) => right.name.length - left.name.length)[0];
  const kickoff = stripWorkflowLead(trimmed);
  if (template) return { kind: 'run', template, kickoff };
  if (RUN_GENERIC_WORKFLOW_PATTERN.test(trimmed) || USE_GENERIC_WORKFLOW_PATTERN.test(trimmed)) {
    return { kind: 'choose', kickoff };
  }
  return null;
}

function matchesNamedWorkflowCommand(message: string, templateName: string): boolean {
  const pattern = new RegExp(
    String.raw`${REQUEST_LEAD}(?:use|run|start|launch)\s+(?:the\s+)?${escapeRegExp(templateName)}(?:\s+workflow)?\b(?:\s+(?:to|for|with)\b|[.!?]?\s*$)`,
    'i',
  );
  return pattern.test(message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripWorkflowLead(value: string): string {
  const separated = value.match(/\b(?:to|for|with)\b\s+(.+)$/i)?.[1]?.trim();
  return separated || value.trim();
}
