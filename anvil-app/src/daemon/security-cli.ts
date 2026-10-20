import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { DeviceSummary } from '../../cloud/contract/auth.js';
import type { SyncDeviceSecurityStatus } from '../shared/sync-device-security.js';

const MAX_RECOVERY_INPUT_BYTES = 4096;

export type DeviceTrustPolicy = 'require-approval' | 'auto-trust-authenticated';

export type RecoveryCodeSource = { kind: 'stdin' } | { kind: 'file'; path: string };

export type SecurityCommand =
  | { kind: 'status'; json: boolean }
  | { kind: 'devices'; json: boolean }
  | { kind: 'verify'; target: string }
  | { kind: 'approve'; target: string; verificationCode: string }
  | { kind: 'setup'; policy?: DeviceTrustPolicy }
  | { kind: 'unlock'; source: RecoveryCodeSource }
  | { kind: 'policy'; policy: DeviceTrustPolicy }
  | { kind: 'recovery-replace' };

function isDeviceTrustPolicy(value: string | undefined): value is DeviceTrustPolicy {
  return value === 'require-approval' || value === 'auto-trust-authenticated';
}

function usageError(message: string): Error {
  return new Error(`${message}\nRun \`anvil-daemon security --help\` for usage.`);
}

function parseJsonFlag(rest: readonly string[], command: string): boolean {
  if (rest.length === 0) return false;
  if (rest.length === 1 && rest[0] === '--json') return true;
  throw usageError(`usage: security ${command} [--json]`);
}

/**
 * Parse the bounded headless security surface without ever accepting a
 * recovery code as a command argument. The returned source is resolved only
 * when the command is executed, after daemon boot has succeeded.
 */
export function parseSecurityCommand(args: readonly string[]): SecurityCommand {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    throw usageError(
      'usage: security status [--json] | devices [--json] | verify <device-number|enrollmentId> | approve <device-number|enrollmentId> --verification-code <NNN-NNN-NNN> | setup [--policy <require-approval|auto-trust-authenticated>] | unlock (--stdin | --file <path>) | policy <require-approval|auto-trust-authenticated> | recovery-replace',
    );
  }

  if (subcommand === 'status') {
    return { kind: 'status', json: parseJsonFlag(rest, 'status') };
  }

  if (subcommand === 'devices') {
    return { kind: 'devices', json: parseJsonFlag(rest, 'devices') };
  }

  if (subcommand === 'verify') {
    if (rest.length !== 1 || rest[0].length === 0 || rest[0].startsWith('-')) {
      throw usageError('usage: security verify <device-number|enrollmentId>');
    }
    return { kind: 'verify', target: rest[0] };
  }

  if (subcommand === 'approve') {
    const target = rest[0];
    if (target === undefined || target.length === 0 || target.startsWith('-')) {
      throw usageError(
        'usage: security approve <device-number|enrollmentId> --verification-code <NNN-NNN-NNN>',
      );
    }
    if (rest[1] !== '--verification-code' || rest.length !== 3) {
      throw usageError(
        'usage: security approve <device-number|enrollmentId> --verification-code <NNN-NNN-NNN>',
      );
    }
    const provided = rest[2];
    if (provided === undefined) {
      throw usageError('usage: security approve <enrollmentId> --verification-code <NNN-NNN-NNN>');
    }
    if (!/^\d{9}$|^\d{3}-\d{3}-\d{3}$/.test(provided)) {
      throw usageError('verification code must contain exactly nine digits');
    }
    const verificationCode = provided.replaceAll('-', '');
    return { kind: 'approve', target, verificationCode };
  }

  if (subcommand === 'setup') {
    let policy: DeviceTrustPolicy | undefined;
    let policySeen = false;
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (policySeen || flag !== '--policy' || !isDeviceTrustPolicy(rest[index + 1])) {
        throw usageError('security setup accepts only --policy <policy>');
      }
      policy = rest[index + 1];
      policySeen = true;
      index += 1;
    }
    return policy === undefined ? { kind: 'setup' } : { kind: 'setup', policy };
  }

  if (subcommand === 'policy') {
    if (rest.length !== 1 || !isDeviceTrustPolicy(rest[0])) {
      throw usageError('usage: security policy <require-approval|auto-trust-authenticated>');
    }
    return { kind: 'policy', policy: rest[0] };
  }

  if (subcommand === 'recovery-replace') {
    if (rest.length !== 0) throw usageError('security recovery-replace takes no arguments');
    return { kind: 'recovery-replace' };
  }

  if (subcommand === 'unlock') {
    let source: RecoveryCodeSource | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (flag === '--stdin') {
        if (source !== undefined) throw usageError('security unlock accepts one secret source');
        source = { kind: 'stdin' };
        continue;
      }
      if (flag === '--file') {
        const path = rest[index + 1];
        if (source !== undefined || path === undefined || path.length === 0) {
          throw usageError('security unlock requires exactly one --stdin or --file <path>');
        }
        source = { kind: 'file', path };
        index += 1;
        continue;
      }
      if (flag === '--code' || flag.startsWith('--code=')) {
        throw usageError('recovery codes must be supplied through --stdin or a protected --file');
      }
      throw usageError('security unlock requires exactly one --stdin or --file <path>');
    }
    if (source === undefined) {
      throw usageError('security unlock requires exactly one --stdin or --file <path>');
    }
    return { kind: 'unlock', source };
  }

  throw usageError('unknown security command');
}

