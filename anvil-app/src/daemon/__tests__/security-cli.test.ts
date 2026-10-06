import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceSummary } from '../../../cloud/contract/auth.js';
import type { SyncDeviceSecurityStatus } from '../../shared/sync-device-security.js';
import {
  formatDeviceList,
  formatDeviceSecurityStatus,
  formatSignInNextSteps,
  formatVerificationInstructions,
  formatVerificationCode,
  parseSecurityCommand,
  readRecoveryCodeFromProtectedFile,
  selectDevice,
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
    expect(parseSecurityCommand(['status'])).toEqual({ kind: 'status', json: false });
    expect(parseSecurityCommand(['status', '--json'])).toEqual({ kind: 'status', json: true });
    expect(parseSecurityCommand(['devices'])).toEqual({ kind: 'devices', json: false });
    expect(parseSecurityCommand(['devices', '--json'])).toEqual({ kind: 'devices', json: true });
    expect(parseSecurityCommand(['verify', 'device-2'])).toEqual({
      kind: 'verify',
      target: 'device-2',
    });
    expect(
      parseSecurityCommand(['approve', 'device-2', '--verification-code', '123-456-789']),
    ).toEqual({
      kind: 'approve',
      target: 'device-2',
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

  it('resolves numbered device targets and rejects self or revoked devices', () => {
    const devices: DeviceSummary[] = [
      {
        enrollmentId: 'enr_this',
        displayName: 'Desktop',
        installationId: 'install-1',
        credentialGeneration: 1,
        revoked: false,
        createdAt: '2026-10-06T10:00:00.000Z',
        self: true,
        trustState: 'trusted',
      },
      {
        enrollmentId: 'enr_daemon',
        displayName: 'Build\n\u001b[31mhost',
        installationId: 'install-2',
        credentialGeneration: 1,
        revoked: false,
        createdAt: '2026-10-06T10:01:00.000Z',
        self: false,
        trustState: 'pending',
      },
      {
        enrollmentId: 'enr_revoked',
        displayName: 'Old host',
        installationId: 'install-3',
        credentialGeneration: 1,
        revoked: true,
        createdAt: '2026-10-06T10:02:00.000Z',
        self: false,
        trustState: 'revoked',
      },
    ];

    expect(selectDevice('2', devices)).toEqual({
      enrollmentId: 'enr_daemon',
      number: 2,
      name: 'Build  [31mhost',
    });
    expect(selectDevice('enr_daemon', devices)).toEqual({
      enrollmentId: 'enr_daemon',
      number: 2,
      name: 'Build  [31mhost',
    });
    expect(() => selectDevice('1', devices)).toThrow('current device');
    expect(() => selectDevice('3', devices)).toThrow('revoked');
    expect(() =>
      selectDevice('4', [
        ...devices,
        {
          ...devices[1]!,
          enrollmentId: 'enr_environment',
          displayName: 'Temporary environment',
          enrollmentClass: 'ephemeral',
        },
      ]),
    ).toThrow('Temporary environments');

    const roster = formatDeviceList(devices);
    expect(roster).toContain('2. Build  [31mhost');
    expect(roster).toContain('Use a number with');
    expect(roster).not.toContain('enr_daemon');
    expect(roster).not.toContain('\u001b');
  });

  it('labels verification SAS instructions and reports the key readiness separately', () => {
    const instruction = formatVerificationInstructions(
      { enrollmentId: 'enr_daemon', number: 2, name: 'Build host' },
      '123456789',
    );
    expect(instruction).toContain('Device verification code');
    expect(instruction).toContain('123-456-789');
    expect(instruction).toContain('different from the WorkOS sign-in code');
    expect(instruction).toContain('approve the selected device');
    expect(instruction).not.toContain('enr_daemon');

    const status = formatDeviceSecurityStatus({
      accountId: 'account-secret-ish',
      configured: true,
      policy: 'auto-trust-authenticated',
      revision: 1,
      trustState: 'trusted',
      trustSource: 'automatic-auth',
      hasAccountKey: false,
      hasRecoverySecret: false,
      canConfigure: false,
      requiresRecovery: true,
      recentEvents: [],
    });
    expect(status).toContain('automatic connection for authenticated devices');
    expect(status).toContain('Encrypted account key: not available yet');
    expect(status).toContain('security unlock --stdin');
    expect(status).not.toContain('account-secret-ish');
  });

  it('gives first-device, automatic-wait, and worker guidance without merging consent', () => {
    const firstDevice: SyncDeviceSecurityStatus = {
      accountId: null,
      configured: false,
      policy: 'require-approval',
      revision: 1,
      trustState: 'trusted',
      trustSource: 'first-device',
      hasAccountKey: false,
      hasRecoverySecret: false,
      canConfigure: true,
      requiresRecovery: false,
      recentEvents: [],
    };
    const firstSteps = formatSignInNextSteps(firstDevice, false).join('\n');
    expect(firstSteps).toContain('security setup --policy auto-trust-authenticated');
    expect(firstSteps.indexOf('Automatic connection (recommended)')).toBeLessThan(
      firstSteps.indexOf('Manual device verification'),
    );
    expect(firstSteps).toContain('Mesh worker: off');

    const firstStatus = formatDeviceSecurityStatus(firstDevice);
    expect(firstStatus.indexOf('Automatic connection (recommended)')).toBeLessThan(
      firstStatus.indexOf('Manual approval'),
    );

    const automaticSteps = formatSignInNextSteps(
      {
        ...firstDevice,
        configured: true,
        policy: 'auto-trust-authenticated',
        trustSource: 'automatic-auth',
        hasAccountKey: false,
        canConfigure: false,
        requiresRecovery: true,
      },
      false,
    ).join('\n');
    expect(automaticSteps).toContain('trusted device comes online');
    expect(automaticSteps).toContain('security unlock --stdin');
    expect(automaticSteps).toContain('Mesh worker: off');
    expect(automaticSteps).not.toContain('worker enabled');

    const optedInSteps = formatSignInNextSteps(firstDevice, true).join('\n');
    expect(optedInSteps).toContain('Mesh worker: enabled for this host by explicit opt-in');
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
