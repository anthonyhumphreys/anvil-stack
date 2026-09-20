/**
 * Command-line orchestration for WorkOS Device Authorization.
 *
 * The runtime owns the device code, polling and session persistence. This
 * module only parses the public command arguments, prints the public
 * verification details, and owns cancellation/exit semantics.
 */

export interface SignInCommand {
  apiUrl: string;
  worker: boolean;
}

export interface SignInDeviceFlow {
  /** Public URL the operator opens on a browser-capable device. */
  verificationUri: string;
  /** Public WorkOS user code; the device code must never reach this layer. */
  userCode: string;
  /** Authorization lifetime in seconds, used for operator feedback only. */
  expiresIn: number;
  /** Resolves after the runtime has persisted a signed-in device session. */
  waitForCompletion: (signal: AbortSignal) => Promise<void>;
  /** Cancels in-memory polling/listeners without touching a saved session. */
  cancel?: () => void;
  /** Releases one-shot flow resources after success or failure. */
  dispose?: () => void;
  /** True once the provider exchange has committed a local Anvil session. */
  isSessionPersisted?: () => boolean;
}

export interface SignInCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface SignInSignalSource {
  on: (signal: 'SIGINT', listener: () => void) => void;
  removeListener: (signal: 'SIGINT', listener: () => void) => void;
}

export interface RunSignInOptions {
  start: (signal: AbortSignal) => Promise<SignInDeviceFlow>;
  onSuccess?: () => Promise<void> | void;
  io?: SignInCliIo;
  signals?: SignInSignalSource;
}

export interface RunSignInResult {
  exitCode: 0 | 1 | 130;
  cancelled: boolean;
}

const DEFAULT_IO: SignInCliIo = {
  stdout: (text) => console.log(text),
  stderr: (text) => console.error(text),
};

const DEFAULT_SIGNALS: SignInSignalSource = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
};

function usageError(message: string): Error {
  return new Error(`${message}\nUsage: anvil-daemon sign-in --api-url <url> [--worker]`);
}

function validateApiUrl(value: string): void {
  if (value.includes('\r') || value.includes('\n')) {
    throw usageError('sign-in --api-url must be a single URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw usageError('sign-in --api-url must be an absolute URL');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw usageError('sign-in --api-url must not embed credentials, a query, or a fragment');
  }
}

/**
 * Strictly parse sign-in arguments. Values are kept local to the command and
 * are never included in errors, so accidental token-like arguments cannot be
 * reflected back into logs.
 */
export function parseSignInCommand(args: readonly string[]): SignInCommand {
  let apiUrl: string | undefined;
  let worker = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--api-url') {
      if (apiUrl !== undefined) throw usageError('sign-in accepts one --api-url <url>');
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--') || value.length === 0) {
        throw usageError('sign-in requires --api-url <url>');
      }
      apiUrl = value;
      index += 1;
      continue;
    }
    if (token === '--worker') {
      if (worker) throw usageError('sign-in accepts --worker at most once');
      worker = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      throw usageError('sign-in requires --api-url <url>');
    }
    throw usageError('unknown sign-in option');
  }

  if (apiUrl === undefined) throw usageError('sign-in requires --api-url <url>');
  validateApiUrl(apiUrl);
  return { apiUrl, worker };
}

function publicValue(label: string, value: string): string {
  if (value.length === 0 || value.includes('\r') || value.includes('\n')) {
    throw new Error(`WorkOS did not return a valid public ${label}.`);
  }
  return value;
}

function validateFlow(flow: SignInDeviceFlow): void {
  let verification: URL;
  try {
    verification = new URL(publicValue('verification URI', flow.verificationUri));
  } catch {
    throw new Error('WorkOS did not return a valid public verification URI.');
  }
  if (verification.protocol !== 'https:') {
    throw new Error('WorkOS did not return a secure verification URI.');
  }
  const code = publicValue('user code', flow.userCode);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(code)) {
    throw new Error('WorkOS did not return a valid public user code.');
  }
  if (!Number.isFinite(flow.expiresIn) || flow.expiresIn <= 0) {
    throw new Error('WorkOS did not return a valid authorization expiry.');
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function stableFlowErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function failureMessage(error: unknown): string {
  switch (stableFlowErrorCode(error)) {
    case 'access_denied':
      return '[anvil-daemon] sign-in denied; no saved session was cleared.';
    case 'expired_token':
    case 'timeout':
      return '[anvil-daemon] sign-in expired; no saved session was cleared.';
    default:
      return '[anvil-daemon] sign-in failed; no saved session was cleared.';
  }
}

/**
 * Run one device authorization attempt. Errors from the runtime are reduced
 * to stable operator text here: a future WorkOS/API error must not accidentally
 * echo the private device code, access token, or refresh token. A completed
 * provider exchange may already have persisted a new session, so failure text
 * promises only that this command will not clear saved session state.
 */
export async function runSignIn(options: RunSignInOptions): Promise<RunSignInResult> {
  const io = options.io ?? DEFAULT_IO;
  const signals = options.signals ?? DEFAULT_SIGNALS;
  const controller = new AbortController();
  let interrupted = false;
  let flow: SignInDeviceFlow | null = null;

  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
    flow?.cancel?.();
  };
  signals.on('SIGINT', onSigint);

  try {
    try {
      flow = await options.start(controller.signal);
      validateFlow(flow);
      io.stdout(
        [
          'Open this URL on a browser-capable device:',
          `  ${flow.verificationUri}`,
          `Enter this public code: ${flow.userCode}`,
          `Waiting for authorization (expires in ${Math.ceil(flow.expiresIn)} seconds)…`,
        ].join('\n'),
      );
      await flow.waitForCompletion(controller.signal);
      if (interrupted && !flow.isSessionPersisted?.()) {
        throw new Error('cancelled');
      }
      await options.onSuccess?.();
      io.stdout(
        [
          '[anvil-daemon] signed in.',
          '',
          'If the device is waiting for manual approval, compare codes on both devices:',
          '  anvil-daemon security devices',
          '  anvil-daemon security verify <enrollmentId>',
          '  anvil-daemon security approve <enrollmentId> --verification-code <NNN-NNN-NNN>',
          'If this account uses recovery, unlock the encrypted account data with:',
          '  anvil-daemon security unlock --stdin',
          'To configure recovery on this device, run:',
          '  anvil-daemon security setup',
        ].join('\n'),
      );
      return { exitCode: 0, cancelled: false };
    } catch (error) {
      const sessionPersisted = flow?.isSessionPersisted?.() === true;
      const cancelled =
        !sessionPersisted && (interrupted || controller.signal.aborted || isAbortError(error));
      if (!controller.signal.aborted) controller.abort();
      flow?.cancel?.();
      if (cancelled) {
        io.stderr('[anvil-daemon] sign-in cancelled; no saved session was cleared.');
        return { exitCode: 130, cancelled: true };
      }
      io.stderr(failureMessage(error));
      return { exitCode: 1, cancelled: false };
    }
  } finally {
    signals.removeListener('SIGINT', onSigint);
    if (flow !== null) {
      if (interrupted || controller.signal.aborted) flow.cancel?.();
      flow.dispose?.();
    }
  }
}
