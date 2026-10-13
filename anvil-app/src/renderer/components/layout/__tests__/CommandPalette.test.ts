import { describe, expect, it } from 'vitest';
import {
  ASK_AGENT_SECTION,
  buildAskAgentCommands,
  buildAskChatCommandMetadata,
  buildPinToolCommandMetadata,
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

describe('buildAskAgentCommands (spec §12)', () => {
  const commands = buildAskAgentCommands();

  it('offers the four agent-backed replacements for removed tools', () => {
    expect(commands.map((command) => command.label)).toEqual([
      'Ask the agent: Run a security audit',
      'Ask the agent: Check dependencies',
      'Ask the agent: Analyse CI/CD',
      'Ask the agent: Review my changes',
    ]);
    expect(commands.every((command) => command.section === ASK_AGENT_SECTION)).toBe(true);
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });

  it('gates each command on its domain feature and carries a real prompt', () => {
    expect(commands.map((command) => command.feature)).toEqual([
      'security',
      'dependencies',
      'cicd',
      'codereview',
    ]);
    expect(commands.every((command) => command.prompt.length > 40)).toBe(true);
  });

  it('is findable by the removed tool names', () => {
    const findable = (query: string) =>
      filterCommandPaletteCommands(commands, query).map((command) => command.id);
    expect(findable('security')).toContain('ask-agent-security-audit');
    expect(findable('dependencies')).toContain('ask-agent-dependencies');
    expect(findable('pipeline')).toContain('ask-agent-cicd');
    expect(findable('review')).toContain('ask-agent-review-changes');
  });
});

describe('buildPinToolCommandMetadata', () => {
  const browser = { path: '/browser', label: 'Browser' };

  it('pins and unpins demoted tools', () => {
    expect(buildPinToolCommandMetadata(browser, [])).toMatchObject({
      id: 'pin-browser',
      label: 'Pin Browser to navigation',
      isPinned: false,
      disabled: false,
    });
    expect(buildPinToolCommandMetadata(browser, ['/browser'])).toMatchObject({
      label: 'Unpin Browser from navigation',
      isPinned: true,
      disabled: false,
    });
  });

  it('explains the pin cap instead of silently ignoring the toggle', () => {
    const full = ['/a', '/b', '/c', '/d', '/e'];
    const metadata = buildPinToolCommandMetadata(browser, full);
    expect(metadata.disabled).toBe(true);
    expect(metadata.description).toMatch(/Up to 5/);
  });
});
