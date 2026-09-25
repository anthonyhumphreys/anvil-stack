// WS-03: bootstrap recipe runner (spec §7).
//
// Executes a BootstrapRecipe's ordered `command`/`verify` steps against a
// materialised checkout. Safety properties the spec demands:
//
// - Ambient credentials are stripped: the child gets a minimal env
//   allowlist plus only the bindings the caller explicitly resolves for
//   declared `envNames`.
// - Shell and code-interpreter steps run only when the caller asserts explicit
//   local code consent (`shellApproved`) — executable repository code is never
//   run silently.
// - Steps spawn in their own process group; cancellation SIGTERMs the
//   group then escalates to SIGKILL. A step killed or timed out mid-run
//   is `unknown-outcome` — its effects are uncertain and must never be
//   auto-replayed without inspection.
// - Logs are captured bounded (tail ring) and sanitized upstream.
//
// Persistence is deliberately injected (`onStepState`): the WS-02
// materialisation journal owns durable step rows; this runner only
// reports transitions so it stays usable standalone and testable.

import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  BootstrapRecipe,
  BootstrapStep,
  BootstrapStepState,
} from '../../../cloud/contract/bootstrap.js';

const LOG_TAIL_LIMIT = 64 * 1024; // bounded per-step log capture

/** Minimal ambient environment — no tokens, keys, or app config. */
const AMBIENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'TERM',
  'SYSTEMROOT',
  'COMSPEC',
  'WINDIR',
] as const;

/**
 * Every bootstrap step executes a recipe-selected command or shell expression.
 * Keep this predicate broad: command-name allowlists cannot account for every
 * executable that can run repository code.
 */
export function bootstrapStepRequiresLocalCodeConsent(step: BootstrapStep): boolean {
  return step.shell !== undefined || step.argv !== undefined;
}

export interface BootstrapStepOutcome {
  stepId: string;
  state: BootstrapStepState;
  exitCode: number | null;
  /** Bounded tail of combined stdout/stderr. */
  log: string;
  timedOut: boolean;
}

export interface BootstrapRunResult {
  /** Overall: all steps verified, or the first non-verified outcome. */
  state: 'verified' | 'failed' | 'unknown-outcome';
  steps: BootstrapStepOutcome[];
}

export interface BootstrapRunOptions {
  /** Absolute path the step working directories resolve against. */
  checkoutRoot: string;
  /**
   * Resolves an env binding for a declared `envNames` entry. Returning
   * undefined leaves the name unset — a step that needs it fails loudly.
   */
  resolveEnv?: (name: string) => string | undefined;
  /** Explicit local code consent from the local approval record. */
  shellApproved?: boolean;
  /** Journal hook: invoked on every step state transition. */
  onStepState?: (stepId: string, state: BootstrapStepState, detail?: string) => void;
  /** Bounded per-step log sink for live observation. */
  onStepLog?: (stepId: string, chunk: string) => void;
}

export interface BootstrapRunHandle {
  done: Promise<BootstrapRunResult>;
  /** Terminate the in-flight step's process group. */
  cancel(): void;
}

class TailBuffer {
  private chunks: string[] = [];
  private size = 0;

  push(chunk: string): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > LOG_TAIL_LIMIT && this.chunks.length > 1) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
    }
  }

  text(): string {
    return this.chunks.join('');
  }
}

function buildEnv(step: BootstrapStep, resolveEnv?: (name: string) => string | undefined) {
  const env: Record<string, string> = {};
  for (const name of AMBIENT_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of step.envNames) {
    const value = resolveEnv?.(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  setTimeout(() => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Group already exited.
    }
  }, 5_000).unref();
}

/**
 * Runs the recipe's steps in order, stopping at the first non-verified
 * outcome. `cancel()` terminates the in-flight step (reported
 * `unknown-outcome` since its effects are unproven) and skips the rest.
 */
