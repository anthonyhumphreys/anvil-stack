import { spawn, type ChildProcess } from 'node:child_process';
import { permissionSandbox, type PermissionMode } from '../../../cloud/contract/permissions.js';
import { killProcessGroup } from './mesh-session.service.js';

export interface MeshCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  log: string;
}

/** Direct execution needs full access or explicit one-run approval. Other modes use Codex's OS sandbox. */
export async function executeMeshCommand(input: {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  mode: PermissionMode;
  timeoutMs: number;
  onSpawn?: (child: ChildProcess) => void;
  isCancelled?: () => boolean;
}): Promise<MeshCommandResult> {
  if (input.isCancelled?.() === true) throw new Error('mesh-command-cancelled');
  const watchCancellation = (child: ChildProcess): ReturnType<typeof setInterval> | undefined =>
    input.isCancelled === undefined
      ? undefined
      : setInterval(() => {
          if (input.isCancelled?.() === true) {
            void killProcessGroup(child);
          }
        }, 500);
  if (input.mode === 'full-access' || input.mode === 'on-request') {
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    input.onSpawn?.(child);
    const cancellation = watchCancellation(child);
    let log = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<MeshCommandResult>((resolve) => {
        timer = setTimeout(() => resolve({ exitCode: null, timedOut: true, log }), input.timeoutMs);
        const append = (chunk: Buffer): void => {
          log = (log + chunk.toString()).slice(-16_384);
        };
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        child.on('error', (error) =>
          resolve({ exitCode: null, timedOut: false, log: error.message }),
        );
        child.on('exit', (code) => resolve({ exitCode: code, timedOut: false, log }));
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancellation !== undefined) clearInterval(cancellation);
      await killProcessGroup(child);
    }
  }

  // command/exec runs argv without an agent/model turn. Explicit policy and env
  // prevent the local Codex configuration from broadening this node's ceiling.
  const proc = spawn('codex', ['app-server', '-c', 'shell_environment_policy.inherit="none"'], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  input.onSpawn?.(proc);
  const cancellation = watchCancellation(proc);
  let buffer = '';
  let stderr = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (message: unknown): void => {
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  try {
    return await new Promise<MeshCommandResult>((resolve, reject) => {
      timer = setTimeout(
        () => resolve({ exitCode: null, timedOut: true, log: stderr }),
        input.timeoutMs + 10_000,
      );
      proc.on('error', reject);
      proc.on('exit', () =>
        reject(new Error('Mesh sandbox exited before returning a command result.')),
      );
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 1024 * 1024) {
          reject(new Error('Mesh sandbox response exceeded its output limit.'));
          return;
        }
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          let message: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error !== undefined) {
            reject(new Error(message.error.message ?? 'Mesh sandbox rejected the command.'));
            return;
          }
          if (message.id === 1) {
            write({ method: 'initialized', params: {} });
            write({
              id: 2,
              method: 'command/exec',
              params: {
                command: input.argv,
                cwd: input.cwd,
                env: input.env,
                timeoutMs: input.timeoutMs,
                outputBytesCap: 16_384,
                sandboxPolicy:
                  permissionSandbox(input.mode) === 'read-only'
                    ? { type: 'readOnly', networkAccess: false }
                    : {
                        type: 'workspaceWrite',
                        writableRoots: [input.cwd],
                        networkAccess: false,
                        excludeTmpdirEnvVar: true,
                        excludeSlashTmp: true,
                      },
              },
            });
          } else {
            const result = message.result as
              | { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
              | undefined;
            if (
              typeof result?.exitCode !== 'number' ||
              typeof result.stdout !== 'string' ||
              typeof result.stderr !== 'string'
            ) {
              reject(new Error('Mesh sandbox returned an invalid command result.'));
              return;
            }
            resolve({
              exitCode: result.exitCode,
              timedOut: result.exitCode === 124,
              log: (result.stdout + result.stderr).slice(-16_384),
            });
          }
        }
      });
      write({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'anvil-mesh-command', version: '0' },
          capabilities: { experimentalApi: true },
        },
      });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancellation !== undefined) clearInterval(cancellation);
    await killProcessGroup(proc);
  }
}
