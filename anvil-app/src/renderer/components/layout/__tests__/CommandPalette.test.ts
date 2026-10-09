import { describe, expect, it } from 'vitest';
import {
  buildAskChatCommandMetadata,
  buildCommandPaletteOptionId,
  buildNewChatThreadCommandMetadata,
  buildToggleChatLayoutCommandMetadata,
  filterCommandPaletteCommands,
  groupPaletteCommands,
  looksLikeChatPrompt,
} from '../CommandPalette';

describe('looksLikeChatPrompt', () => {
  it('treats natural language input as a chat prompt', () => {
    expect(looksLikeChatPrompt('review this diff for auth bugs')).toBe(true);
    expect(looksLikeChatPrompt('why is the build failing?')).toBe(true);
    expect(looksLikeChatPrompt('fix: flaky terminal resize')).toBe(true);
  });

  it('keeps short command searches as palette searches', () => {
    expect(looksLikeChatPrompt('git')).toBe(false);
    expect(looksLikeChatPrompt('db')).toBe(false);
    expect(looksLikeChatPrompt('x')).toBe(false);
  });
});

describe('buildAskChatCommandMetadata', () => {
  it('builds the dynamic Ask Chat command for natural language input', () => {
    expect(buildAskChatCommandMetadata(' review this diff ', 'Anvil')).toEqual({
      id: 'dynamic-ask-chat',
      label: 'Ask Chat: review this diff',
      description: 'Use Anvil as the working context.',
      section: 'Ask',
      shortcut: 'Enter',
      keywords: ['ask', 'chat', 'review this diff'],
    });
  });

  it('falls back to a generic description without workspace context', () => {
    expect(buildAskChatCommandMetadata('fix tests').description).toBe(
      'Start a focused chat from this command.',
    );
  });
});

describe('buildNewChatThreadCommandMetadata', () => {
  it('describes a real clean-thread action', () => {
    expect(buildNewChatThreadCommandMetadata()).toEqual({
      id: 'act-new-chat',
      label: 'New Chat Thread',
      description: 'Start a clean conversation in Chat.',
      keywords: ['new', 'chat', 'thread', 'session', 'conversation'],
    });
  });
});

describe('buildToggleChatLayoutCommandMetadata', () => {
  it('describes the next chat layout action', () => {
    expect(buildToggleChatLayoutCommandMetadata('classic')).toMatchObject({
      id: 'act-toggle-chat-layout',
      label: 'Switch to Work-Item Chat',
      nextLayout: 'workitems',
    });

    expect(buildToggleChatLayoutCommandMetadata('workitems')).toMatchObject({
      label: 'Switch to Classic Chat',
      nextLayout: 'classic',
    });
  });
});

describe('buildCommandPaletteOptionId', () => {
  it('builds stable DOM-safe ids for command options', () => {
    expect(buildCommandPaletteOptionId('prompt:review/current diff')).toBe(
      'command-palette-option-prompt-review-current-diff',
    );
  });
});

describe('filterCommandPaletteCommands', () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    id: `thread-${index}`,
    label: `Jump to thread: Conversation ${index + 1}`,
    section: 'Threads',
    recent: index < 10,
  }));

  it('searches matching threads beyond the recent empty-query list', () => {
    expect(filterCommandPaletteCommands(threads, 'Conversation 12').map((item) => item.id)).toEqual(
      ['thread-11'],
    );
  });

  it('shows only the eight most recent active threads when the query is empty', () => {
    expect(filterCommandPaletteCommands(threads, '').map((item) => item.id)).toEqual(
      threads.slice(0, 8).map((item) => item.id),
    );
  });
});

describe('groupPaletteCommands', () => {
  it('returns one keyboard order that matches section rendering for repeated sections', () => {
    const commands = [
      { id: 'workspace-open', section: 'Workspace' },
      { id: 'thread-recent', section: 'Threads' },
      { id: 'workspace-activity', section: 'Workspace' },
    ];

    const groups = groupPaletteCommands(commands);
    expect(groups).toEqual([
      {
        section: 'Workspace',
        items: [commands[0], commands[2]],
      },
      { section: 'Threads', items: [commands[1]] },
    ]);
    expect(groups.flatMap((group) => group.items).map((item) => item.id)).toEqual([
      'workspace-open',
      'workspace-activity',
      'thread-recent',
    ]);
  });
});
