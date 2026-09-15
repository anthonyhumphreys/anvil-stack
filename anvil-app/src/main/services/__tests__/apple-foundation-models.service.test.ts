import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn().mockReturnValue(true));
const statSyncMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ mtimeMs: 1_000, size: 4_096 }),
);

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/anvil-test' },
}));
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdirSync: vi.fn(),
  statSync: statSyncMock,
}));

import {
  callAppleFoundationModel,
  countAppleModelTokens,
  getAppleLocalModelStatus,
  invalidateAppleLocalModelStatus,
} from '../apple-foundation-models.service.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn();

  emitOut(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }

  emitErr(text: string) {
    this.stderr.emit('data', Buffer.from(text));
  }

  close(code = 0) {
    this.emit('close', code);
  }
}

const LICENSE_NOTICE =
  'YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS.';

type SpawnBehavior = (child: FakeChild, args: string[]) => void;

/**
 * Install a spawn dispatch table. Handlers run on the next tick so callers can
 * attach listeners first.
 */
function stubSpawn(behaviors: Array<{ match: RegExp; run: SpawnBehavior }>) {
  spawnMock.mockImplementation((command: string, args: string[] = []) => {
    const child = new FakeChild();
    const behavior = behaviors.find((b) => b.match.test(`${command} ${args.join(' ')}`));
    if (behavior) {
      queueMicrotask(() => behavior.run(child, args));
    } else {
      queueMicrotask(() => child.close(127));
    }
    return child;
  });
}

// The service gates everything on process.platform; stub it so the suite
// exercises the macOS paths on Linux CI as well.
const realPlatform = process.platform;
function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}
afterAll(() => setPlatform(realPlatform));

const SW_VERS_27 = {
  match: /sw_vers/,
  run: (child: FakeChild) => {
    child.emitOut('27.0\n');
    child.close(0);
  },
};

const FM_LICENSED = {
  match: /\/usr\/bin\/fm available$/,
  run: (child: FakeChild) => {
    child.emitOut('available\n');
    child.close(0);
  },
};

const FM_UNLICENSED = {
  match: /\/usr\/bin\/fm available$/,
  run: (child: FakeChild) => {
    child.emitErr(LICENSE_NOTICE);
    child.close(1);
  },
};

const SWIFTC_OK = {
  match: /xcrun swiftc/,
  run: (child: FakeChild) => child.close(0),
};

function helperCaps(id: string) {
  return {
    match: new RegExp(`${id}(-\\d+-\\d+)?( |$)`),
    run: (child: FakeChild) => {
      child.emitOut(
        JSON.stringify({
          type: 'capabilities',
          ok: true,
          available: true,
          reason: 'available',
          contextSize: 8192,
          features: {
            streaming: true,
            instructions: true,
            images: false,
            tokenCounting: true,
            contextSize: true,
            useCases: true,
            structuredOutput: false,
          },
          implementation: id,
        }) + '\n',
      );
      child.close(0);
    },
  };
}

beforeEach(() => {
  setPlatform('darwin');
  spawnMock.mockReset();
  invalidateAppleLocalModelStatus();
});

