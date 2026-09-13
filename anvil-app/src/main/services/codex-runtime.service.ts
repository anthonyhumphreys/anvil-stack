import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { app } from 'electron';
import type { CodexRuntimeStatus } from '../../shared/codex-runtime.js';

async function execFileAsync(
  file: string,
  args: string[],
  options?: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  if (typeof execFile !== 'function') {
    throw new Error('Codex runtime inspection is unavailable in this environment.');
  }
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Keep the system fallback on the same tested protocol and model-catalog contract. */
export const MINIMUM_CODEX_VERSION = '0.154.0';
export const MANAGED_CODEX_VERSION = '0.154.0';
export const MAXIMUM_SUPPORTED_CODEX_VERSION = MANAGED_CODEX_VERSION;
const RELEASE_TAG = `rust-v${MANAGED_CODEX_VERSION}`;
const RELEASE_BASE = `https://github.com/openai/codex/releases/download/${RELEASE_TAG}`;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

type PlatformTarget = {
  target: string;
  executable: string;
  archive: string;
  sha256: string;
};

const TARGETS: Record<string, PlatformTarget> = {
  'darwin-arm64': {
    target: 'aarch64-apple-darwin',
    executable: 'codex',
    archive: 'codex-package-aarch64-apple-darwin.tar.gz',
    sha256: '427ca74c027049e0cd1a330d611e7f8d1fe0f1eb6a6d85ac16f61bcf2cb4a485',
  },
  'darwin-x64': {
    target: 'x86_64-apple-darwin',
    executable: 'codex',
    archive: 'codex-package-x86_64-apple-darwin.tar.gz',
    sha256: '8052c6accbe0361bfbd424a10aa5f2226636ed8afb6dcbd5e6437993e57b16d8',
  },
  'linux-arm64': {
    target: 'aarch64-unknown-linux-musl',
    executable: 'codex',
    archive: 'codex-package-aarch64-unknown-linux-musl.tar.gz',
    sha256: '97d93e11df72d3c26772db019e6ea8bb72c246500d46b98c760839f3240355e6',
  },
  'linux-x64': {
    target: 'x86_64-unknown-linux-musl',
    executable: 'codex',
    archive: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
    sha256: 'fc6e3e3b85f2cf7d664520ee5c66a7fe4aa12bae7d46834f47e2f165fd0d6f78',
  },
  'win32-arm64': {
    target: 'aarch64-pc-windows-msvc',
    executable: 'codex.exe',
    archive: 'codex-package-aarch64-pc-windows-msvc.tar.gz',
    sha256: 'fcd888733e50e40acaf4278bedfbf4245cb2b934c99c6e5b263da850fd9f90c2',
  },
  'win32-x64': {
    target: 'x86_64-pc-windows-msvc',
    executable: 'codex.exe',
    archive: 'codex-package-x86_64-pc-windows-msvc.tar.gz',
    sha256: '94cc5b3632769504c809f6c0364b693c0dfddc5c30c8361095d2263a07ac45a4',
  },
};

let installPromise: Promise<CodexRuntimeStatus> | undefined;

function platformTarget(): PlatformTarget | undefined {
  return TARGETS[`${process.platform}-${process.arch}`];
}

function runtimeRoot(): string {
  const override = process.env.ANVIL_CODEX_RUNTIME_DIR;
  if (override) return override;
  return join(app.getPath('userData'), 'codex-runtime');
}

function managedExecutable(): string {
  const target = platformTarget();
  if (!target) throw new Error(`Codex is not available for ${process.platform}/${process.arch}.`);
  return getManagedCodexExecutablePath(runtimeRoot(), MANAGED_CODEX_VERSION, target.executable);
}

export function getManagedCodexExecutablePath(
  root: string,
  version: string = MANAGED_CODEX_VERSION,
  executable: string = platformTarget()?.executable ?? 'codex',
): string {
  return join(root, version, 'bin', executable);
}

function parseVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function isSupportedCodexVersion(version: string): boolean {
  return (
    compareVersions(version, MINIMUM_CODEX_VERSION) >= 0 &&
    compareVersions(version, MAXIMUM_SUPPORTED_CODEX_VERSION) <= 0
  );
}

async function inspectExecutable(
  executable: string,
): Promise<{ version?: string; ready: boolean }> {
  try {
    const result = await execFileAsync(executable, ['--version'], { timeout: 10_000 });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    return {
      version,
      ready: Boolean(version && isSupportedCodexVersion(version)),
    };
  } catch {
    return { ready: false };
  }
}

async function findSystemExecutable(): Promise<string | undefined> {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(command, ['codex'], { timeout: 5_000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

async function inspectManaged(): Promise<CodexRuntimeStatus> {
  const target = platformTarget();
  if (!target) return { installed: false, ready: false, source: 'managed' };
  const executable = managedExecutable();
  try {
    await stat(executable);
  } catch {
    return { installed: false, ready: false, source: 'managed', path: executable };
  }
  const inspected = await inspectExecutable(executable);
  const ready = inspected.ready && inspected.version === MANAGED_CODEX_VERSION;
  return {
    installed: true,
    ready,
    version: inspected.version,
    path: executable,
    source: 'managed',
    ...(ready
      ? {}
      : {
          error:
            inspected.version === undefined
              ? 'The managed Codex executable failed its version check.'
              : `Managed Codex must be exactly version ${MANAGED_CODEX_VERSION}.`,
        }),
  };
}

async function inspectSystem(): Promise<CodexRuntimeStatus> {
  const executable = await findSystemExecutable();
  if (!executable) return { installed: false, ready: false, source: 'system' };
  const inspected = await inspectExecutable(executable);
  return {
    installed: true,
    ready: inspected.ready,
    version: inspected.version,
    path: executable,
    source: 'system',
    ...(inspected.ready
      ? {}
      : {
          error: `LLMGateway needs Codex ${MANAGED_CODEX_VERSION}. Install the Anvil-managed coding engine to continue.`,
        }),
  };
}

export async function getCodexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  try {
    const managed = await inspectManaged();
    if (managed.ready) return managed;
    const system = await inspectSystem();
    if (system.ready) return system;
    return managed.installed
      ? managed
      : system.installed
        ? system
        : { installed: false, ready: false };
  } catch (error) {
    return {
      installed: false,
      ready: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function downloadArchive(destination: string, target: PlatformTarget): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${RELEASE_BASE}/${target.archive}`, {
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_ARCHIVE_BYTES)
      throw new Error('Codex download is larger than the allowed archive size.');
    if (!response.ok || !response.body)
      throw new Error(`Codex download failed (${response.status}).`);
    let total = 0;
    const digest = createHash('sha256');
    const boundedHash = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        if (total > MAX_ARCHIVE_BYTES) {
          callback(new Error('Codex download is larger than the allowed archive size.'));
          return;
        }
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      boundedHash,
      createWriteStream(destination, { mode: 0o600 }),
    );
    const digestValue = digest.digest('hex');
    if (digestValue !== target.sha256)
      throw new Error('Codex download failed checksum verification.');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('Codex download timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function extractArchive(archive: string, destination: string): Promise<string> {
  await execFileAsync('tar', ['-xzf', archive, '-C', destination], { timeout: 60_000 });
  const target = platformTarget();
  if (!target) throw new Error(`Codex is not available for ${process.platform}/${process.arch}.`);
  const found = await locateFile(destination, target.executable);
  if (!found) throw new Error('The verified Codex archive did not contain its executable.');
  return found;
}

async function locateFile(directory: string, filename: string): Promise<string | undefined> {
  const entries = await (
    await import('node:fs/promises')
  ).readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const found = await locateFile(candidate, filename);
      if (found) return found;
    }
  }
  return undefined;
}

async function install(): Promise<CodexRuntimeStatus> {
  const target = platformTarget();
  if (!target)
    return {
      installed: false,
      ready: false,
      error: `Codex is not available for ${process.platform}/${process.arch}.`,
    };
  const root = runtimeRoot();
  const versionDir = join(root, MANAGED_CODEX_VERSION);
  const parent = dirname(versionDir);
  await mkdir(root, { recursive: true });
  const temporaryRoot = await mkdtemp(join(root, '.staging-'));
  const archive = join(temporaryRoot, target.archive);
  const extracted = join(temporaryRoot, 'extracted');
  const backup = join(root, `${MANAGED_CODEX_VERSION}.previous-${Date.now()}`);
  let movedExisting = false;
  try {
    await mkdir(extracted, { recursive: true });
    await downloadArchive(archive, target);
    const executable = await extractArchive(archive, extracted);
    await chmod(executable, 0o755);
    await mkdir(parent, { recursive: true });
    try {
      await rename(versionDir, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(extracted, versionDir);
    const status = await inspectManaged();
    if (!status.ready) {
      await rm(versionDir, { recursive: true, force: true });
      throw new Error(status.error ?? 'Installed Codex did not pass its version check.');
    }
    await rm(backup, { recursive: true, force: true });
    return status;
  } catch (error) {
    if (movedExisting) {
      try {
        await rm(versionDir, { recursive: true, force: true });
        await rename(backup, versionDir);
      } catch (restoreError) {
        throw new Error(
          `Codex installation failed and its previous version could not be restored from ${backup}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function installCodexRuntime(): Promise<CodexRuntimeStatus> {
  if (!installPromise) {
    installPromise = install()
      .catch(async (error) => {
        const current = await getCodexRuntimeStatus();
        const message = error instanceof Error ? error.message : String(error);
        return { ...current, error: `${message}${current.error ? ` (${current.error})` : ''}` };
      })
      .finally(() => {
        installPromise = undefined;
      });
  }
  return installPromise;
}

export async function resolveCodexRuntime(): Promise<string> {
  const status = await getCodexRuntimeStatus();
  if (status.ready && status.path) return status.path;
  throw new Error(
    status.error ??
      'Codex is not ready. Install the managed coding engine from Anvil Settings, then try again.',
  );
}

export function getCodexRuntimeTarget(): PlatformTarget | undefined {
  return platformTarget();
}
