import { describe, expect, it } from 'vitest';
import {
  buildMessageReusePrefill,
  getNewChatThreadActionLabel,
  groupChatEntries,
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

describe('groupChatEntries', () => {
  it('keeps streamed assistant prose coherent around tool activity', () => {
    const display = groupChatEntries([
      { kind: 'user', content: 'Deploy it' },
      { kind: 'assistant', content: 'The deployment' },
      { kind: 'event', event: { type: 'tool_call', toolName: 'shell' } },
      {
        kind: 'event',
        event: { type: 'command_exec', command: 'pnpm deploy', exitCode: 0 },
      },
      { kind: 'assistant', content: ' is progressing normally now.' },
    ]);

    expect(display.map((entry) => entry.kind)).toEqual(['user', 'activity-group', 'assistant']);
    expect(display[1]).toMatchObject({ kind: 'activity-group' });
    expect(display[2]).toMatchObject({
      kind: 'assistant',
      content: 'The deployment is progressing normally now.',
      sourceIndex: 4,
    });
  });

  it('does not merge assistant content across user turns', () => {
    const display = groupChatEntries([
      { kind: 'user', content: 'First' },
      { kind: 'assistant', content: 'First reply' },
      { kind: 'user', content: 'Second' },
      { kind: 'assistant', content: 'Second reply' },
    ]);

    expect(display.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(display[1]).toMatchObject({ content: 'First reply' });
    expect(display[3]).toMatchObject({ content: 'Second reply' });
  });

  it('keeps thinking before grouped activity and final prose', () => {
    const display = groupChatEntries([
      { kind: 'thinking', content: 'Checking the repository' },
      { kind: 'event', event: { type: 'file_read', filePath: 'package.json' } },
      { kind: 'assistant', content: 'Everything is configured.' },
    ]);

    expect(display.map((entry) => entry.kind)).toEqual(['thinking', 'event', 'assistant']);
  });
});
