import { app } from 'electron';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  ReviewCapture,
  ReviewScenario,
  ReviewSnapshot,
} from '../../shared/change-review-types.js';
import { reviewGit, snapshotCommit, captureReviewSnapshot } from './review-snapshot.service.js';
import { stripAnsi } from '../../shared/strip-ansi.js';

export const digest = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
export function reviewArtifactRoot(): string {
  return join(app.getPath('userData'), 'change-review');
}
function stop(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* exited */
    }
  }, 2000);
  timer.unref();
}
function command(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  log: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abort = () => stop(child);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout?.on('data', (data) => log(String(data)));
    child.stderr?.on('data', (data) => log(String(data)));
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (code === 0 && !signal.aborted) resolve();
      else reject(new Error(`Command exited ${code ?? 'without an exit code'}`));
    });
  });
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
export async function runReviewSide(input: {
  repoPath: string;
  commit: string;
  snapshot?: ReviewSnapshot;
  scenario: ReviewScenario;
  runDir: string;
  side: 'base' | 'candidate';
  signal: AbortSignal;
  log(text: string): void;
}): Promise<ReviewCapture[]> {
  const { repoPath, scenario, side, signal, log } = input;
  const cwd = join(input.runDir, `${side}-source`);
  const output = join(input.runDir, side);
  mkdirSync(output, { recursive: true });
  const commit = input.snapshot ? snapshotCommit(repoPath, input.snapshot) : input.commit;
  reviewGit(repoPath, ['worktree', 'add', '--detach', cwd, commit]);
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    ANVIL_REVIEW_PORT: String(port),
    ANVIL_REVIEW_URL: baseURL,
    ANVIL_REVIEW_DATA: join(input.runDir, `${side}-data`),
    ANVIL_REVIEW_TREE:
      input.snapshot?.tree ?? reviewGit(repoPath, ['rev-parse', `${commit}^{tree}`]),
  };
  mkdirSync(env.ANVIL_REVIEW_DATA, { recursive: true });
  let server: ChildProcess | undefined;
  const abort = () => {
    if (server) stop(server);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (scenario.setupCommand) await command(scenario.setupCommand, cwd, env, signal, log);
    await command(scenario.resetCommand, cwd, env, signal, log);
    signal.throwIfAborted();
    if (captureReviewSnapshot(cwd).tree !== env.ANVIL_REVIEW_TREE)
      throw new Error('Setup or reset changed the source snapshot.');
    server = spawn(scenario.startCommand, {
      shell: true,
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverError: Error | undefined;
    server.on('error', (error) => {
      serverError = error;
    });
    server.stdout?.on('data', (data) => log(String(data)));
    server.stderr?.on('data', (data) => log(String(data)));
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error('Review server exited before it was ready.');
      try {
        const response = await fetch(new URL(scenario.readyPath, baseURL), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
          redirect: 'error',
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Review server did not become ready within 60 seconds.');
    if (server.exitCode !== null) throw new Error('The server exited during readiness checking.');
    const listeners = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 5000,
    })
      .trim()
      .split(/\s+/);
    if (
      !listeners.length ||
      listeners.some(
        (pid) =>
          Number(
            execFileSync('ps', ['-o', 'pgid=', '-p', pid], {
              encoding: 'utf8',
              timeout: 5000,
            }).trim(),
          ) !== server!.pid,
      )
    )
      throw new Error('The served build could not be bound to this review process.');
    const config = join(output, 'scenario.json');
    writeFileSync(config, JSON.stringify(scenario), { mode: 0o600 });
    const script = join(app.getAppPath(), 'scripts/review-scenario-runner.mjs');
    // Resolve Playwright from the configured repo. Commands run in the frozen worktree.
    const moduleRoot = existsSync(join(cwd, 'node_modules')) ? cwd : repoPath;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, moduleRoot, config, output, baseURL], {
        cwd,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cancel = () => stop(child);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout?.on('data', (data) => log(String(data)));
      child.stderr?.on('data', (data) => log(String(data)));
      child.on('error', reject);
      child.on('close', (code) => {
        signal.removeEventListener('abort', cancel);
        if (!signal.aborted && (code === 0 || code === 1)) resolve();
        else reject(new Error(`Scenario runner exited ${code}`));
      });
    });
    if (captureReviewSnapshot(cwd).tree !== env.ANVIL_REVIEW_TREE)
      throw new Error('Source changed during verification.');
    if (!existsSync(join(output, 'results.json')))
      throw new Error(
        'The browser runner did not produce results. Check the run output for Playwright installation or browser launch errors.',
      );
    const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8')) as {
      browser: string;
      results: Omit<ReviewCapture, 'id' | 'imageDigest' | 'traceDigest'>[];
    };
    log(`Browser: Chromium ${report.browser}\n`);
    if (report.results.length !== scenario.viewports.length)
      throw new Error('Incomplete scenario results.');
    return report.results.map((capture) => ({
      ...capture,
      steps: capture.steps.map((step) => ({
        ...step,
        ...(step.detail !== undefined ? { detail: stripAnsi(step.detail) } : {}),
      })),
      id: randomUUID(),
      image: join(side, capture.image),
      trace: join(side, capture.trace),
      imageDigest: digest(readFileSync(join(output, capture.image))),
      traceDigest: digest(readFileSync(join(output, capture.trace))),
    }));
  } finally {
    signal.removeEventListener('abort', abort);
    if (server) stop(server);
    try {
      reviewGit(repoPath, ['worktree', 'remove', '--force', cwd]);
    } catch (error) {
      log(`Worktree cleanup failed: ${String(error)}\n`);
    }
  }
}