/** Format the 9-digit SAS for a human comparison between two devices. */
export function formatVerificationCode(code: string): string {
  if (!/^\d{9}$/.test(code)) throw new Error('runtime returned an invalid verification code');
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6)}`;
}

export interface SelectedDevice {
  enrollmentId: string;
  number: number;
  name: string;
}

function deviceName(device: DeviceSummary, number: number): string {
  const safeName =
    device.displayName === undefined
      ? ''
      : Array.from(device.displayName, (character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
        })
          .join('')
          .trim()
          .slice(0, 80);
  return safeName || (device.self ? 'This device' : `Device ${number}`);
}

/** Resolve a short number from `security devices`, or an explicit enrollment ID. */
export function selectDevice(target: string, devices: readonly DeviceSummary[]): SelectedDevice {
  const deviceNumber = /^\d+$/.test(target) ? Number(target) : null;
  const index = deviceNumber === null ? -1 : deviceNumber - 1;
  const device =
    index >= 0 && index < devices.length
      ? devices[index]
      : devices.find((candidate) => candidate.enrollmentId === target);
  if (device === undefined) {
    throw new Error(
      'No device matches that number or enrollment ID. Run `anvil-daemon security devices`.',
    );
  }
  const number = devices.indexOf(device) + 1;
  if (device.self) throw new Error('Choose another signed-in device; this is the current device.');
  if (device.enrollmentClass === 'ephemeral') {
    throw new Error(
      'Temporary environments cannot be selected for device verification or approval.',
    );
  }
  if (device.revoked || device.trustState === 'revoked') {
    throw new Error('That device enrollment is revoked and cannot be verified or approved.');
  }
  return { enrollmentId: device.enrollmentId, number, name: deviceName(device, number) };
}

/** Human-readable roster; numbered targets avoid copying opaque enrollment IDs. */
export function formatDeviceList(devices: readonly DeviceSummary[]): string {
  if (devices.length === 0) return 'No signed-in devices were found.';
  const rows = devices.map((device, index) => {
    const number = index + 1;
    const label = deviceName(device, number);
    const self = device.self ? ' (this device)' : '';
    const trust =
      device.revoked || device.trustState === 'revoked'
        ? 'revoked'
        : device.trustState === 'trusted'
          ? 'trusted on this device'
          : device.trustState === 'pending'
            ? 'waiting for device verification'
            : 'trust not yet known';
    const classLabel = device.enrollmentClass === 'ephemeral' ? ' · temporary environment' : '';
    return `  ${number}. ${label}${self} — ${trust}${classLabel}`;
  });
  return [
    'Signed-in devices:',
    ...rows,
    '',
    'Use a number with `security verify` or `security approve`.',
    'Use `security devices --json` to include enrollment IDs for scripts.',
  ].join('\n');
}

function policyLabel(value: SyncDeviceSecurityStatus['policy']): string {
  return value === 'auto-trust-authenticated'
    ? 'automatic connection for authenticated devices'
    : 'manual device verification and approval';
}

function trustSourceLabel(value: SyncDeviceSecurityStatus['trustSource']): string {
  switch (value) {
    case 'automatic-auth':
      return 'authenticated sign-in';
    case 'first-device':
      return 'first device';
    case 'manual-approval':
      return 'approved by another device';
    case 'pairing':
      return 'paired with another device';
    case 'recovery':
    case 'recovery-code':
      return 'recovery code';
    case 'local-device':
      return 'this device';
    default:
      return 'not yet known';
  }
}

function trustLabel(status: SyncDeviceSecurityStatus): string {
  if (status.trustState === 'revoked') return 'revoked';
  if (status.trustState === 'pending') return 'waiting for trust approval';
  if (status.trustState === 'trusted') return `trusted (${trustSourceLabel(status.trustSource)})`;
  return 'not yet known';
}

/** Compact status with actionable next steps and no account/device identifiers. */
export function formatDeviceSecurityStatus(
  status: SyncDeviceSecurityStatus,
  workosDeviceAuthAvailable = false,
): string {
  const recovery = status.requiresRecoveryReplacement
    ? 'needs replacement after device revocation'
    : status.configured
      ? status.hasRecoverySecret
        ? 'configured and available on this device'
        : 'configured; code is not saved on this device'
      : 'not configured';
  const lines = [
    'Device security',
    `  New-device access: ${policyLabel(
      resolveSetupPolicy(undefined, status, workosDeviceAuthAvailable ? ['workos-device'] : []),
    )}`,
    `  This device: ${trustLabel(status)}`,
    `  Encrypted account key: ${status.hasAccountKey ? 'available' : 'not available yet'}`,
    `  Recovery code: ${recovery}`,
  ];

  if (status.requiresRecoveryReplacement) {
    lines.push('', 'Next: on a trusted device, run `anvil-daemon security recovery-replace`.');
  } else if (status.canConfigure && !status.configured) {
    lines.push('', ...firstDeviceSetupGuidance(workosDeviceAuthAvailable));
  } else if (status.trustState === 'revoked') {
    lines.push('', 'Next: sign out, then enroll this host again as a new device.');
  } else if (status.trustState === 'pending') {
    lines.push(
      '',
      'On this daemon: run `anvil-daemon security devices`, then `anvil-daemon security verify <existing-device-number>` and compare the device-verification code.',
      'On the existing desktop: open Settings → Sync & Mesh → Devices, choose this daemon, enter the code shown here, and confirm the match.',
      'Then on this daemon, approve the existing device with `anvil-daemon security approve <existing-device-number> --verification-code <NNN-NNN-NNN>`.',
    );
  } else if (!status.hasAccountKey && status.policy === 'auto-trust-authenticated') {
    lines.push(
      '',
      'This device is signed in. Keep it running while a trusted device comes online to send its encrypted key.',
      'If no trusted device can come online, use the saved recovery code with `anvil-daemon security unlock --stdin`.',
    );
  } else if (!status.hasAccountKey) {
    lines.push(
      '',
      'Next: compare a device verification code with an existing trusted device, then approve both devices; or use the saved recovery code with `anvil-daemon security unlock --stdin`.',
    );
  } else {
    lines.push('', 'The encrypted account key is ready. Run `anvil-daemon run` to start syncing.');
  }
  return lines.join('\n');
}

/** Distinguish this device's public SAS from the earlier WorkOS login code. */
export function formatVerificationInstructions(selected: SelectedDevice, code: string): string {
  const formatted = formatVerificationCode(code);
  return [
    `Device verification code for ${selected.name} (#${selected.number}): ${formatted}`,
    'This is the Anvil device-verification code. It is different from the WorkOS sign-in code.',
    'Compare the same code on both signed-in devices. Approve only when the codes match.',
    '',
    'On this device, approve the selected device after comparing:',
    `  anvil-daemon security approve ${selected.number} --verification-code ${formatted}`,
    'On the other desktop, open Settings → Sync & Mesh → Devices, choose this daemon, enter the code shown above, and confirm the match.',
    'If the other device is also a daemon, run `anvil-daemon security devices`, then `anvil-daemon security verify <this-device-number>` and `anvil-daemon security approve <this-device-number> --verification-code <NNN-NNN-NNN>` there.',
  ].join('\n');
}

