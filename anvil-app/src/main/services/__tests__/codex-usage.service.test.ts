import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: mocks.spawn,
  };
});

import { readCodexAccountUsage } from '../codex-usage.service.js';

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('Codex usage app-server lifecycle', () => {
  it('turns a closed stdin pipe into a rejected usage request', async () => {
    const child = createChildProcess();
    mocks.spawn.mockReturnValue(child);
    const result = readCodexAccountUsage();
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(() => child.stdin.emit('error', error)).not.toThrow();
    await expect(result).rejects.toBe(error);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