describe('apple-foundation-models.service', () => {
  it('returns requiresMacOS status off macOS', async () => {
    setPlatform('linux');
    const status = await getAppleLocalModelStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('requiresMacOS');
  });

  it('prefers fm CLI when installed and licensed', async () => {
    stubSpawn([
      SW_VERS_27,
      FM_LICENSED,
      helperCaps('swift-helper-27'),
      helperCaps('swift-helper-vision'),
      helperCaps('swift-helper'),
      SWIFTC_OK,
      {
        match: /fm respond/,
        run: (child, args) => {
          expect(args).toContain('--no-stream');
          expect(args).toContain('--instructions');
          child.emitOut('pong\n');
          child.close(0);
        },
      },
    ]);

    const result = await callAppleFoundationModel('say pong', {
      instructions: 'Be terse.',
    });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('pong');
    expect(result.backend).toBe('fm-cli');
  });

  it('streams deltas through fm CLI when streaming is requested', async () => {
    stubSpawn([
      SW_VERS_27,
      FM_LICENSED,
      {
        match: /fm respond/,
        run: (child, args) => {
          expect(args).toContain('--stream');
          expect(args).not.toContain('--no-stream');
          child.emitOut('hel');
          child.emitOut('lo\n');
          child.close(0);
        },
      },
    ]);

    const deltas: string[] = [];
    const result = await callAppleFoundationModel('hi', { onPartial: (d) => deltas.push(d) });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('fm-cli');
    expect(deltas).toEqual(['hel', 'lo\n']);
  });

  it('routes strict-output calls (small token cap) to a helper even when fm is licensed', async () => {
    const fmRespond = vi.fn();
    stubSpawn([
      SW_VERS_27,
      FM_LICENSED,
      SWIFTC_OK,
      {
        match: /fm respond/,
        run: (child) => {
          fmRespond();
          child.close(0);
        },
      },
      {
        match: /swift-helper-27/,
        run: (child) => {
          child.emitOut(
            '{"type":"final","ok":true,"content":"{\\"route\\":\\"local\\"}","unavailable":false}\n',
          );
          child.close(0);
        },
      },
    ]);

    const result = await callAppleFoundationModel('classify this', {
      instructions: 'Reply with JSON only.',
      maxTokens: 32,
    });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('swift-helper-27');
    expect(fmRespond).not.toHaveBeenCalled();
  });

  it('detects the fm license gate and falls back to the compiled helper', async () => {
    stubSpawn([
      SW_VERS_27,
      FM_UNLICENSED,
      SWIFTC_OK,
      {
        match: /swift-helper-27/,
        run: (child) => {
          child.emitOut('{"type":"delta","text":"hel"}\n');
          child.emitOut('{"type":"delta","text":"lo"}\n');
          child.emitOut(
            '{"type":"final","ok":true,"content":"hello","unavailable":false}\n',
          );
          child.close(0);
        },
      },
    ]);

    const deltas: string[] = [];
    const result = await callAppleFoundationModel('hi', { onPartial: (d) => deltas.push(d) });
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello');
    expect(result.backend).toBe('swift-helper-27');
    expect(deltas).toEqual(['hel', 'lo']);
  });

  it('reports licenseRequired in status when fm is unlicensed', async () => {
    stubSpawn([
      SW_VERS_27,
      FM_UNLICENSED,
      SWIFTC_OK,
      helperCaps('swift-helper-27'),
      {
        match: /swift-helper-vision/,
        run: (child) => {
          child.emitErr('dyld: Symbol not found');
          child.close(134);
        },
      },
      helperCaps('swift-helper'),
    ]);

    const status = await getAppleLocalModelStatus(true);
    expect(status.fmCli?.installed).toBe(true);
    expect(status.fmCli?.licenseAccepted).toBe(false);
    expect(status.backend).toBe('swift-helper-27');
    expect(status.features.tokenCounting).toBe(true);
    // Vision helper crashed at launch — images must not be advertised.
    expect(status.features.images).toBe(false);
    expect(status.contextSize).toBe(8192);
  });

  it('counts tokens via fm count-tokens when licensed', async () => {
    stubSpawn([
      SW_VERS_27,
      {
        match: /fm available/,
        run: (child) => {
          child.emitOut('available\n');
          child.close(0);
        },
      },
      {
        match: /fm count-tokens/,
        run: (child) => {
          child.emitOut('42\n');
          child.close(0);
        },
      },
    ]);

    await expect(countAppleModelTokens('some prompt')).resolves.toBe(42);
  });

  it('returns an unavailable error for images with no capable backend', async () => {
    stubSpawn([
      SW_VERS_27,
      FM_UNLICENSED,
      SWIFTC_OK,
      {
        match: /swift-helper-vision/,
        run: (child) => {
          child.emitErr('dyld: Symbol not found');
          child.close(134);
        },
      },
      helperCaps('swift-helper-27'),
      helperCaps('swift-helper'),
    ]);

    const result = await callAppleFoundationModel('describe this', {
      images: ['/tmp/pic.png'],
    });
    expect(result.ok).toBe(false);
    expect(result.unavailable).toBe(true);
    expect(result.error).toMatch(/Image prompts need macOS 27/);
  });
});
