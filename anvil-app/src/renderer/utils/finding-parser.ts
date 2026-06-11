import type { BaFindingType } from '../../shared/types.js';

const VALID_TYPES = new Set<BaFindingType>([
  'compliance',
  'feasibility',
  'dependency',
  'question',
  'risk',
]);
// Matches both :::finding type=X\n...\n::: and :::finding[X] ...\n:::
const FINDING_ATTR_REGEX = /:::finding\s+type=(\w+)\n([\s\S]*?):::/g;
const FINDING_BRACKET_REGEX = /:::finding\[(\w+)\]\s*([\s\S]*?):::/g;

export interface ExtractedFinding {
  type: BaFindingType;
  content: string;
}

export type MessageSegment =
  | { kind: 'text'; content: string }
  | { kind: 'finding'; type: BaFindingType; content: string };

export function extractFindings(text: string): ExtractedFinding[] {
  return splitByFindings(text)
    .filter((segment): segment is Extract<MessageSegment, { kind: 'finding' }> => {
      return segment.kind === 'finding';
    })
    .map(({ type, content }) => ({ type, content }));
}

export function stripFindingMarkers(text: string): string {
  return text.replace(FINDING_ATTR_REGEX, '').replace(FINDING_BRACKET_REGEX, '').trim();
}

const COMBINED_FINDING_REGEX = new RegExp(
  `(?:${FINDING_ATTR_REGEX.source}|${FINDING_BRACKET_REGEX.source})`,
  'g',
);

function parseFindingMatch(match: RegExpExecArray): { type: string; content: string } {
  // attr regex: match[1] = type, match[2] = content
  // bracket regex: match[3] = type, match[4] = content
  const type = match[1] ?? match[3] ?? '';
  const content = (match[2] ?? match[4] ?? '').trim();
  return { type, content };
}

/**
 * Splits message text into alternating text and finding segments
 * for inline rendering of findings within the chat.
 */
export function splitByFindings(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  COMBINED_FINDING_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = COMBINED_FINDING_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) segments.push({ kind: 'text', content: before });
    }

    const { type, content } = parseFindingMatch(match);
    if (VALID_TYPES.has(type as BaFindingType) && content.length > 0) {
      segments.push({ kind: 'finding', type: type as BaFindingType, content });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) segments.push({ kind: 'text', content: remaining });
  }

  if (segments.length === 0 && text.trim()) {
    segments.push({ kind: 'text', content: text.trim() });
  }

  return segments;
}
