import * as pty from 'node-pty';
import type {
  TerminalAttachResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalOutputChunk,
  TerminalSessionSummary,
} from '../../shared/types.js';
import { getDefaultShell } from '../utils/shell.js';

export const TERMINAL_REPLAY_CHAR_LIMIT = 500_000;
export const TERMINAL_REPLAY_CHUNK_LIMIT = 4_096;
export const TERMINAL_TOTAL_REPLAY_CHAR_LIMIT = 8_000_000;
export const TERMINAL_TOTAL_REPLAY_CHUNK_LIMIT = 32_768;

interface ManagedTerminal extends TerminalSessionSummary {
  pty: pty.IPty | null;
  output: TerminalOutputChunk[];
  outputChars: number;
}

type TerminalServiceEvent =
  | ({ type: 'data' } & TerminalDataEvent)
  | ({ type: 'exit' } & TerminalExitEvent);

const terminals = new Map<string, ManagedTerminal>();
let totalReplayChars = 0;
let totalReplayChunks = 0;
const eventListeners = new Set<(event: TerminalServiceEvent) => void>();

function toSummary(terminal: ManagedTerminal): TerminalSessionSummary {
  return {
    terminalId: terminal.terminalId,
    workspaceId: terminal.workspaceId,
    repoId: terminal.repoId,
    cwd: terminal.cwd,
    status: terminal.status,
    exitCode: terminal.exitCode,
    createdAt: terminal.createdAt,
    sequence: terminal.sequence,
  };
}

function emit(event: TerminalServiceEvent): void {
  for (const listener of eventListeners) listener(event);
}

function appendOutput(terminal: ManagedTerminal, data: string): TerminalDataEvent {
  terminal.sequence += 1;
  const chunk: TerminalOutputChunk = {
    sequence: terminal.sequence,
    data: data.length > TERMINAL_REPLAY_CHAR_LIMIT ? data.slice(-TERMINAL_REPLAY_CHAR_LIMIT) : data,
  };
  terminal.output.push(chunk);
  terminal.outputChars += chunk.data.length;
  totalReplayChars += chunk.data.length;
  totalReplayChunks += 1;
  // Map order tracks recent output so aggregate pressure evicts quiet replay first.
  terminals.delete(terminal.terminalId);
  terminals.set(terminal.terminalId, terminal);

  while (
    terminal.output.length > 1 &&
    (terminal.outputChars > TERMINAL_REPLAY_CHAR_LIMIT ||
      terminal.output.length > TERMINAL_REPLAY_CHUNK_LIMIT)
  ) {
    removeOldestOutput(terminal);
  }
  for (const candidate of terminals.values()) {
    while (
      candidate.output.length &&
      (totalReplayChars > TERMINAL_TOTAL_REPLAY_CHAR_LIMIT ||
        totalReplayChunks > TERMINAL_TOTAL_REPLAY_CHUNK_LIMIT)
    ) {
      removeOldestOutput(candidate);
    }
    if (
      totalReplayChars <= TERMINAL_TOTAL_REPLAY_CHAR_LIMIT &&
      totalReplayChunks <= TERMINAL_TOTAL_REPLAY_CHUNK_LIMIT
    )
      break;
  }

  return { terminalId: terminal.terminalId, ...chunk };
}

function removeOldestOutput(terminal: ManagedTerminal): void {
  const removed = terminal.output.shift();
  if (!removed) return;
  terminal.outputChars -= removed.data.length;
  totalReplayChars -= removed.data.length;
  totalReplayChunks -= 1;
}

export function createTerminal(
  workspaceId: string,
  repoId: string,
  cwd: string,
): TerminalSessionSummary {
  const terminalId = `${workspaceId}-${repoId}`;
  const existing = terminals.get(terminalId);
  if (existing) return toSummary(existing);

  const shell = getDefaultShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: process.env as Record<string, string>,
  });
  const terminal: ManagedTerminal = {
    pty: ptyProcess,
    terminalId,
    workspaceId,
    repoId,
    cwd,
    status: 'running',
    createdAt: new Date().toISOString(),
    sequence: 0,
    output: [],
    outputChars: 0,
  };

  ptyProcess.onData((data) => {
    if (terminals.get(terminalId) !== terminal) return;
    emit({ type: 'data', ...appendOutput(terminal, data) });
  });
  ptyProcess.onExit(({ exitCode }) => {
    if (terminals.get(terminalId) !== terminal) return;
    terminal.pty = null;
    terminal.status = 'exited';
    terminal.exitCode = exitCode;
    emit({ type: 'exit', terminalId, exitCode });
  });

  terminals.set(terminalId, terminal);
  return toSummary(terminal);
}

export function listTerminals(workspaceId: string): TerminalSessionSummary[] {
  return [...terminals.values()]
    .filter((terminal) => terminal.workspaceId === workspaceId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(toSummary);
}

export function attachTerminal(terminalId: string, afterSequence = 0): TerminalAttachResult {
  const terminal = terminals.get(terminalId);
  if (!terminal) throw new Error(`Terminal session not found: ${terminalId}`);

  return {
    session: toSummary(terminal),
    output: terminal.output.filter((chunk) => chunk.sequence > afterSequence),
  };
}

export function subscribeToTerminalEvents(
  listener: (event: TerminalServiceEvent) => void,
): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function writeToTerminal(terminalId: string, data: string): void {
  const terminal = terminals.get(terminalId);
  if (terminal?.status === 'running') terminal.pty?.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  const terminal = terminals.get(terminalId);
  if (terminal?.status === 'running') terminal.pty?.resize(cols, rows);
}

export function closeTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId);
  if (!terminal) return;

  terminals.delete(terminalId);
  totalReplayChars -= terminal.outputChars;
  totalReplayChunks -= terminal.output.length;
  terminal.pty?.kill();
}

export function closeAllTerminals(): void {
  const openTerminals = [...terminals.values()];
  terminals.clear();
  totalReplayChars = 0;
  totalReplayChunks = 0;
  for (const terminal of openTerminals) terminal.pty?.kill();
}

export function getTerminalDiagnostics() {
  return {
    trackedTerminals: terminals.size,
    replayBytes: totalReplayChars * 2,
    replayChunks: totalReplayChunks,
    activeTerminals: [...terminals.values()].filter((terminal) => terminal.status === 'running')
      .length,
  };
}
