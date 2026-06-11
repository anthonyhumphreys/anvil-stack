import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Runtime detection — repobase ships with #!/usr/bin/env bun but bun may
// not be installed. In that case we fall back to running the script with node.
// ---------------------------------------------------------------------------

let _resolvedBin: string | null = null;
let _needsNode: boolean = false;
let _bunAvailable: boolean | null = null;
let _resolvedBinRealPath: string | null = null;

async function resolveRepobaseBin(): Promise<string | null> {
  if (_resolvedBin !== null) return _resolvedBin;

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(whichCmd, ['repobase']);
    _resolvedBin = stdout.trim();
  } catch {
    return null;
  }

  // Check if the shebang requires bun and whether bun is available
  try {
    const head = readFileSync(_resolvedBin, 'utf-8').slice(0, 200);
    if (head.includes('bun')) {
      try {
        await execFileAsync(whichCmd, ['bun']);
        _needsNode = false;
      } catch {
        _needsNode = true;
      }
    }
  } catch {
    /* can't read — assume it's fine as-is */
  }

  return _resolvedBin;
}

async function isBunAvailable(): Promise<boolean> {
  if (_bunAvailable !== null) return _bunAvailable;

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(whichCmd, ['bun']);
    _bunAvailable = true;
  } catch {
    _bunAvailable = false;
  }

  return _bunAvailable;
}

function resolveRealBinPath(binPath: string): string {
  if (_resolvedBinRealPath) return _resolvedBinRealPath;
  _resolvedBinRealPath = realpathSync(binPath);
  return _resolvedBinRealPath;
}

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getRepobaseMcpEntryFromBin(binPath: string): string {
  const realBinPath = resolveRealBinPath(binPath);
  const realBinDir = path.dirname(realBinPath);
  return (
    firstExistingPath([
      path.resolve(realBinDir, '../mcp-server/main.js'),
      path.resolve(realBinDir, '../dist/mcp-server/main.js'),
      path.resolve(realBinDir, 'repobase-mcp.js'),
    ]) ?? path.resolve(realBinDir, '../mcp-server/main.js')
  );
}

function getRepobaseCliEntryFromBin(binPath: string): string {
  const realBinPath = resolveRealBinPath(binPath);
  const realBinDir = path.dirname(realBinPath);
  return (
    firstExistingPath([
      path.resolve(realBinDir, 'repobase.js'),
      path.resolve(realBinDir, '../dist/bin/repobase.js'),
      realBinPath,
    ]) ?? realBinPath
  );
}

export interface RepobaseSupport {
  available: boolean;
  repoId?: string;
  warnings: string[];
  reason?: string;
  mcpEntry?: string;
}

