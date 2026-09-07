import type { WorkItem } from './types.js';

/** Render provider rich text as plain text without executing HTML or losing paragraph boundaries. */
export function workItemText(value: unknown): string {
  if (typeof value === 'string') {
    if (value.trim().startsWith('{')) {
      try {
        return workItemText(JSON.parse(value));
      } catch {
        /* plain text */
      }
    }
    return value
      .replace(/<\/(?:p|div|li|h[1-6])\s*>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
  }
  if (!value || typeof value !== 'object') return '';
  const node = value as { text?: unknown; content?: unknown[]; type?: string };
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? [])
    .map(workItemText)
    .join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n');
}
export function extractAcceptanceCriteria(
  item: Pick<WorkItem, 'acceptanceCriteria' | 'description'>,
): string {
  if (item.acceptanceCriteria?.trim()) return workItemText(item.acceptanceCriteria);
  const description = workItemText(item.description);
  const lines = description.split('\n');
  const start = lines.findIndex((line) =>
    /^(?:#{1,6}\s*)?(?:\*\*)?acceptance criteria(?:\*\*)?\s*:?\s*$/i.test(line.trim()),
  );
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s|^\*\*[^*]+\*\*\s*:?$/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}
export function buildWorkItemIntent(item: WorkItem, mode: 'plan' | 'implement'): string {
  return [
    mode === 'plan'
      ? 'Inspect the repository and produce a concrete implementation and verification plan for this work item. Stay in plan mode: do not modify code until I approve the plan. Identify material questions and propose reasonable defaults.'
      : 'Implement this work item. Inspect the repository and follow its instructions. Proceed with reasonable, reversible choices. If scope is ambiguous, the change is destructive, or a substantial design decision needs my input, present the concrete plan and ask before that dependent work. Otherwise implement and verify without an unnecessary approval round.',
    `Work item: ${item.id} — ${item.title}`,
    item.url ? `Source: ${item.url}` : '',
    `Description:\n${workItemText(item.description) || 'Not provided.'}`,
    `Acceptance criteria from the work item:\n${extractAcceptanceCriteria(item) || 'No explicit criteria provided. Propose criteria for confirmation; do not treat inferred expectations as approved.'}`,
    'Preserve established expectations. Report the exact checks run, their outcomes and what remains unchecked. A claim that work is fixed does not constitute human acceptance.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
