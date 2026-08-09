import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockPty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

const ptyState = vi.hoisted(() => ({
  spawned: [] as MockPty[],
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let dataListener: (data: string) => void = () => undefined;
    let exitListener: (event: { exitCode: number }) => void = () => undefined;
    const instance: MockPty = {
      pid: 1000 + ptyState.spawned.length,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      emitData: (data) => dataListener(data),
      emitExit: (exitCode) => exitListener({ exitCode }),
    };
    Object.assign(instance, {
      onData: (listener: (data: string) => void) => {
        dataListener = listener;
      },
      onExit: (listener: (event: { exitCode: number }) => void) => {
        exitListener = listener;
      },
    });
    ptyState.spawned.push(instance);
    return instance;
  }),
}));

vi.mock('../../utils/shell.js', () => ({
  getDefaultShell: () => '/bin/zsh',
}));

import {
  TERMINAL_REPLAY_CHAR_LIMIT,
  attachTerminal,
  closeAllTerminals,
  closeTerminal,
  createTerminal,
  listTerminals,
  subscribeToTerminalEvents,
} from '../terminal.service.js';

beforeEach(() => {
  closeAllTerminals();
  ptyState.spawned.length = 0;
  vi.clearAllMocks();
});

describe('terminal service sessions', () => {
  it('keeps one main-process terminal per workspace and repository for reattachment', () => {
    const first = createTerminal('workspace-a', 'repo-a', '/repo-a');
    const second = createTerminal('workspace-a', 'repo-a', '/repo-a');

    expect(second.terminalId).toBe(first.terminalId);
    expect(ptyState.spawned).toHaveLength(1);
    expect(listTerminals('workspace-a')).toEqual([first]);
    expect(listTerminals('workspace-b')).toEqual([]);
  });

  it('buffers sequenced output for a renderer that attaches later', () => {
    const session = createTerminal('workspace-a', 'repo-a', '/repo-a');
    ptyState.spawned[0].emitData('first');
    ptyState.spawned[0].emitData('second');

    expect(attachTerminal(session.terminalId)).toMatchObject({
      session: { sequence: 2, status: 'running' },
      output: [
        { sequence: 1, data: 'first' },
        { sequence: 2, data: 'second' },
      ],
    });
    expect(attachTerminal(session.terminalId, 1).output).toEqual([{ sequence: 2, data: 'second' }]);
  });

  it('bounds replay output without stopping live terminal events', () => {
    const session = createTerminal('workspace-a', 'repo-a', '/repo-a');
    const events: string[] = [];
    const unsubscribe = subscribeToTerminalEvents((event) => {
      if (event.type === 'data') events.push(event.data);
    });

    ptyState.spawned[0].emitData('x'.repeat(TERMINAL_REPLAY_CHAR_LIMIT + 10));

    expect(attachTerminal(session.terminalId).output[0].data).toHaveLength(
      TERMINAL_REPLAY_CHAR_LIMIT,
    );
    expect(events[0]).toHaveLength(TERMINAL_REPLAY_CHAR_LIMIT);
    unsubscribe();
  });

  it('retains completed output and status until the user explicitly closes the session', () => {
    const session = createTerminal('workspace-a', 'repo-a', '/repo-a');
    ptyState.spawned[0].emitData('done');
    ptyState.spawned[0].emitExit(7);

    expect(attachTerminal(session.terminalId)).toMatchObject({
      session: { status: 'exited', exitCode: 7 },
      output: [{ sequence: 1, data: 'done' }],
    });

    closeTerminal(session.terminalId);
    expect(listTerminals('workspace-a')).toEqual([]);
  });

  it('closes only the explicitly targeted terminal', () => {
    const first = createTerminal('workspace-a', 'repo-a', '/repo-a');
    createTerminal('workspace-b', 'repo-b', '/repo-b');

    closeTerminal(first.terminalId);

    expect(ptyState.spawned[0].kill).toHaveBeenCalledOnce();
    expect(ptyState.spawned[1].kill).not.toHaveBeenCalled();
    expect(listTerminals('workspace-a')).toEqual([]);
    expect(listTerminals('workspace-b')).toHaveLength(1);
  });
});
