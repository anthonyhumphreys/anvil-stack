import { describe, expect, it } from 'vitest';
import {
  buildAskChatCommandMetadata,
  buildCommandPaletteOptionId,
  buildNewChatThreadCommandMetadata,
  buildToggleChatLayoutCommandMetadata,
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