export function deriveRepobaseRepoId(remoteUrl: string): string | null {
  const match = remoteUrl.match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

export async function getRepobaseSupport(remoteUrl: string | null): Promise<RepobaseSupport> {
  const warnings: string[] = [];

  if (!remoteUrl) {
    return {
      available: false,
      warnings: ['Deep indexing is unavailable because this repository has no remote URL.'],
      reason: 'missing-remote-url',
    };
  }

  const repoId = deriveRepobaseRepoId(remoteUrl);
  if (!repoId) {
    return {
      available: false,
      warnings: [
        'Deep indexing currently supports GitHub remotes only. This repository will use a light index.',
      ],
      reason: 'unsupported-remote',
    };
  }

  const bin = await resolveRepobaseBin();
  if (!bin) {
    return {
      available: false,
      repoId,
      warnings: [
        'Deep indexing requires Repobase to be installed. This repository will use a light index.',
      ],
      reason: 'repobase-missing',
    };
  }

  const mcpEntry = getRepobaseMcpEntryFromBin(bin);
  if (!existsSync(mcpEntry)) {
    return {
      available: false,
      repoId,
      warnings: [
        'Repobase is installed, but its MCP server entrypoint could not be found. This repository will use a light index.',
      ],
      reason: 'repobase-mcp-missing',
    };
  }

  if (!(await isBunAvailable())) {
    return {
      available: false,
      repoId,
      mcpEntry,
      warnings: [
        'Deep indexing requires Bun so Anvil can add and sync this repository in Repobase. This repository will use a light index.',
      ],
      reason: 'bun-missing',
    };
  }

  return {
    available: true,
    repoId,
    mcpEntry,
    warnings,
  };
}

/** Run repobase with the correct runtime. */
async function runRepobase(args: string[], opts?: { timeout?: number }): Promise<string> {
  const bin = await resolveRepobaseBin();
  if (!bin) throw new Error('repobase not found');

  if (_needsNode) {
    if (!(await isBunAvailable())) {
      throw new Error('repobase requires Bun for add/sync operations, but Bun is not installed');
    }
    const cliEntry = getRepobaseCliEntryFromBin(bin);
    const { stdout } = await execFileAsync('bun', [cliEntry, ...args], opts);
    return stdout.toString();
  }
  const { stdout } = await execFileAsync('repobase', args, opts);
  return stdout.toString();
}

// ---------------------------------------------------------------------------
// Detection & Installation
// ---------------------------------------------------------------------------

let _installed: boolean | null = null;

/** Check if repobase CLI is available on PATH. Caches the result. */
export async function isRepobaseInstalled(): Promise<boolean> {
  if (_installed !== null) return _installed;
  _installed = (await resolveRepobaseBin()) !== null;
  return _installed;
}

/** Reset the cached install check (e.g., after installation). */
export function resetInstallCache(): void {
  _installed = null;
  _resolvedBin = null;
  _needsNode = false;
  _bunAvailable = null;
  _resolvedBinRealPath = null;
}

/**
 * Install repobase globally via npm.
 * Returns true if installation succeeded or it was already installed.
 */
export async function installRepobase(): Promise<boolean> {
  if (await isRepobaseInstalled()) return true;

  console.log('[Repobase] Installing repobase globally...');
  try {
    await execFileAsync('npm', ['install', '-g', 'repobase'], { timeout: 120_000 });
    resetInstallCache();
    console.log('[Repobase] Installation complete');
    return await isRepobaseInstalled();
  } catch (err) {
    console.warn(`[Repobase] Installation failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Ensure repobase is installed — installs it if missing.
 * Returns true if repobase is available after this call.
 */
export async function ensureRepobaseInstalled(): Promise<boolean> {
  if (await isRepobaseInstalled()) return true;
  return installRepobase();
}

// ---------------------------------------------------------------------------
// Repo management
// ---------------------------------------------------------------------------

/**
 * Add a repo to Repobase by its remote URL.
 * Installs repobase first if needed.
 */
export async function addRepoToRepobase(remoteUrl: string): Promise<boolean> {
  if (!remoteUrl) return false;
  if (!(await ensureRepobaseInstalled())) return false;

  try {
    await runRepobase(['add', remoteUrl], { timeout: 30_000 });
    return true;
  } catch (err) {
    // Already added is fine
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already') || msg.includes('exists')) return true;
    console.warn(`[Repobase] Failed to add repo: ${msg}`);
    return false;
  }
}

/**
 * Sync (re-index) a repo in Repobase.
 * If repoId is omitted, syncs all repos.
 */
export async function syncRepobase(repoId?: string): Promise<boolean> {
  if (!(await isRepobaseInstalled())) return false;

  try {
    const args = repoId ? ['sync', repoId] : ['sync'];
    await runRepobase(args, { timeout: 120_000 });
    return true;
  } catch (err) {
    console.warn(`[Repobase] Sync failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export async function ensureRepoIndexedInRepobase(
  remoteUrl: string,
  onProgress?: (message: string) => void,
): Promise<{ ok: boolean; repoId?: string; warning?: string }> {
  const support = await getRepobaseSupport(remoteUrl);
  if (!support.available || !support.repoId) {
    return { ok: false, warning: support.warnings[0] ?? 'Repobase deep indexing is unavailable.' };
  }

  try {
    onProgress?.('Preparing Repobase repository...');
    const added = await addRepoToRepobase(remoteUrl);
    if (!added) {
      return {
        ok: false,
        warning:
          'Repobase could not add this repository, so Anvil is falling back to a light index.',
      };
    }

    onProgress?.('Syncing Repobase deep index...');
    const synced = await syncRepobase(support.repoId);
    if (!synced) {
      return {
        ok: false,
        warning: 'Repobase sync failed, so Anvil is falling back to a light index.',
      };
    }

    return { ok: true, repoId: support.repoId };
  } catch (err) {
    return {
      ok: false,
      warning: `Repobase deep indexing failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Remove a repo from Repobase by its ID.
 */
export async function removeRepoFromRepobase(repoId: string): Promise<boolean> {
  if (!(await isRepobaseInstalled())) return false;

  try {
    await runRepobase(['remove', repoId], { timeout: 15_000 });
    return true;
  } catch (err) {
    console.warn(`[Repobase] Remove failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Codex MCP registration
// ---------------------------------------------------------------------------

/** Check if repobase-mcp is already registered with Codex CLI. */
async function isRepobaseMcpRegistered(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list'], { timeout: 10_000 });
    return stdout.includes('repobase');
  } catch {
    return false;
  }
}

/**
 * Ensure the repobase-mcp server is registered with Codex CLI.
 * Installs repobase first if needed.
 * Safe to call multiple times — skips if already registered.
 */
export async function ensureRepobaseMcp(): Promise<boolean> {
  const bin = await resolveRepobaseBin();
  if (!bin) return false;

  const mcpBin = getRepobaseMcpEntryFromBin(bin);
  if (!existsSync(mcpBin)) {
    console.warn('[Repobase] repobase-mcp entrypoint not found');
    return false;
  }

  if (await isRepobaseMcpRegistered()) return true;

  const mcpCmd = ['codex', ['mcp', 'add', 'repobase', '--', process.execPath, mcpBin]] as const;

  try {
    await execFileAsync(mcpCmd[0], [...mcpCmd[1]], { timeout: 15_000 });
    console.log('[Repobase] Registered repobase-mcp with Codex CLI');
    return true;
  } catch (err) {
    console.warn(`[Repobase] Failed to register MCP: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combined setup — call after repo indexing
// ---------------------------------------------------------------------------

/**
 * After a Anvil repo is indexed, add it to Repobase and sync.
 * Also ensures repobase is installed and the MCP server is registered with Codex.
 * Runs in the background — never throws.
 */
export async function onRepoIndexed(remoteUrl: string | null): Promise<void> {
  if (!remoteUrl) return;

  try {
    const support = await getRepobaseSupport(remoteUrl);
    if (!support.available) return;

    const added = await addRepoToRepobase(remoteUrl);
    if (added) {
      await syncRepobase();
    }
    await ensureRepobaseMcp();
  } catch (err) {
    console.warn(`[Repobase] Post-index setup failed: ${err instanceof Error ? err.message : err}`);
  }
}
