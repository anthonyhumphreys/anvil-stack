export interface ReviewLineRange {
  startLine: number;
  endLine: number;
  side?: 'old' | 'new';
}

export type ChatReviewRevision =
  | { kind: 'artifact-version'; version: number }
  | { kind: 'git-commit'; sha: string }
  | { kind: 'patch-snapshot'; sha256: string };

export type ChatReviewFeedbackSource =
  | {
      kind: 'artifact';
      artifactId: string;
      title: string;
      path: string;
      storage: 'repository' | 'session';
      revision: Extract<ChatReviewRevision, { kind: 'artifact-version' }>;
      lineRange?: ReviewLineRange;
      quote?: string;
    }
  | {
      kind: 'diff';
      path: string;
      revision: Exclude<ChatReviewRevision, { kind: 'artifact-version' }>;
      lineRange: ReviewLineRange & { side: 'old' | 'new' };
      quote: string;
    };

export interface ChatReviewFeedbackDraft {
  threadId: string;
  source: ChatReviewFeedbackSource;
  body: string;
}

export interface DiffReviewPosition {
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  anchorLine: number;
}

export function formatChatReviewFeedbackPrompt(draft: ChatReviewFeedbackDraft): string {
  const { source } = draft;
  const revision =
    source.revision.kind === 'artifact-version'
      ? `artifact version v${source.revision.version}`
      : source.revision.kind === 'git-commit'
        ? `Git commit ${source.revision.sha}`
        : `patch snapshot SHA-256 ${source.revision.sha256} (not a Git commit)`;
  const lineRange = source.lineRange
    ? `\nLocation: ${source.lineRange.side ? `${source.lineRange.side} side, ` : ''}${formatLineRange(source.lineRange)}`
    : '';
  const quote = source.quote
    ? `\n\nSelected source:\n${source.quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`
    : '';
  const heading =
    source.kind === 'artifact'
      ? `Artifact: “${source.title}” (${source.path}${source.storage === 'session' ? '; session-only' : ''})`
      : `Diff: ${source.path}`;

  return `Please review this feedback.\n${heading}\nRevision: ${revision}${lineRange}${quote}\n\nFeedback:\n${draft.body.trim()}`;
}

export function buildArtifactAnnotationBody(
  source: Extract<ChatReviewFeedbackSource, { kind: 'artifact' }>,
  body: string,
): string {
  const lines = source.lineRange ? ` · ${formatLineRange(source.lineRange)}` : '';
  const storage = source.storage === 'session' ? ' · session-only' : '';
  return `Source: ${source.path} · artifact v${source.revision.version}${storage}${lines}\n\n${body.trim()}`;
}

export function formatLineRange(range: Pick<ReviewLineRange, 'startLine' | 'endLine'>): string {
  return range.startLine === range.endLine
    ? `line ${range.startLine}`
    : `lines ${range.startLine}–${range.endLine}`;
}

export async function fingerprintPatchSnapshot(patch: string): Promise<string> {
  const bytes = new TextEncoder().encode(patch);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