/** First-run sign-in guidance based on the actual policy and local key state. */
export function formatSignInNextSteps(
  status: SyncDeviceSecurityStatus,
  workerEnabled: boolean,
  workosDeviceAuthAvailable = false,
): string[] {
  const lines: string[] = [];
  if (status.canConfigure && !status.configured) {
    lines.push(...firstDeviceSetupGuidance(workosDeviceAuthAvailable));
  } else if (status.trustState === 'pending') {
    lines.push(
      'This device is waiting for approval. On this daemon, run `anvil-daemon security devices`, then `anvil-daemon security verify <existing-device-number>` and compare the device-verification code.',
      'On the existing desktop, open Settings → Sync & Mesh → Devices, choose this daemon, enter the code shown here, and confirm the match. Then approve the existing device on this daemon with `anvil-daemon security approve <existing-device-number> --verification-code <NNN-NNN-NNN>`.',
      'If the existing device is another daemon, run `anvil-daemon security devices`, `anvil-daemon security verify <new-device-number>`, and `anvil-daemon security approve <new-device-number> --verification-code <NNN-NNN-NNN>` there too.',
    );
  } else if (!status.hasAccountKey && status.policy === 'auto-trust-authenticated') {
    lines.push(
      'Automatic connection is enabled. This device is signed in and will receive its encrypted key when a trusted device comes online.',
      'If no trusted device is available, use the saved recovery code with `anvil-daemon security unlock --stdin`.',
    );
  } else if (!status.hasAccountKey) {
    lines.push(
      'Sign-in is complete, but this device does not have the encrypted account key yet.',
      'Run `anvil-daemon security devices` and compare a device-verification code with an existing trusted device, or unlock with the saved recovery code using `anvil-daemon security unlock --stdin`.',
    );
  } else {
    lines.push('The encrypted account key is ready on this device.');
  }
  lines.push(
    workerEnabled
      ? 'Mesh worker: enabled for this host by explicit opt-in; `anvil-daemon run` starts it.'
      : 'Mesh worker: off. Sign-in does not enable it; use `anvil-daemon worker on` only if this host should run jobs.',
    'Run `anvil-daemon run` to start syncing and the companion server.',
  );
  return lines;
}