export function runBootstrapRecipe(
  recipe: BootstrapRecipe,
  options: BootstrapRunOptions,
): BootstrapRunHandle {
  let cancelled = false;
  let activeChild: ChildProcess | null = null;

  const done = (async (): Promise<BootstrapRunResult> => {
    const outcomes: BootstrapStepOutcome[] = [];
    for (const step of recipe.steps) {
      if (cancelled) break;
      const outcome = await runStep(step, options, (child) => {
        activeChild = child;
      });
      activeChild = null;
      outcomes.push(outcome);
      if (outcome.state !== 'verified') break;
    }
    // Steps only exit the loop verified or terminal — a stop leaves the
    // remaining steps unproven, so cancellation is unknown-outcome.
    let overall: BootstrapRunResult['state'] = 'verified';
    const last = outcomes.at(-1);
    if (cancelled) overall = 'unknown-outcome';
    else if (last !== undefined && last.state !== 'verified') {
      overall = last.state === 'failed' ? 'failed' : 'unknown-outcome';
    }
    return { state: overall, steps: outcomes };
  })();

  return {
    done,
    cancel() {
      cancelled = true;
      if (activeChild !== null) killGroup(activeChild);
    },
  };
}

async function runStep(
  step: BootstrapStep,
  options: BootstrapRunOptions,
  onSpawn: (child: ChildProcess) => void,
): Promise<BootstrapStepOutcome> {
  const { onStepState, onStepLog } = options;
  if (bootstrapStepRequiresLocalCodeConsent(step) && options.shellApproved !== true) {
    const detail =
      step.shell !== undefined
        ? 'shell step without explicit approval'
        : 'argv step without explicit local code approval';
    onStepState?.(step.id, 'failed', detail);
    return Promise.resolve({
      stepId: step.id,
      state: 'failed',
      exitCode: null,
      log:
        step.shell !== undefined
          ? 'shell step refused: no explicit shell approval'
          : `${detail}: refused`,
      timedOut: false,
    });
  }

  let cwd: string;
  try {
    cwd = await resolveContainedWorkingDirectory(options.checkoutRoot, step.workingDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onStepState?.(step.id, 'failed', detail);
    return {
      stepId: step.id,
      state: 'failed',
      exitCode: null,
      log: detail,
      timedOut: false,
    };
  }

  onStepState?.(step.id, 'running');
  return new Promise((resolveOutcome) => {
    const tail = new TailBuffer();
    const argv = step.argv ?? [];
    const child =
      step.shell !== undefined
        ? spawn(step.shell, {
            cwd,
            env: buildEnv(step, options.resolveEnv),
            shell: true,
            detached: true,
          })
        : spawn(argv[0] ?? '', argv.slice(1), {
            cwd,
            env: buildEnv(step, options.resolveEnv),
            detached: true,
          });
    onSpawn(child);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, step.timeoutMs);
    timer.unref?.();

    const capture = (data: Buffer | string) => {
      const text = data.toString();
      tail.push(text);
      onStepLog?.(step.id, text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    child.on('error', (error) => {
      clearTimeout(timer);
      onStepState?.(step.id, 'failed', error.message);
      resolveOutcome({
        stepId: step.id,
        state: 'failed',
        exitCode: null,
        log: `${tail.text()}${error.message}`,
        timedOut,
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const uncertain = timedOut || signal !== null;
      const state: BootstrapStepState =
        code === 0 ? 'verified' : uncertain ? 'unknown-outcome' : 'failed';
      onStepState?.(step.id, state, signal ?? undefined);
      resolveOutcome({
        stepId: step.id,
        state,
        exitCode: code,
        log: tail.text(),
        timedOut,
      });
    });
  });
}

async function resolveContainedWorkingDirectory(
  checkoutRoot: string,
  workingDirectory: string,
): Promise<string> {
  if (
    workingDirectory.length === 0 ||
    isAbsolute(workingDirectory) ||
    workingDirectory.startsWith('\\') ||
    /^[a-z]:/i.test(workingDirectory) ||
    workingDirectory.split(/[\\/]+/).some((segment) => segment === '..')
  ) {
    throw new Error('bootstrap working directory must be relative to the checkout root');
  }

  const resolvedRoot = await realpath(checkoutRoot);
  const candidate = resolve(checkoutRoot, workingDirectory);
  const resolvedCandidate = await realpath(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  const contained =
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
  if (!contained) {
    throw new Error('bootstrap working directory resolves outside the checkout root');
  }

  const info = await stat(resolvedCandidate);
  if (!info.isDirectory()) {
    throw new Error('bootstrap working directory is not a directory');
  }
  return resolvedCandidate;
}
