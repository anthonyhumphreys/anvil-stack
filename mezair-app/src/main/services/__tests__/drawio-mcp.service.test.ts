import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
}));

import { checkDrawioAvailability, resetAvailabilityCache } from '../drawio-mcp.service.js';
import { execFile } from 'node:child_process';

beforeEach(() => {
  resetAvailabilityCache();
  vi.clearAllMocks();
});

describe('checkDrawioAvailability', () => {
  it('should return true when npx succeeds', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });
    expect(await checkDrawioAvailability()).toBe(true);
  });

  it('should return false when npx fails', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('not found'), '', '');
      return {} as any;
    });
    expect(await checkDrawioAvailability()).toBe(false);
  });

  it('should cache the result', async () => {
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });
    await checkDrawioAvailability();
    await checkDrawioAvailability();
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
