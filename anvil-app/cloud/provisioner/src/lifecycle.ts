import type { MeshEnvironmentBootstrap } from './bootstrap';

interface SandboxProcess { id: string; state: string; command?: readonly string[] }
interface SandboxLike {
  listProcesses(): Promise<readonly SandboxProcess[]>;
  exec(command: readonly [string, ...string[]], options: { env: Record<string, string> }): Promise<{ id: string }>;
}

const BOOT_ARGV = ['/opt/anvil/bin/anvil-worker-boot'] as const;

export function isBootProcess(process: SandboxProcess): boolean {
  return process.state === 'running' && process.command?.[0] === BOOT_ARGV[0];
}

/** Start the worker once, returning the SDK process handle id immediately. */
export async function bootWithSandbox(
  sandbox: SandboxLike,
  bootstrap: MeshEnvironmentBootstrap,
): Promise<{ processId: string; reused: boolean }> {
  const running = await sandbox.listProcesses();
  const live = running.find(isBootProcess);
  if (live !== undefined) return { processId: live.id, reused: true };
  const process = await sandbox.exec(BOOT_ARGV, {
    env: { ANVIL_BOOTSTRAP_JSON: JSON.stringify(bootstrap) },
  });
  return { processId: process.id, reused: false };
}
