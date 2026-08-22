import { describe, expect, it } from 'vitest';
import { buildArtifactAnnotationPrompt } from '../ArtifactAnnotationsPanel';

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
