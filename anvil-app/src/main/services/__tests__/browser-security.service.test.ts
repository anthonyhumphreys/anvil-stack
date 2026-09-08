import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import type { WebContents } from 'electron';
const location = vi.hoisted(() => ({ path: '' }));
vi.mock('../../utils/app-paths.js', () => ({
  getPrimaryHiddenDirPath: () => location.path,
  getLegacyHiddenDirPath: () => location.path,
}));
let service: typeof import('../browser.service.js');
function target() {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => 'http://localhost:3000',
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({ value: 'ok' })),
    },
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('png') })),
  });
}
function discovery(): { port: number; token: string; target: string } {
  return JSON.parse(readFileSync(join(location.path, 'browser-bridge.json'), 'utf8'));
}
function headers() {
  const info = discovery();
  return {
    Authorization: `Bearer ${info.token}`,
    'X-Anvil-Target': info.target,
    'Content-Type': 'application/json',
  };
}
beforeEach(async () => {
  vi.resetModules();
  location.path = mkdtempSync(join(tmpdir(), 'anvil-browser-test-'));
  service = await import('../browser.service.js');
  await service.startBridge();
});
afterEach(() => {
  service.stopBridge();
  rmSync(location.path, { recursive: true, force: true });
});
describe('browser session authentication and target binding', () => {
  it('shares one listener across concurrent startup requests', async () => {
    service.stopBridge();
    const first = service.startBridge();
    const second = service.startBridge();
    expect(second).toBe(first);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(discovery().port).toBe(a);
  });
  it('rejects absent credentials, wrong credentials and browser origins before executing', async () => {
    const guest = target();
    service.attachDebugger(guest as unknown as WebContents);
    guest.debugger.sendCommand.mockClear();
    const url = `http://127.0.0.1:${discovery().port}/evaluate`;
    expect(
      (await fetch(url, { method: 'POST', body: '{"expression":"document.cookie"}' })).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers(), Authorization: 'Bearer wrong' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers(), Origin: 'https://attacker.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(guest.debugger.sendCommand).not.toHaveBeenCalled();
  });
  it('allows authenticated evaluation and screenshots, writes private credentials, and rotates on restart', async () => {
    const guest = target();
    service.attachDebugger(guest as unknown as WebContents);
    const info = discovery();
    const url = `http://127.0.0.1:${info.port}`;
    expect(statSync(join(location.path, 'browser-bridge.json')).mode & 0o777).toBe(0o600);
    expect(
      (
        await fetch(`${url}/evaluate`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ expression: 'document.title' }),
        })
      ).status,
    ).toBe(200);
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    expect(
      await (
        await fetch(`${url}/screenshot`, { method: 'POST', headers: headers(), body: '{}' })
      ).json(),
    ).toMatchObject({ mimeType: 'image/png' });
    service.stopBridge();
    await service.startBridge();
    expect(discovery().token).not.toBe(info.token);
  });
  it('does not redirect an in-flight command to a newly selected page', async () => {
    const first = target();
    const second = target();
    service.attachDebugger(first as unknown as WebContents);
    first.debugger.sendCommand.mockClear();
    const info = discovery();
    const response = new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: info.port,
          path: '/evaluate',
          method: 'POST',
          headers: headers(),
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.write('{"expression":');
      setTimeout(() => {
        service.attachDebugger(second as unknown as WebContents);
        second.debugger.sendCommand.mockClear();
        req.end('"document.cookie"}');
      }, 30);
    });
    expect(await response).toBe(409);
    expect(first.debugger.sendCommand).not.toHaveBeenCalled();
    expect(second.debugger.sendCommand).not.toHaveBeenCalled();
  });
  it('rejects stale target handles and results after selection changes', async () => {
    const first = target();
    const second = target();
    service.attachDebugger(first as unknown as WebContents);
    const oldHeaders = headers();
    let release: (value: { value: string }) => void = () => {};
    first.debugger.sendCommand.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = fetch(`http://127.0.0.1:${discovery().port}/evaluate`, {
      method: 'POST',
      headers: oldHeaders,
      body: '{"expression":"document.title"}',
    });
    await vi.waitFor(() =>
      expect(first.debugger.sendCommand).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.anything(),
      ),
    );
    service.attachDebugger(second as unknown as WebContents);
    release({ value: 'private' });
    expect((await pending).status).toBe(409);
    expect(
      (await fetch(`http://127.0.0.1:${discovery().port}/status`, { headers: oldHeaders })).status,
    ).toBe(409);
  });
});
