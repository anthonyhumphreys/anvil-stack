import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => {
  type RepoRow = { id: string; name: string; path: string };
  const repos = new Map<string, RepoRow>();
  return {
    repos,
    prepare: vi.fn(() => ({
      get: (repoId: string) => repos.get(repoId),
    })),
  };
});

vi.mock('../../db/database.js', () => ({
  getDb: () => ({
    prepare: dbMock.prepare,
  }),
}));

import {
  clearChatFileMentionCache,
  searchChatFileMentions,
} from '../chat-file-mention.service.js';

describe('searchChatFileMentions', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'anvil-file-mentions-'));
    dbMock.repos.clear();
    dbMock.prepare.mockClear();
    clearChatFileMentionCache();

    mkdirSync(join(repoPath, 'src/renderer/components/chat'), { recursive: true });
    mkdirSync(join(repoPath, 'src/main'), { recursive: true });
    mkdirSync(join(repoPath, 'node_modules/nope'), { recursive: true });
    writeFileSync(join(repoPath, 'README.md'), '# Test repo');
    writeFileSync(join(repoPath, 'package.json'), '{"name":"test"}');
    writeFileSync(join(repoPath, 'src/renderer/components/chat/ChatInput.tsx'), 'export {};');
    writeFileSync(join(repoPath, 'src/main/index.ts'), 'export {};');
    writeFileSync(join(repoPath, 'node_modules/nope/ignored.ts'), 'export {};');
    writeFileSync(join(repoPath, 'logo.png'), 'not really a png');

    dbMock.repos.set('repo-1', {
      id: 'repo-1',
      name: 'DevHub',
      path: repoPath,
    });
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
    clearChatFileMentionCache();
  });

  it('ranks matching source files and returns attachable absolute paths', async () => {
    const results = await searchChatFileMentions({
      repoIds: ['repo-1'],
      query: 'chatinput',
      limit: 5,
    });

    expect(results[0]).toMatchObject({
      repoId: 'repo-1',
      repoName: 'DevHub',
      relativePath: 'src/renderer/components/chat/ChatInput.tsx',
      name: 'ChatInput.tsx',
      path: join(repoPath, 'src/renderer/components/chat/ChatInput.tsx'),
    });
  });

  it('keeps default suggestions useful and skips ignored or binary files', async () => {
    const results = await searchChatFileMentions({
      repoIds: ['repo-1', 'repo-1', 'missing-repo'],
      query: '',
      limit: 10,
    });

    expect(results.map((result) => result.relativePath)).toContain('README.md');
    expect(results.map((result) => result.relativePath)).toContain('package.json');
    expect(results.map((result) => result.relativePath)).not.toContain(
      'node_modules/nope/ignored.ts',
    );
    expect(results.map((result) => result.relativePath)).not.toContain('logo.png');
  });
});
