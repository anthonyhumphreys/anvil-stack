import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === 'temp' ? '/tmp' : '/Users/test/Library/Application Support/Anvil',
    ),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../db/database.js', () => ({
  getDb: vi.fn(),
}));

vi.mock('../workspace.service.js', () => ({
  getWorkspace: vi.fn(),
}));

const { getSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(() => ({ theme: 'system' })),
}));

vi.mock('../settings.service.js', () => ({
  getSettings: () => getSettingsMock(),
}));

import {
  buildDirectVscodeServerArgs,
  buildEmbeddedEditorUserSettings,
  createWorkspaceSnapshotFile,
  buildWorkbenchUrl,
  buildVscodeWebArgs,
  collectAnvilEmbeddedEditorProcessTargets,
  findWorkspaceCodeWorkspaceFile,
  parseVscodeCommitId,
  parseProcessList,
} from '../embedded-editor.service.js';
import { getWorkspace } from '../workspace.service.js';

const getWorkspaceMock = vi.mocked(getWorkspace);
const tempDirs: string[] = [];

afterEach(() => {
  getWorkspaceMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseProcessList', () => {
  it('parses ps output with pid, parent pid, and command', () => {
    expect(
      parseProcessList(`
        101     1 /Applications/Visual Studio Code.app/Contents/MacOS/Code serve-web
        102   101 /Users/test/.vscode/cli/serve-web/node out/server-main.js
      `),
    ).toEqual([
      {
        pid: 101,
        ppid: 1,
        command: '/Applications/Visual Studio Code.app/Contents/MacOS/Code serve-web',
      },
      {
        pid: 102,
        ppid: 101,
        command: '/Users/test/.vscode/cli/serve-web/node out/server-main.js',
      },
    ]);
  });
});

describe('parseVscodeCommitId', () => {
  it('extracts the commit hash from code --version output', () => {
    expect(
      parseVscodeCommitId(`1.119.0
8b640eef5a6c6089c029249d48efa5c99adf7d51
arm64
`),
    ).toBe('8b640eef5a6c6089c029249d48efa5c99adf7d51');
  });

  it('returns null when no commit hash is present', () => {
    expect(parseVscodeCommitId('not code output')).toBeNull();
  });
});

describe('collectAnvilEmbeddedEditorProcessTargets', () => {
  const profileDir = '/Users/test/Library/Application Support/Anvil/embedded-editor/vscode-web';

  it('selects only Anvil-owned VS Code Web processes and sockets', () => {
    const targets = collectAnvilEmbeddedEditorProcessTargets(
      [
        {
          pid: 100,
          ppid: 1,
          command:
            '/Applications/Visual Studio Code.app/Contents/MacOS/Code /app/out/cli.js serve-web --server-data-dir /Users/test/Library/Application Support/Anvil/embedded-editor/vscode-web/user-data --default-workspace /tmp/anvil-editor-abc/App.code-workspace',
        },
        {
          pid: 101,
          ppid: 100,
          command:
            '/Users/test/.vscode/cli/serve-web/hash/node out/server-main.js --socket-path /tmp/code-anvil --server-data-dir /Users/test/Library/Application Support/Anvil/embedded-editor/vscode-web/user-data',
        },
        {
          pid: 200,
          ppid: 1,
          command:
            '/Applications/Visual Studio Code.app/Contents/MacOS/Code /app/out/cli.js --user-data-dir /Users/test/Library/Application Support/Code',
        },
      ],
      [profileDir],
    );

    expect(targets.pids).toEqual([101, 100]);
    expect(targets.socketPaths).toEqual(['/tmp/code-anvil']);
  });

  it('does not target ordinary desktop VS Code extension hosts', () => {
    const targets = collectAnvilEmbeddedEditorProcessTargets(
      [
        {
          pid: 300,
          ppid: 1,
          command:
            '/Users/test/.vscode/extensions/ms-dotnettools.csdevkit/Microsoft.VisualStudio.Code.Server --log-directory /Users/test/Library/Application Support/Code/logs',
        },
      ],
      [profileDir],
    );

    expect(targets).toEqual({ pids: [], socketPaths: [] });
  });

  it('cleans up Anvil editor processes', () => {
    const targets = collectAnvilEmbeddedEditorProcessTargets(
      [
        {
          pid: 400,
          ppid: 1,
          command:
            '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel serve-web --server-data-dir /tmp/anvil-editor-old/user-data',
        },
      ],
      [profileDir],
    );

    expect(targets.pids).toEqual([400]);
  });
});

describe('buildEmbeddedEditorUserSettings', () => {
  it('keeps user editor settings while forcing embedded-editor safety settings', () => {
    getSettingsMock.mockReturnValueOnce({ theme: 'system' });

    const settings = buildEmbeddedEditorUserSettings({
      'editor.fontSize': 15,
      'workbench.colorTheme': 'A user theme',
      'git.enabled': true,
    });

    expect(settings['editor.fontSize']).toBe(15);
    expect(settings['git.enabled']).toBe(false);
    expect(settings['chat.commandCenter.enabled']).toBe(false);
    expect(settings['window.autoDetectColorScheme']).toBe(true);
    expect(settings).not.toHaveProperty('workbench.colorTheme');
  });

  it('pins the embedded editor theme when the user chooses an app theme explicitly', () => {
    getSettingsMock.mockReturnValueOnce({ theme: 'dark' });

    const settings = buildEmbeddedEditorUserSettings({
      'editor.fontSize': 15,
      'workbench.colorTheme': 'A user theme',
    });

    expect(settings['window.autoDetectColorScheme']).toBe(false);
    expect(settings['workbench.colorTheme']).toBe('Default Dark Modern');
  });
});

