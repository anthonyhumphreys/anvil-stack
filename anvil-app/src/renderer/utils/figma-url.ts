// src/renderer/utils/figma-url.ts

import type { FigmaFileRef, FigmaRefKind } from '../../shared/types';

/**
 * Figma URL patterns:
 *  - figma.com/design/:fileKey/:fileName?node-id=:nodeId
 *  - figma.com/design/:fileKey/branch/:branchKey/:fileName
 *  - figma.com/make/:makeFileKey/:makeFileName
 *  - figma.com/board/:fileKey/:fileName
 */
const FIGMA_URL_REGEX =
  /https?:\/\/(?:www\.)?figma\.com\/(design|board|make)\/([a-zA-Z0-9]+)(?:\/branch\/([a-zA-Z0-9]+))?(?:\/[^?\s]*)?(?:\?[^\s]*)?/g;

const NODE_ID_REGEX = /node-id=([^&\s]+)/;
const FIGMA_REF_LABELS: Record<FigmaRefKind, string> = {
  design: 'Figma Design file',
  board: 'FigJam board',
  make: 'Figma Make project',
};

export function extractFigmaRefs(text: string): FigmaFileRef[] {
  const refs: FigmaFileRef[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(FIGMA_URL_REGEX)) {
    const kind = match[1] as FigmaRefKind;
    const fileKey = match[3] ?? match[2]; // use branchKey if present, else fileKey
    const fullMatch = match[0];
    const refKey = `${kind}:${fileKey}`;

    if (seen.has(refKey)) continue;
    seen.add(refKey);

    let nodeId: string | undefined;
    const nodeMatch = fullMatch.match(NODE_ID_REGEX);
    if (nodeMatch) {
      // Convert dash-separated to colon-separated: "1-2" -> "1:2"
      nodeId = nodeMatch[1].replace(/-/g, ':');
    }

    refs.push({
      kind,
      fileKey,
      url: fullMatch,
      nodeId,
      fileName: undefined,
      addedAt: new Date().toISOString(),
    });
  }

  return refs;
}

export function containsFigmaUrl(text: string): boolean {
  FIGMA_URL_REGEX.lastIndex = 0;
  return FIGMA_URL_REGEX.test(text);
}

export function hasFigmaMakeRef(refs: FigmaFileRef[]): boolean {
  return refs.some((ref) => ref.kind === 'make');
}

export function formatFigmaRefsForPrompt(refs: FigmaFileRef[]): string {
  if (refs.length === 0) return '';

  const lines = refs.map((ref) => {
    const parts = [
      `- ${FIGMA_REF_LABELS[ref.kind]}: ${ref.url}`,
      `  Key: ${ref.fileKey}`,
      ref.nodeId ? `  Node: ${ref.nodeId}` : null,
    ].filter((line): line is string => Boolean(line));
    return parts.join('\n');
  });

  const includesMake = hasFigmaMakeRef(refs);
  const makeGuidance = includesMake
    ? [
        '',
        'For Figma Make links, use the Figma MCP resources capability before implementing:',
        '- List the available resources for the figma MCP server.',
        '- Fetch the relevant Make file resources, or the whole project if the user asks for broad context.',
        '- If multiple files are available and the target is ambiguous, ask which files to fetch.',
        '- If MCP resources are unavailable in this client, say so instead of guessing from the rendered link.',
        '- Reuse existing production components where possible instead of copying prototype code blindly.',
      ].join('\n')
    : '';

  return `[Figma context links]\n${lines.join('\n')}${makeGuidance}`;
}
