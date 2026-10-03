import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatVerificationCode,
  parseSecurityCommand,
  readRecoveryCodeFromProtectedFile,
} from '../security-cli.js';

const RECOVERY_CODE = 'anvil-recovery-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

describe('headless security command parsing', () => {
  it('defaults setup to manual approval', () => {
    expect(parseSecurityCommand(['setup'])).toEqual({
      kind: 'setup',
      policy: 'require-approval',
    });
  });

  it('parses bounded security commands without carrying secret material', () => {
    expect(parseSecurityCommand(['status'])).toEqual({ kind: 'status' });
    expect(parseSecurityCommand(['devices'])).toEqual({ kind: 'devices' });
    expect(parseSecurityCommand(['verify', 'device-2'])).toEqual({
      kind: 'verify',
      enrollmentId: 'device-2',
    });
    expect(
      parseSecurityCommand(['approve', 'device-2', '--verification-code', '123-456-789']),
    ).toEqual({
      kind: 'approve',
      enrollmentId: 'device-2',
      verificationCode: '123456789',
    });
    expect(parseSecurityCommand(['policy', 'auto-trust-authenticated'])).toEqual({
      kind: 'policy',
      policy: 'auto-trust-authenticated',
    });
    expect(parseSecurityCommand(['unlock', '--stdin'])).toEqual({
      kind: 'unlock',
      source: { kind: 'stdin' },
    });
    expect(parseSecurityCommand(['recovery-replace'])).toEqual({
      kind: 'recovery-replace',
    });
  });

  it('rejects recovery codes in argv and requires one input source', () => {
    expect(() => parseSecurityCommand(['unlock', '--code', RECOVERY_CODE])).toThrow(
      'through --stdin or a protected --file',
    );
    expect(() => parseSecurityCommand(['unlock'])).toThrow('exactly one');
    expect(() => parseSecurityCommand(['unlock', '--stdin', '--file', 'code.txt'])).toThrow(
      'exactly one',
    );
    expect(() => parseSecurityCommand([RECOVERY_CODE])).toThrowError(
      expect.not.stringContaining(RECOVERY_CODE),
    );
  });

  it('does not turn trust policy into worker or companion permission', () => {
    expect(() => parseSecurityCommand(['setup', '--worker'])).toThrow();
    expect(() => parseSecurityCommand(['policy', 'steer'])).toThrow();
  });

  it('requires the public SAS in its exact 9-digit or grouped form without echoing it', () => {
    expect(formatVerificationCode('123456789')).toBe('123-456-789');
    expect(() =>
      parseSecurityCommand(['approve', 'device-2', '--verification-code', '123--456789']),
    ).toThrow('exactly nine digits');
    expect(() =>
      parseSecurityCommand(['approve', 'device-2', '--verification-code', '1234567890']),
    ).toThrowError(expect.not.stringContaining('1234567890'));
  });
});

describe('protected recovery-code files', () => {
  it('reads an owner-only regular file and trims the saved newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-security-cli-'));
    const path = join(dir, 'recovery-code');
    writeFileSync(path, `${RECOVERY_CODE}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(readRecoveryCodeFromProtectedFile(path)).toBe(RECOVERY_CODE);
  });

  it('rejects group-readable recovery-code files without exposing their contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anvil-security-cli-'));
    const path = join(dir, 'recovery-code');
    writeFileSync(path, RECOVERY_CODE, { mode: 0o640 });
    chmodSync(path, 0o640);
    expect(() => readRecoveryCodeFromProtectedFile(path)).toThrow('owner-only');
    expect(() => readRecoveryCodeFromProtectedFile(path)).not.toThrow(RECOVERY_CODE);
  });
});