describe('buildVscodeWebArgs', () => {
  it('starts VS Code Web with repo-noise extensions disabled', () => {
    const args = buildVscodeWebArgs({
      port: 1234,
      userDataDir: '/tmp/anvil/user-data',
      workspaceFilePath: '/tmp/anvil/Workspace.code-workspace',
    });

    expect(args).toContain('serve-web');
    expect(args).toContain('--without-connection-token');
    expect(args).toContain('--default-workspace');
    expect(args).toContain('/tmp/anvil/Workspace.code-workspace');
    expect(args).toEqual(
      expect.arrayContaining([
        '--disable-extension',
        'vscode.git',
        'vscode.github',
        'github.vscode-pull-request-github',
      ]),
    );
  });

  it('pins the VS Code Web server commit when known', () => {
    const args = buildVscodeWebArgs({
      port: 1234,
      userDataDir: '/tmp/anvil/user-data',
      workspaceFilePath: '/tmp/anvil/Workspace.code-workspace',
      commitId: '0958016b2af9f09bb4257e0df4a95e2f90590f9f',
    });

    expect(args).toEqual(
      expect.arrayContaining(['--commit-id', '0958016b2af9f09bb4257e0df4a95e2f90590f9f']),
    );
  });
});

describe('buildDirectVscodeServerArgs', () => {
  it('starts the cached VS Code server directly on loopback', () => {
    const args = buildDirectVscodeServerArgs({
      port: 1234,
      userDataDir: '/tmp/anvil/user-data',
      extensionsDir: '/tmp/anvil/extensions',
      workspaceFilePath: '/tmp/anvil/Workspace.code-workspace',
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--host',
        '127.0.0.1',
        '--port',
        '1234',
        '--extensions-dir',
        '/tmp/anvil/extensions',
        '--default-workspace',
        '/tmp/anvil/Workspace.code-workspace',
      ]),
    );
    expect(args).not.toContain('serve-web');
  });
});

describe('buildWorkbenchUrl', () => {
  it('adds an explicit workspace query for VS Code Web', () => {
    expect(
      buildWorkbenchUrl('http://127.0.0.1:1234', {
        type: 'workspace',
        path: '/tmp/Anvil.code-workspace',
      }),
    ).toBe('http://127.0.0.1:1234/?workspace=%2Ftmp%2FAnvil.code-workspace');
  });

  it('replaces the workspace query when an explicit folder URL is requested', () => {
    expect(
      buildWorkbenchUrl('http://127.0.0.1:1234/?workspace=%2Ftmp%2FAnvil.code-workspace', {
        type: 'folder',
        path: '/Users/test/repo',
      }),
    ).toBe('http://127.0.0.1:1234/?folder=%2FUsers%2Ftest%2Frepo');
  });
});

describe('createWorkspaceSnapshotFile', () => {
  it('uses the Anvil workspace repos instead of folders from a discovered workspace file', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'anvil-editor-workspace-'));
    tempDirs.push(rootDir);
    const repoPath = join(rootDir, 'repo-a');
    const staleRepoPath = join(rootDir, 'stale-repo');
    const sourceWorkspaceFile = join(rootDir, 'Demo.code-workspace');
    const runtimeDir = join(rootDir, 'runtime');
    mkdirSync(repoPath);
    mkdirSync(staleRepoPath);
    writeFileSync(
      sourceWorkspaceFile,
      JSON.stringify({
        folders: [{ path: staleRepoPath }],
        settings: {
          'editor.tabSize': 2,
          'git.enabled': true,
        },
      }),
      'utf8',
    );

    getWorkspaceMock.mockReturnValue({
      id: 'workspace-1',
      name: 'Demo',
      createdAt: '',
      updatedAt: '',
      repos: [
        {
          id: 'repo-1',
          name: 'repo-a',
          path: repoPath,
          defaultBranch: 'main',
          status: 'indexed',
          fileCount: 0,
          branchCount: 0,
          languages: [],
        },
      ],
    });

    const snapshotPath = createWorkspaceSnapshotFile(
      'workspace-1',
      runtimeDir,
      sourceWorkspaceFile,
    );
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      folders: Array<{ path: string }>;
      settings: Record<string, unknown>;
    };

    expect(snapshot.folders).toEqual([{ path: repoPath }]);
    expect(snapshot.settings['editor.tabSize']).toBe(2);
    expect(snapshot.settings['git.enabled']).toBe(false);
  });
});

describe('findWorkspaceCodeWorkspaceFile', () => {
  it('finds a VS Code workspace file next to a single attached repo', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'anvil-editor-workspace-'));
    tempDirs.push(rootDir);
    const repoPath = join(rootDir, 'repo-a');
    const workspaceFile = join(rootDir, 'Demo.code-workspace');
    mkdirSync(repoPath);
    writeFileSync(
      workspaceFile,
      JSON.stringify({
        folders: [{ path: repoPath }, { path: join(rootDir, 'repo-b') }],
      }),
      'utf8',
    );

    getWorkspaceMock.mockReturnValue({
      id: 'workspace-1',
      name: 'Demo',
      createdAt: '',
      updatedAt: '',
      repos: [
        {
          id: 'repo-1',
          name: 'repo-a',
          path: repoPath,
          defaultBranch: 'main',
          status: 'indexed',
          fileCount: 0,
          branchCount: 0,
          languages: [],
        },
      ],
    });

    expect(findWorkspaceCodeWorkspaceFile('workspace-1')).toBe(workspaceFile);
  });
});
