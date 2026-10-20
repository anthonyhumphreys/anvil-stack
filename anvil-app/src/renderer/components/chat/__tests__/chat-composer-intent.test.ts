import { describe, expect, it } from 'vitest';
import type { ChatFollowUpResult } from '../../../../shared/types';
import {
  appendComposerPrefill,
  getFollowUpFeedback,
  isCurrentComposerDraft,
} from '../chat-composer-intent';

describe('isCurrentComposerDraft', () => {
  it('only matches the unchanged draft in the same thread', () => {
    const submitted = { draftKey: 'thread-a', revision: 4 };

    expect(isCurrentComposerDraft(submitted, { draftKey: 'thread-a', revision: 4 })).toBe(true);
    expect(isCurrentComposerDraft(submitted, { draftKey: 'thread-b', revision: 4 })).toBe(false);
    expect(isCurrentComposerDraft(submitted, { draftKey: 'thread-a', revision: 5 })).toBe(false);
  });
});

describe('appendComposerPrefill', () => {
  it('appends to an existing draft without replacing it', () => {
    expect(appendComposerPrefill('Keep this draft', 'Add this prompt')).toBe(
      'Keep this draft\n\nAdd this prompt',
    );
    expect(appendComposerPrefill('  ', 'Add this prompt')).toBe('Add this prompt');
  });
});

describe('getFollowUpFeedback', () => {
  const result = (
    status: ChatFollowUpResult['status'],
    intent: ChatFollowUpResult['intent'],
    error?: string,
  ) => ({
    requestId: 'follow-up-1',
    intent,
    status,
    queueDepth: 0,
    error,
  });

  it('uses delivery-only wording for sent follow-ups', () => {
    expect(getFollowUpFeedback(result('delivered', 'guide'))).toEqual({
      kind: 'success',
      message: 'Sent to agent.',
    });
  });

  it('reports queued follow-ups and failures without implying task completion', () => {
    expect(getFollowUpFeedback(result('queued', 'queue')).message).toBe('Queued for the next run.');
    expect(getFollowUpFeedback(result('failed', 'guide', 'Session stopped.'))).toEqual({
      kind: 'error',
      message: 'Session stopped.',
    });
    expect(getFollowUpFeedback(result('failed', 'queue'))).toEqual({
      kind: 'error',
      message: 'The agent could not accept that message.',
    });
  });
});
