import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/opt/Anvil App/resources/app',
    getPath: () => '/home/test/.config/Anvil App',
  },
}));

import { systemdUnit } from '../automation-daemon.service.js';

describe('systemdUnit', () => {
  it('runs the app in daemon mode and restarts it after failures', () => {
    const unit = systemdUnit();

    expect(unit).toContain('Description=Anvil automation daemon');
    expect(unit).toContain(`ExecStart="${process.execPath}" "/opt/Anvil App/resources/app" "--automation-daemon"`);
    expect(unit).toContain('WorkingDirectory="/home/test/.config/Anvil App"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});
