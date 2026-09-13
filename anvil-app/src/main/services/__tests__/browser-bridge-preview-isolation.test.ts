import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const location = vi.hoisted(() => ({ path: '' }));
vi.mock('../../../shared/preview-build.js', () => ({
  previewBuild: { buildId: 'candidate-build' },
}));
vi.mock('../../utils/app-paths.js', () => ({
  getPrimaryHiddenDirPath: () => join(location.path, 'normal'),
  getLegacyHiddenDirPath: () => join(location.path, 'legacy'),
}));
let service: typeof import('../browser.service.js');
afterEach(() => {
  service?.stopBridge();
  if (location.path) rmSync(location.path, { recursive: true, force: true });
});

describe('preview browser bridge discovery', () => {
  it('writes and removes only its own discovery file, preserving normal and legacy bridges', async () => {
    location.path = mkdtempSync(join(tmpdir(), 'anvil-preview-bridge-'));
    for (const name of ['normal', 'legacy']) {
      mkdirSync(join(location.path, name));
      writeFileSync(join(location.path, name, 'browser-bridge.json'), `existing-${name}`);
    }
    service = await import('../browser.service.js');
    const port = await service.startBridge();
    const previewPath = join(
      location.path,
      'normal',
      'previews',
      'candidate-build',
      'browser-bridge.json',
    );
    expect(JSON.parse(readFileSync(previewPath, 'utf8')).port).toBe(port);
    service.setBrowserScope({ workspaceId: 'preview', repoPaths: [] });
    for (const name of ['normal', 'legacy']) {
      expect(readFileSync(join(location.path, name, 'browser-bridge.json'), 'utf8')).toBe(
        `existing-${name}`,
      );
    }
    service.stopBridge();
    expect(existsSync(previewPath)).toBe(false);
    for (const name of ['normal', 'legacy']) {
      expect(readFileSync(join(location.path, name, 'browser-bridge.json'), 'utf8')).toBe(
        `existing-${name}`,
      );
    }
  });
});
