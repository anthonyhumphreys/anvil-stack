import { describe, expect, it } from 'vitest';
import { buildArtifactAnnotationPrompt } from '../ArtifactAnnotationsPanel';
import {
  buildArtifactAnnotationBody,
  formatChatReviewFeedbackPrompt,
} from '../chat-review-feedback';

describe('buildArtifactAnnotationPrompt', () => {
  it('preserves the artifact identity, note, and multiline quote as structured chat context', () => {
    expect(
      buildArtifactAnnotationPrompt(
        { title: 'Architecture', relativePath: 'plans/architecture.md' },
        { body: 'Clarify this boundary.', quote: 'Provider\nAdapter' },
      ),
    ).toBe(
      'Please address this annotation on “Architecture” (plans/architecture.md):\n\n' +
        'Clarify this boundary.\n\nQuoted selection:\n> Provider\n> Adapter',
    );
  });
});

describe('artifact feedback provenance', () => {
  const source = {
    kind: 'artifact' as const,
    artifactId: 'artifact-1',
    title: 'Architecture',
    path: 'plans/architecture.md',
    storage: 'repository' as const,
    revision: { kind: 'artifact-version' as const, version: 4 },
    lineRange: { startLine: 8, endLine: 9 },
    quote: 'Provider\nAdapter',
  };

  it('keeps source, revision, selected lines, quote, and feedback in the composer prompt', () => {
    expect(
      formatChatReviewFeedbackPrompt({
        threadId: 'thread-1',
        source,
        body: 'Clarify this boundary.',
      }),
    ).toBe(
      'Please review this feedback.\n' +
        'Artifact: “Architecture” (plans/architecture.md)\n' +
        'Revision: artifact version v4\n' +
        'Location: lines 8–9\n\n' +
        'Selected source:\n> Provider\n> Adapter\n\n' +
        'Feedback:\nClarify this boundary.',
    );
  });

  it('persists artifact revision and line provenance in the annotation body', () => {
    expect(buildArtifactAnnotationBody(source, 'Clarify this boundary.')).toBe(
      'Source: plans/architecture.md · artifact v4 · lines 8–9\n\nClarify this boundary.',
    );
  });

  it('labels patch fingerprints as snapshots rather than commits', () => {
    expect(
      formatChatReviewFeedbackPrompt({
        threadId: 'thread-1',
        source: {
          kind: 'diff',
          path: 'src/file.ts',
          revision: { kind: 'patch-snapshot', sha256: 'abc123' },
          lineRange: { side: 'new', startLine: 12, endLine: 12 },
          quote: 'const ready = true;',
        },
        body: 'Keep this behind the feature flag.',
      }),
    ).toContain('Revision: patch snapshot SHA-256 abc123 (not a Git commit)');
  });
});
