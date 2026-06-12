import { describe, expect, it } from 'vitest';
import type { CodexRegisteredSkill } from '../../../../shared/types';
import {
  buildFileMentionOptionId,
  findActiveSkillMention,
  findActiveSlashCommand,
  getSkillMentionResults,
  getSlashCommandResults,
  shouldSendChatMessageFromKey,
  type ChatSlashCommand,
} from '../ChatInput';

describe('shouldSendChatMessageFromKey', () => {
  it('sends on Enter with or without command modifiers', () => {
    expect(shouldSendChatMessageFromKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(shouldSendChatMessageFromKey({ key: 'Enter', shiftKey: false, metaKey: true })).toBe(
      true,
    );
    expect(shouldSendChatMessageFromKey({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(
      true,
    );
  });

  it('keeps Shift+Enter available for new lines', () => {
    expect(shouldSendChatMessageFromKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('ignores non-send keys', () => {
    expect(shouldSendChatMessageFromKey({ key: 'Tab', shiftKey: false })).toBe(false);
    expect(shouldSendChatMessageFromKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});

describe('buildFileMentionOptionId', () => {
  it('builds stable DOM-safe ids for file mention options', () => {
    expect(
      buildFileMentionOptionId({
        repoId: 'repo 1',
        repoName: 'App',
        name: 'Thing.tsx',
        path: '/repo/src/components/Thing.tsx',
        relativePath: 'src/components/Thing.tsx',
        size: 123,
      }),
    ).toBe('chat-file-mention-option-repo-1-src-components-Thing-tsx');
  });
});

describe('findActiveSlashCommand', () => {
  it('detects slash commands only at the start of the composer', () => {
    expect(findActiveSlashCommand('/pl', 3)).toEqual({ start: 0, end: 3, query: 'pl' });
    expect(findActiveSlashCommand('please /pl', 10)).toBeNull();
    expect(findActiveSlashCommand('/plan ADO-', 10)).toBeNull();
  });
});

describe('findActiveSkillMention', () => {
  it('detects dollar-prefixed skill mentions at token boundaries', () => {
    expect(findActiveSkillMention('use $front', 10)).toEqual({
      start: 4,
      end: 10,
      query: 'front',
    });
    expect(findActiveSkillMention('cost is $front', 14)).toEqual({
      start: 8,
      end: 14,
      query: 'front',
    });
    expect(findActiveSkillMention('email$a', 7)).toBeNull();
  });
});

describe('getSlashCommandResults', () => {
  it('filters commands by command, label, and description', () => {
    const commands: ChatSlashCommand[] = [
      { id: 'plan', command: '/plan', label: 'Plan work item', description: 'Create a plan' },
      { id: 'fix', command: '/fix', label: 'Fix work item', description: 'Implement a ticket' },
    ];

    expect(getSlashCommandResults(commands, 'imp').map((command) => command.id)).toEqual(['fix']);
    expect(getSlashCommandResults(commands, '').map((command) => command.id)).toEqual([
      'plan',
      'fix',
    ]);
  });
});

describe('getSkillMentionResults', () => {
  it('filters skills by name, description, scope, and source', () => {
    const skills: CodexRegisteredSkill[] = [
      {
        id: 'project:add-feature',
        name: 'add-feature',
        description: 'Feature workflow',
        path: '/repo/.agents/skills/add-feature/SKILL.md',
        directory: '/repo/.agents/skills/add-feature',
        scope: 'project',
      },
      {
        id: 'plugin:frontend-app-builder',
        name: 'frontend-app-builder',
        description: 'Build UI',
        path: '/skills/frontend/SKILL.md',
        directory: '/skills/frontend',
        scope: 'plugin',
      },
    ];

    expect(getSkillMentionResults(skills, 'front').map((skill) => skill.name)).toEqual([
      'frontend-app-builder',
    ]);
    expect(getSkillMentionResults(skills, 'project').map((skill) => skill.name)).toEqual([
      'add-feature',
    ]);
  });
});
