import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Electron GUI apps on macOS/Linux don't inherit the user's full shell env.
 * This means globally-installed CLIs (codex, repobase, git, etc.) that live
 * under nvm, Homebrew, or similar aren't found by child_process.spawn, and
 * env vars set in .zshrc/.bashrc (like API keys) aren't available.
 *
 * Fix: ask the user's login shell for its full environment and merge it in.
 */
export function fixPath(): void {
  if (process.platform === 'win32') return;

  const original = process.env.PATH ?? '';

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    // Use -lc (login, non-interactive) to source the user's profile.
    // Dump the full environment with `env` so we capture all variables.
    const output = execFileSync(
      shell,
      ['-lic', 'echo "__ENV_START__" && env && echo "__ENV_END__"'],
      { encoding: 'utf-8', timeout: 5000 },
    );

    const envMatch = output.match(/__ENV_START__\n([\s\S]+)__ENV_END__/);
    if (envMatch?.[1]) {
      for (const line of envMatch[1].split('\n')) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.substring(0, idx);
        const value = line.substring(idx + 1);
        // Don't clobber Electron-internal vars (e.g. ELECTRON_RUN_AS_NODE)
        if (key.startsWith('ELECTRON_') || key === '_') continue;
        process.env[key] = value;
      }
      return;
    }
  } catch {
    // Shell invocation failed — fall through to manual PATH detection
  }

  // Fallback: probe common bin directories and the active nvm node version
  const home = process.env.HOME ?? '';
  const extras = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    join(home, '.bun/bin'),
  ];

  // Detect the active nvm node version's bin directory
  const nvmDir = join(home, '.nvm/versions/node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      for (const v of versions) {
        const binDir = join(nvmDir, v, 'bin');
        if (existsSync(binDir)) {
          extras.push(binDir);
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const missing = extras.filter((p) => existsSync(p) && !original.includes(p));
  if (missing.length > 0) {
    process.env.PATH = `${missing.join(':')}:${original}`;
  }
}