function firstDeviceSetupGuidance(workosDeviceAuthAvailable: boolean): string[] {
  return workosDeviceAuthAvailable
    ? [
        'This is the first device on the account. Run `anvil-daemon security setup` to set up recovery with automatic connection for WorkOS-authenticated devices.',
        'To choose manual device verification, run `anvil-daemon security setup --policy require-approval`.',
        'Save the recovery code; it is displayed only once.',
      ]
    : [
        'This is the first device on the account. Run `anvil-daemon security setup` to set up recovery using this backend’s default policy.',
        'To choose manual device verification explicitly, run `anvil-daemon security setup --policy require-approval`.',
        'Save the recovery code; it is displayed only once.',
      ];
}

/** Resolve the initial policy without changing an account that is already configured. */
export function resolveSetupPolicy(
  requestedPolicy: DeviceTrustPolicy | undefined,
  status: SyncDeviceSecurityStatus,
  authModes: readonly string[],
): DeviceTrustPolicy {
  if (requestedPolicy !== undefined) return requestedPolicy;
  if (status.canConfigure && !status.configured && authModes.includes('workos-device')) {
    return 'auto-trust-authenticated';
  }
  return status.policy;
}

function readBoundedSecret(fd: number): string {
  const metadata = fstatSync(fd);
  if (!metadata.isFile() && fd !== 0) {
    throw new Error('Recovery code input must be a regular file.');
  }
  if (metadata.size > MAX_RECOVERY_INPUT_BYTES) {
    throw new Error('Recovery code input is too large.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(1024, MAX_RECOVERY_INPUT_BYTES - total + 1));
    const count = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_RECOVERY_INPUT_BYTES) throw new Error('Recovery code input is too large.');
    chunks.push(chunk.subarray(0, count));
  }
  const value = Buffer.concat(chunks).toString('utf8').trim();
  if (value.length === 0) throw new Error('Recovery code input is empty.');
  return value;
}

/** Read a recovery code from stdin; the code is never echoed by this helper. */
export function readRecoveryCodeFromStdin(): string {
  return readBoundedSecret(0);
}

/**
 * Read a recovery code from a file that is owner-only and opened without
 * following symlinks. The path is deliberately not included in errors so a
 * caller cannot accidentally log secret-bearing command context alongside it.
 */
export function readRecoveryCodeFromProtectedFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Recovery code file must be a regular owner-only file.');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('Recovery code file must be owned by the current user.');
    }
    return readBoundedSecret(fd);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Recovery code')) throw error;
    throw new Error('Unable to read the protected recovery code file.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readRecoveryCode(source: RecoveryCodeSource): string {
  return source.kind === 'stdin'
    ? readRecoveryCodeFromStdin()
    : readRecoveryCodeFromProtectedFile(source.path);
}
