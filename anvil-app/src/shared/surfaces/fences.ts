// Fallback protocol (§6.4): ```artifact and ```sketch fences parsed while the
// reply streams, so they render as surfaces and never as code blocks. The
// header grammar matches the post-turn extractor in ChatContext:
//   ```artifact:path/to/file.md kind=markdown title="Title" encoding=file storage=session
//   ```sketch title="Title" height=320

import type {
  ChatArtifactContentEncoding,
  ChatArtifactKind,
  ChatArtifactStorage,
} from '../types.js';

export type SurfaceFenceKind = 'artifact' | 'sketch';

export interface SurfaceFenceHeader {
  /** `path=` wins over the `:path` suffix, as in the post-turn extractor. */
  path?: string;
  title?: string;
  kind?: ChatArtifactKind;
  encoding?: ChatArtifactContentEncoding;
  storage?: ChatArtifactStorage;
  /** Sketch height hint in px. */
  height?: number;
  /** Every `key=value` token, including unknown ones. */
  attributes: Record<string, string>;
  /** Raw info string after the fence keyword. */
  raw: string;
}

export interface SurfaceFenceTextSegment {
  type: 'text';
  text: string;
}

export interface SurfaceFenceBlockSegment {
  type: SurfaceFenceKind;
  /** Ordinal among fence blocks in the text; stable while streaming. */
  index: number;
  header: SurfaceFenceHeader;
  body: string;
  /** False while the closing fence has not arrived yet. */
  complete: boolean;
  start: number;
  end: number;
}

export type SurfaceFenceSegment = SurfaceFenceTextSegment | SurfaceFenceBlockSegment;

const ARTIFACT_KINDS = new Set<string>([
  'markdown',
  'mermaid',
  'code',
  'html',
  'docx',
  'pptx',
  'pdf',
  'csv',
  'xlsx',
  'diagram',
  'data',
  'text',
]);

const OPENER = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const SURFACE_INFO = /^(artifact|sketch)(?::([^\s`]+))?(?=\s|$)([^`]*)$/;
const TOKEN = /(\w+)=(?:"([^"]*)"|'([^']*)'|([^\s"'][^\s]*))/g;

interface Line {
  text: string;
  start: number;
  /** Offset after the line terminator (or text end). */
  end: number;
  terminated: boolean;
}

/** True when `text` contains at least one surface fence opener (cheap pre-check). */
export function hasSurfaceFence(text: string): boolean {
  return /(^|\n) {0,3}(`{3,}|~{3,})(artifact|sketch)\b/.test(text);
}

export function parseSurfaceFenceHeader(info: string): SurfaceFenceHeader | null {
  const match = SURFACE_INFO.exec(info.trim());
  if (!match) return null;
  const header: SurfaceFenceHeader = { attributes: {}, raw: info.trim().slice(match[1].length) };
  if (match[2]) header.path = match[2];
  TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = TOKEN.exec(match[3] ?? '')) !== null) {
    const key = token[1];
    const value = token[2] ?? token[3] ?? token[4] ?? '';
    header.attributes[key] = value;
    if (key === 'path' && value) header.path = value;
    else if (key === 'title' && value) header.title = value;
    else if (key === 'kind' && ARTIFACT_KINDS.has(value)) header.kind = value as ChatArtifactKind;
    else if (key === 'encoding' && (value === 'utf8' || value === 'base64' || value === 'file')) {
      header.encoding = value;
    } else if (
      (key === 'storage' || key === 'persist') &&
      (value === 'repository' || value === 'session')
    ) {
      header.storage = value;
    } else if (key === 'height' && /^\d+$/.test(value)) {
      const height = Number(value);
      if (height > 0) header.height = Math.min(height, 20_000);
    }
  }
  return header;
}

/**
 * Splits accumulated (possibly partial) reply text into prose and surface
 * fence segments. Fences inside ordinary code blocks stay text. Inside a
 * surface fence, an inner block opened with an info string (```ts) is nested,
 * so its bare closing fence does not end the surface.
 */
export function parseSurfaceFences(text: string): SurfaceFenceSegment[] {
  const segments: SurfaceFenceSegment[] = [];
  const lines = splitLines(text);
  let textStart = 0;
  let fenceIndex = 0;
  let index = 0;

  const pushText = (end: number) => {
    if (end > textStart) {
      const previous = segments[segments.length - 1];
      const chunk = text.slice(textStart, end);
      if (previous?.type === 'text') previous.text += chunk;
      else segments.push({ type: 'text', text: chunk });
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const opener = OPENER.exec(line.text);
    if (!opener) {
      index += 1;
      continue;
    }
    const marker = opener[1];
    const info = opener[2].trim();
    const header = parseSurfaceFenceHeader(info);

    if (!header) {
      // Ordinary code block: skip to its close so example fences inside stay text.
      if (marker[0] === '`' && info.includes('`')) {
        index += 1;
        continue;
      }
      index = findClose(lines, index + 1, marker, false).next;
      continue;
    }

    pushText(line.start);
    const kind = info.startsWith('sketch') ? 'sketch' : 'artifact';
    if (!line.terminated) {
      segments.push({
        type: kind,
        index: fenceIndex,
        header,
        body: '',
        complete: false,
        start: line.start,
        end: text.length,
      });
      textStart = text.length;
      break;
    }

    const close = findClose(lines, index + 1, marker, true);
    const bodyStart = line.end;
    if (close.closeLine !== undefined) {
      const closing = lines[close.closeLine];
      segments.push({
        type: kind,
        index: fenceIndex++,
        header,
        body: text.slice(bodyStart, closing.start).replace(/\s+$/, ''),
        complete: true,
        start: line.start,
        end: closing.end,
      });
      textStart = closing.end;
      index = close.closeLine + 1;
    } else {
      let body = text.slice(bodyStart);
      // Hold back a trailing partial closing fence so it never flashes as content.
      body = body.replace(/(^|\n) {0,3}[`~]{1,}[ \t]*$/, '$1');
      segments.push({
        type: kind,
        index: fenceIndex,
        header,
        body,
        complete: false,
        start: line.start,
        end: text.length,
      });
      textStart = text.length;
      break;
    }
  }

  pushText(text.length);
  return segments;
}

function findClose(
  lines: Line[],
  from: number,
  marker: string,
  allowNesting: boolean,
): { closeLine?: number; next: number } {
  let inner: string | null = null;
  for (let index = from; index < lines.length; index += 1) {
    const match = OPENER.exec(lines[index].text);
    if (!match) continue;
    const candidate = match[1];
    const info = match[2].trim();
    const bare = info.length === 0;
    if (inner) {
      if (bare && candidate[0] === inner[0] && candidate.length >= inner.length) inner = null;
      continue;
    }
    if (bare && candidate[0] === marker[0] && candidate.length >= marker.length) {
      return { closeLine: index, next: index + 1 };
    }
    if (allowNesting && !bare && !(candidate[0] === '`' && info.includes('`'))) inner = candidate;
  }
  return { next: lines.length };
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), start, end: text.length, terminated: false });
      break;
    }
    const raw = text.slice(start, newline);
    lines.push({
      text: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
      start,
      end: newline + 1,
      terminated: true,
    });
    start = newline + 1;
  }
  return lines;
}
