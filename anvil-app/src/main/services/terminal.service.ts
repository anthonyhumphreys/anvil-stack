import * as pty from 'node-pty';
// Note: if CJS/ESM interop fails at build, try `import pty from 'node-pty'` instead
import { getDefaultShell } from '../utils/shell.js';

interface ManagedTerminal {
  pty: pty.IPty;
  terminalId: string;
}

const terminals = new Map<string, ManagedTerminal>();

export function createTerminal(
  workspaceId: string,
  repoId: string,
  cwd: string,
  onData: (terminalId: string, data: string) => void,
  onExit: (terminalId: string, exitCode: number) => void,
): string {
  const terminalId = `${workspaceId}-${repoId}`;

  // If terminal already exists for this key, return it
  if (terminals.has(terminalId)) {
    return terminalId;
  }

  const shell = getDefaultShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  });

  ptyProcess.onData((data) => onData(terminalId, data));
  ptyProcess.onExit(({ exitCode }) => {
    terminals.delete(terminalId);
    onExit(terminalId, exitCode);
  });

  terminals.set(terminalId, { pty: ptyProcess, terminalId });
  return terminalId;
}

export function writeToTerminal(terminalId: string, data: string): void {
  const t = terminals.get(terminalId);
  if (t) t.pty.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const t = terminals.get(terminalId);
  if (t) t.pty.resize(cols, rows);
}

export function closeTerminal(terminalId: string): void {
  const t = terminals.get(terminalId);
  if (t) {
    t.pty.kill();
    terminals.delete(terminalId);
  }
}

export function closeAllTerminals(): void {
  for (const t of terminals.values()) {
    t.pty.kill();
  }
  terminals.clear();
}

export function getTerminalDiagnostics(): { activeTerminals: number } {
  return { activeTerminals: terminals.size };
}
