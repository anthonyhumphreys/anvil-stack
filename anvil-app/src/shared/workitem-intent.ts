import type { WorkItem } from './types.js';

/** Convert known provider HTML to display text. This is not an HTML sanitizer. */
function htmlText(value: string): string {
  let result = '';
  let cursor = 0;
  for (const token of value.matchAll(
    /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi,
  )) {
    result += value.slice(cursor, token.index);
    const tag = token[1]?.toLowerCase();
    if (tag && /^h[1-6]$/.test(tag) && !token[0].startsWith('</'))
      result += `\n${'#'.repeat(Number(tag[1]))} `;
    else if (
      tag === 'br' ||
      (token[0].startsWith('</') &&
        ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag))
    )
      result += '\n';
    cursor = token.index + token[0].length;
  }
  result += value.slice(cursor);
  const entities: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };
  return result
    .replace(/&(#x[0-9a-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
      if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity;
      const code =
        name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .trim();
}
/** Plain text and Markdown are preserved; only explicitly identified HTML is decoded. */
export function workItemText(value: unknown, format: 'text' | 'html' = 'text'): string {
  if (typeof value === 'string') return format === 'html' ? htmlText(value) : value;
  if (!value || typeof value !== 'object') return '';
  const node = value as {
    text?: unknown;
    content?: unknown[];
    type?: string;
    attrs?: { level?: number };
  };
  if (typeof node.text === 'string') return node.text;
  const text = (node.content ?? [])
    .map((child) => workItemText(child))
    .join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n');
  return node.type === 'heading'
    ? `${'#'.repeat(Math.min(6, Math.max(1, node.attrs?.level ?? 1)))} ${text}`
    : text;
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
