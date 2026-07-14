import { describe, expect, it } from 'vitest';
import {
  buildMessageReusePrefill,
  getNewChatThreadActionLabel,
  isNearChatBottom,
  shouldFocusChatComposerFromKey,
} from '../ChatView';

describe('isNearChatBottom', () => {
  it('treats scroll positions within the threshold as near the latest message', () => {
    expect(isNearChatBottom({ scrollHeight: 1000, scrollTop: 820, clientHeight: 100 })).toBe(true);
  });

  it('detects when the user has scrolled away from the latest message', () => {
    expect(isNearChatBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 100 })).toBe(false);
  });

  it('allows a custom threshold', () => {
    expect(isNearChatBottom({ scrollHeight: 1000, scrollTop: 840, clientHeight: 100 }, 48)).toBe(
      false,
    );
  });
});

const keyTarget = (closestEditable: boolean, editable = false): EventTarget =>
  ({
    isContentEditable: editable,
    closest: () => (closestEditable ? {} : null),
  }) as unknown as EventTarget;

describe('shouldFocusChatComposerFromKey', () => {
  it('uses slash as the composer focus shortcut outside editable controls', () => {
    expect(shouldFocusChatComposerFromKey({ key: '/', target: keyTarget(false) })).toBe(true);
  });

  it('ignores other keys', () => {
    expect(shouldFocusChatComposerFromKey({ key: 'k', target: keyTarget(false) })).toBe(false);
  });

  it('does not steal slash from inputs or contenteditable regions', () => {
    expect(shouldFocusChatComposerFromKey({ key: '/', target: keyTarget(true) })).toBe(false);
    expect(shouldFocusChatComposerFromKey({ key: '/', target: keyTarget(false, true) })).toBe(
      false,
    );
  });
});

describe('getNewChatThreadActionLabel', () => {
  it('uses thread wording for the new chat action', () => {
    expect(getNewChatThreadActionLabel()).toBe('New thread');
  });
});

describe('buildMessageReusePrefill', () => {
  it('preserves authored content but trims trailing whitespace for composer reuse', () => {
    expect(buildMessageReusePrefill('Refactor this module\n\n')).toBe('Refactor this module');
  });
});
