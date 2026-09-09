import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {} }));
vi.mock('../../../shared/preview-build.js', () => ({ previewBuild: { buildId: 'preview' } }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({
  default: { existsSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  getAutomationDaemonStatus,
  installAutomationDaemon,
  uninstallAutomationDaemon,
  isAutomationDaemonMode,
} from '../automation-daemon.service.js';

describe('candidate preview daemon isolation', () => {
  it.each([getAutomationDaemonStatus, installAutomationDaemon, uninstallAutomationDaemon])(
    '%s never inspects or changes the normal app service',
    (operation) => {
      expect(operation()).toMatchObject({
        supported: false,
        installed: false,
        loaded: false,
        mode: 'app',
      });
      expect(execFileSync).not.toHaveBeenCalled();
      expect(fs.existsSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.rmSync).not.toHaveBeenCalled();
    },
  );

  it('does not enter daemon mode even when explicitly launched with the flag', () => {
    const original = process.argv;
    process.argv = [...original, '--automation-daemon'];
    try {
      expect(isAutomationDaemonMode()).toBe(false);
    } finally {
      process.argv = original;
    }
  });
});
