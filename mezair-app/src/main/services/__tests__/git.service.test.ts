import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  raw: vi.fn(),
  commit: vi.fn(),
  callLlm: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    status: mocks.status,
    raw: mocks.raw,
    commit: mocks.commit,
  })),
}));

vi.mock('../llm.service.js', () => ({
  callLlm: mocks.callLlm,
}));

import { commitChanges, generateConventionalCommitMessage } from '../git.service.js';

describe('generateConventionalCommitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.raw.mockImplementation((args: string[]) => {
      const command = args.join(' ');
      if (command.includes('--stat')) {
        return Promise.resolve(' src/renderer/components/settings/SettingsView.tsx | 42 +++++');
      }
      return Promise.resolve('diff --git a/src/settings.tsx b/src/settings.tsx');
    });
  });

  it('uses the configured LLM to produce a conventional commit message', async () => {
    mocks.status.mockResolvedValue({
      files: [
        {
          path: 'src/renderer/components/settings/SettingsView.tsx',
          index: 'M',
          working_dir: ' ',
        },
      ],
    });
    mocks.callLlm.mockResolvedValue('`feat(settings): add codex agents editor`');

    const message = await generateConventionalCommitMessage('/repo');

    expect(message).toBe('feat(settings): add codex agents editor');
    expect(mocks.callLlm).toHaveBeenCalledWith(
      expect.stringContaining('Mode: Use staged changes only.'),
      160,
      0.2,
      1,
      expect.objectContaining({ cwd: '/repo', taskClass: 'short-summary' }),
    );
  });

  it('falls back to the heuristic when the LLM response is invalid', async () => {
    mocks.status.mockResolvedValue({
      files: [
        {
          path: 'prompts/personas/workshop-planner.md',
          index: '?',
          working_dir: '?',
        },
      ],
    });
    mocks.callLlm.mockResolvedValue('Ship the meeting, probably.');

    const message = await generateConventionalCommitMessage('/repo');

    expect(message).toBe('docs(prompts): add prompts');
  });
});

describe('commitChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({
      files: [
        {
          path: 'src/main/services/git.service.ts',
          index: 'M',
          working_dir: ' ',
        },
      ],
    });
    mocks.raw.mockResolvedValue(
      'diff --git a/src/main/services/git.service.ts b/src/main/services/git.service.ts',
    );
    mocks.commit.mockResolvedValue({ commit: 'abc123' });
  });

  it('generates a commit message when none is supplied', async () => {
    mocks.callLlm.mockResolvedValue('feat(git): generate commit messages with llm');

    const hash = await commitChanges('/repo', '');

    expect(hash).toBe('abc123');
    expect(mocks.commit).toHaveBeenCalledWith('feat(git): generate commit messages with llm');
  });
});
