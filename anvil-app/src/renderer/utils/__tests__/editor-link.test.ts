import { describe, expect, it } from 'vitest';
import { parseEditorFileLocation } from '../../../shared/editor-file-link';
import { buildEditorUrl, parseEditorSearchParams } from '../editor-link';

describe('editor-link', () => {
  it('builds an editor URL with file context', () => {
    const url = buildEditorUrl({
      workspaceId: 'ws-1',
      repoId: 'repo-1',
      relativePath: 'src/main/index.ts',
      line: 42,
      source: 'codereview',
      title: 'src/main/index.ts:42',
    });

    expect(url).toBe(
      '/editor?workspaceId=ws-1&repoId=repo-1&path=src%2Fmain%2Findex.ts&line=42&source=codereview&title=src%2Fmain%2Findex.ts%3A42',
    );
  });

  it('normalises colon line suffixes when building editor URLs', () => {
    const url = buildEditorUrl({
      workspaceId: 'ws-1',
      absolutePath: '/Users/demo/repo/src/main/index.ts:42:7',
      source: 'chat',
      title: 'index.ts:42',
    });

    expect(url).toBe(
      '/editor?workspaceId=ws-1&absolutePath=%2FUsers%2Fdemo%2Frepo%2Fsrc%2Fmain%2Findex.ts&line=42&column=7&source=chat&title=index.ts%3A42',
    );
  });

  it('parses editor search params back into a target', () => {
    const params = new URLSearchParams(
      'workspaceId=ws-2&repoId=repo-2&absolutePath=%2Ftmp%2Fdemo.ts&line=18&column=4&source=chat&title=demo.ts%3A18',
    );

    expect(parseEditorSearchParams(params)).toEqual({
      workspaceId: 'ws-2',
      repoId: 'repo-2',
      repoName: undefined,
      relativePath: undefined,
      absolutePath: '/tmp/demo.ts',
      line: 18,
      column: 4,
      source: 'chat',
      title: 'demo.ts:18',
    });
  });

  it('parses editor search params with line suffixes embedded in paths', () => {
    const params = new URLSearchParams(
      'workspaceId=ws-2&path=src%2Frenderer%2FApp.tsx%3A31&absolutePath=%2Ftmp%2Fdemo.ts%3A18%3A4&source=chat',
    );

    expect(parseEditorSearchParams(params)).toEqual({
      workspaceId: 'ws-2',
      repoId: undefined,
      repoName: undefined,
      relativePath: 'src/renderer/App.tsx',
      absolutePath: '/tmp/demo.ts',
      line: 18,
      column: 4,
      source: 'chat',
      title: undefined,
    });
  });

  it('parses hash-style file anchors embedded in paths', () => {
    const params = new URLSearchParams(
      'workspaceId=ws-2&absolutePath=%2Ftmp%2Fdemo.ts%23L28&source=chat',
    );

    expect(parseEditorSearchParams(params)).toMatchObject({
      absolutePath: '/tmp/demo.ts',
      line: 28,
    });
  });

  it('recognises chat file links without treating external URLs as editor paths', () => {
    expect(parseEditorFileLocation('src/renderer/App.tsx:31')).toEqual({
      path: 'src/renderer/App.tsx',
      line: 31,
      column: undefined,
      isAbsolute: false,
    });
    expect(parseEditorFileLocation('/tmp/demo.ts#L28')).toMatchObject({
      path: '/tmp/demo.ts',
      line: 28,
      isAbsolute: true,
    });
    expect(parseEditorFileLocation('https://example.com/src/App.tsx#L1')).toBeNull();
  });
});
