import { describe, expect, it } from 'vitest';
import {
  parseSignInCommand,
  runSignIn,
  type SignInCliIo,
  type SignInDeviceFlow,
  type SignInSignalSource,
} from '../signin-cli.js';

function fakeSignals(): SignInSignalSource & { trigger: () => void } {
  let listener: (() => void) | null = null;
  return {
    on: (_signal, next) => {
      listener = next;
    },
    removeListener: (_signal, next) => {
      if (listener === next) listener = null;
    },
    trigger: () => listener?.(),
  };
}

function output(): SignInCliIo & { stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  return {
    stdoutLines,
    stderrLines,
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
  };
}

function flow(overrides: Partial<SignInDeviceFlow> = {}): SignInDeviceFlow {
  return {
    verificationUri: 'https://example.authkit.app/device',
    userCode: 'RRGQ-BJVS',
    expiresIn: 300,
    waitForCompletion: async () => undefined,
    ...overrides,
  };
}

describe('daemon sign-in command parsing', () => {
  it('requires an API URL and accepts an explicit worker opt-in', () => {
    expect(parseSignInCommand(['--api-url', 'https://sync.example', '--worker'])).toEqual({
      apiUrl: 'https://sync.example',
      worker: true,
    });
    expect(parseSignInCommand(['--worker', '--api-url', 'https://sync.example'])).toEqual({
      apiUrl: 'https://sync.example',
      worker: true,
    });
  });

  it('rejects missing values, duplicate flags, positional values, and secret-like options', () => {
    expect(() => parseSignInCommand([])).toThrow('requires --api-url <url>');
    expect(() => parseSignInCommand(['--api-url'])).toThrow('requires --api-url <url>');
    expect(() =>
      parseSignInCommand(['--api-url', 'https://sync.example', '--api-url', 'x']),
    ).toThrow('one --api-url');
    expect(() => parseSignInCommand(['--api-url', 'https://sync.example', 'DEVICE-CODE'])).toThrow(
      'unknown sign-in option',
    );
    expect(() =>
      parseSignInCommand(['--api-url', 'https://sync.example', '--device-code', 'secret']),
    ).toThrow('unknown sign-in option');
    expect(() => parseSignInCommand(['--api-url', 'https://sync.example/?token=private'])).toThrow(
      'must not embed credentials, a query, or a fragment',
    );
    expect(() =>
      parseSignInCommand(['--api-url', 'https://sync.example/?token=private']),
    ).not.toThrowError(expect.stringContaining('private'));
  });
});

describe('daemon sign-in orchestration', () => {
  it('prints only the public verification details and runs post-login work', async () => {
    const io = output();
    let completed = false;
    const result = await runSignIn({
      io,
      signals: fakeSignals(),
      start: async () =>
        flow({
          // This private value must never be owned or printed by the CLI.
          waitForCompletion: async () => {
            completed = true;
          },
        }),
      onSuccess: () => {
        completed = true;
      },
    });

    expect(result).toEqual({ exitCode: 0, cancelled: false });
    expect(completed).toBe(true);
    expect(io.stdoutLines.join('\n')).toContain('https://example.authkit.app/device');
    expect(io.stdoutLines.join('\n')).toContain('RRGQ-BJVS');
    expect(io.stdoutLines.join('\n')).toContain('anvil-daemon security verify <enrollmentId>');
    expect(io.stdoutLines.join('\n')).toContain('anvil-daemon security unlock --stdin');
    expect(io.stdoutLines.join('\n')).not.toContain('device_code');
    expect(io.stdoutLines.join('\n')).not.toContain('private');
  });

  it('cancels polling on SIGINT, leaves the session untouched, and returns 130', async () => {
    const io = output();
    const signals = fakeSignals();
    let resolveWait: (() => void) | undefined;
    let cancelled = false;
    let completed = false;
    const resultPromise = runSignIn({
      io,
      signals,
      start: async () =>
        flow({
          cancel: () => {
            cancelled = true;
          },
          waitForCompletion: () =>
            new Promise<void>((resolve) => {
              resolveWait = resolve;
            }),
        }),
      onSuccess: () => {
        completed = true;
      },
    });

    // Let start() resolve and the CLI enter the injected wait.
    await Promise.resolve();
    await Promise.resolve();
    signals.trigger();
    resolveWait?.();

    const result = await resultPromise;
    expect(result).toEqual({ exitCode: 130, cancelled: true });
    expect(cancelled).toBe(true);
    expect(completed).toBe(false);
    expect(io.stderrLines.join('\n')).toContain('cancelled');
    expect(io.stderrLines.join('\n')).not.toContain('RRGQ-BJVS');
  });

  it('does not report cancellation after the runtime has committed a session', async () => {
    const io = output();
    const signals = fakeSignals();
    const result = await runSignIn({
      io,
      signals,
      start: async () =>
        flow({
          isSessionPersisted: () => true,
          waitForCompletion: async () => signals.trigger(),
        }),
    });

    expect(result).toEqual({ exitCode: 0, cancelled: false });
    expect(io.stderrLines).toHaveLength(0);
  });

  it('does not echo malformed public values or runtime error text', async () => {
    const io = output();
    const result = await runSignIn({
      io,
      signals: fakeSignals(),
      start: async () =>
        flow({
          waitForCompletion: async () => {
            throw new Error('device_code=private-token');
          },
        }),
    });

    expect(result.exitCode).toBe(1);
    const text = [...io.stdoutLines, ...io.stderrLines].join('\n');
    expect(text).not.toContain('private-token');
  });

  it('maps stable denial and expiry outcomes without exposing runtime details', async () => {
    for (const [code, expected] of [
      ['access_denied', 'sign-in denied'],
      ['expired_token', 'sign-in expired'],
    ] as const) {
      const io = output();
      const result = await runSignIn({
        io,
        signals: fakeSignals(),
        start: async () =>
          flow({
            waitForCompletion: async () => {
              throw Object.assign(new Error('private runtime detail'), { code });
            },
          }),
      });

      expect(result).toEqual({ exitCode: 1, cancelled: false });
      expect(io.stderrLines.join('\n')).toContain(expected);
      expect(io.stderrLines.join('\n')).not.toContain('private runtime detail');
    }
  });
});
