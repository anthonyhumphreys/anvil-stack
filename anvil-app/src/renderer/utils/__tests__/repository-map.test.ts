import { describe, expect, it } from 'vitest';
import type { ModuleSummary, RepositoryChangedFile } from '../../../shared/types';
import { findModuleForFile, groupChangesByModule } from '../repository-map';

const modules: ModuleSummary[] = [
  {
    path: '.',
    purpose: 'Repository root',
    fileCount: 3,
    keyFiles: [],
    dependencies: [],
  },
  {
    path: 'src',
    purpose: 'Application source',
    fileCount: 20,
    keyFiles: [],
    dependencies: [],
  },
  {
    path: 'src/renderer',
    purpose: 'Renderer',
    fileCount: 10,
    keyFiles: [],
    dependencies: [],
  },
];

describe('findModuleForFile', () => {
  it('uses the most specific indexed module path', () => {
    expect(findModuleForFile(modules, 'src/renderer/App.tsx')).toBe('src/renderer');
    expect(findModuleForFile(modules, 'src/main/index.ts')).toBe('src');
  });

  it('falls back to the repository root for unmatched files', () => {
    expect(findModuleForFile(modules, 'package.json')).toBe('.');
  });
});

describe('groupChangesByModule', () => {
  it('groups and counts added, modified, renamed, and deleted files', () => {
    const files: RepositoryChangedFile[] = [
      { filePath: 'src/renderer/NewPanel.tsx', status: 'added' },
      { filePath: 'src/renderer/App.tsx', status: 'modified' },
      { filePath: 'src/main/old.ts', status: 'deleted' },
      { filePath: 'README.md', previousPath: 'README.txt', status: 'renamed' },
    ];

    expect(groupChangesByModule(modules, files)).toEqual([
      {
        modulePath: 'src/renderer',
        files: [files[1], files[0]],
        counts: { added: 1, modified: 1, deleted: 0, renamed: 0 },
      },
      {
        modulePath: '.',
        files: [files[3]],
        counts: { added: 0, modified: 0, deleted: 0, renamed: 1 },
      },
      {
        modulePath: 'src',
        files: [files[2]],
        counts: { added: 0, modified: 0, deleted: 1, renamed: 0 },
      },
    ]);
  });
});
