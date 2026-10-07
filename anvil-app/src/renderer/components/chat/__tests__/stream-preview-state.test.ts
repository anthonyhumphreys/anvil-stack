import { describe, expect, it } from 'vitest';
import {
  beginStablePreview,
  createStablePreviewState,
  rejectStablePreview,
  resolveStablePreview,
} from '../stream-preview-state';

describe('stable stream preview state', () => {
  it('keeps the last successful preview visible while a replacement renders', () => {
    const previous = resolveStablePreview(
      beginStablePreview(createStablePreviewState<string>(), 'artifact-a', 'graph A', 1),
      'artifact-a',
      'graph A',
      1,
      '<svg>A</svg>',
    );

    const pending = beginStablePreview(previous, 'artifact-a', 'graph B', 2);

    expect(pending.value).toBe('<svg>A</svg>');
    expect(pending.renderedSource).toBe('graph A');
    expect(pending.requestedSource).toBe('graph B');
    expect(pending.status).toBe('pending');
  });

  it('ignores stale completions and errors after a newer source starts', () => {
    const firstPending = beginStablePreview(
      createStablePreviewState<string>(),
      'artifact-a',
      'graph A',
      1,
    );
    const first = resolveStablePreview(firstPending, 'artifact-a', 'graph A', 1, '<svg>A</svg>');
    const second = beginStablePreview(first, 'artifact-a', 'graph B', 2);
    const secondResolved = resolveStablePreview(second, 'artifact-a', 'graph B', 2, '<svg>B</svg>');

    expect(
      resolveStablePreview(secondResolved, 'artifact-a', 'graph A', 1, '<svg>A late</svg>'),
    ).toBe(secondResolved);
    expect(rejectStablePreview(secondResolved, 'artifact-a', 'graph A', 1, 'stale failure')).toBe(
      secondResolved,
    );
    expect(secondResolved.value).toBe('<svg>B</svg>');
  });

  it('retains the previous preview and records a failed replacement', () => {
    const previous = resolveStablePreview(
      beginStablePreview(createStablePreviewState<string>(), 'artifact-a', 'graph A', 1),
      'artifact-a',
      'graph A',
      1,
      '<svg>A</svg>',
    );

    const pending = beginStablePreview(previous, 'artifact-a', 'graph B', 2);
    const failed = rejectStablePreview(pending, 'artifact-a', 'graph B', 2, 'Invalid diagram');

    expect(failed.value).toBe('<svg>A</svg>');
    expect(failed.renderedSource).toBe('graph A');
    expect(failed.status).toBe('error');
    expect(failed.error).toBe('Invalid diagram');
  });

  it('clears retained content when the preview identity changes', () => {
    const previous = resolveStablePreview(
      beginStablePreview(createStablePreviewState<string>(), 'artifact-a', 'graph A', 1),
      'artifact-a',
      'graph A',
      1,
      '<svg>A</svg>',
    );

    const nextArtifact = beginStablePreview(previous, 'artifact-b', 'graph B', 2);

    expect(nextArtifact.value).toBeNull();
    expect(nextArtifact.identity).toBe('artifact-b');
    expect(nextArtifact.status).toBe('pending');
  });
});
