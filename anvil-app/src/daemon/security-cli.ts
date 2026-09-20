import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

const MAX_RECOVERY_INPUT_BYTES = 4096;

export type DeviceTrustPolicy = 'require-approval' | 'auto-trust-authenticated';

export type RecoveryCodeSource = { kind: 'stdin' } | { kind: 'file'; path: string };

export type SecurityCommand =
  | { kind: 'status' }
  | { kind: 'devices' }
  | { kind: 'verify'; enrollmentId: string }
  | { kind: 'approve'; enrollmentId: string; verificationCode: string }
  | { kind: 'setup'; policy: DeviceTrustPolicy }
  | { kind: 'unlock'; source: RecoveryCodeSource }
  | { kind: 'policy'; policy: DeviceTrustPolicy }
  | { kind: 'recovery-replace' };

function isDeviceTrustPolicy(value: string | undefined): value is DeviceTrustPolicy {
  return value === 'require-approval' || value === 'auto-trust-authenticated';
}

function usageError(message: string): Error {
  return new Error(`${message}\nRun \`anvil-daemon security --help\` for usage.`);
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
      'usage: security status | devices | verify <enrollmentId> | approve <enrollmentId> --verification-code <NNN-NNN-NNN> | setup [--policy <policy>] | unlock (--stdin | --file <path>) | policy <policy> | recovery-replace',
    );
  }

  if (subcommand === 'status') {
    if (rest.length !== 0) throw usageError('security status takes no arguments');
    return { kind: 'status' };
  }

  if (subcommand === 'devices') {
    if (rest.length !== 0) throw usageError('security devices takes no arguments');
    return { kind: 'devices' };
  }

  if (subcommand === 'verify') {
    if (rest.length !== 1 || rest[0].length === 0 || rest[0].startsWith('-')) {
      throw usageError('usage: security verify <enrollmentId>');
    }
    return { kind: 'verify', enrollmentId: rest[0] };
  }

  if (subcommand === 'approve') {
    const enrollmentId = rest[0];
    if (enrollmentId === undefined || enrollmentId.length === 0 || enrollmentId.startsWith('-')) {
      throw usageError('usage: security approve <enrollmentId> --verification-code <NNN-NNN-NNN>');
    }
    if (rest[1] !== '--verification-code' || rest.length !== 3) {
      throw usageError('usage: security approve <enrollmentId> --verification-code <NNN-NNN-NNN>');
    }
    const provided = rest[2];
    if (provided === undefined) {
      throw usageError('usage: security approve <enrollmentId> --verification-code <NNN-NNN-NNN>');
    }
    if (!/^\d{9}$|^\d{3}-\d{3}-\d{3}$/.test(provided)) {
      throw usageError('verification code must contain exactly nine digits');
    }
    const verificationCode = provided.replaceAll('-', '');
    return { kind: 'approve', enrollmentId, verificationCode };
  }

  if (subcommand === 'setup') {
    let policy: DeviceTrustPolicy = 'require-approval';
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
    return { kind: 'setup', policy };
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
