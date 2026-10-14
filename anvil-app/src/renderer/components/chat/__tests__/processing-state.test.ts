import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatMessagesToEntries, upsertCommandEntry } from '../../../contexts/ChatContext';
import { composeChatTurns, type ChatTurnWorkItem } from '../chat-turns';
import { TurnWorkMessage } from '../ChatMessage';
import {
  countProcessingActions,
  getOperationStatus,
  getProcessingState,
} from '../processing-state';

describe('processing evidence and rendering', () => {
  it('counts operations and failures without counting reasoning and status rows as actions', () => {
    const items: ChatTurnWorkItem[] = [
      { kind: 'thinking', content: 'Inspecting', sourceIndex: 0 },
      { kind: 'event', event: { type: 'command_exec', exitCode: 1 }, sourceIndex: 1 },
      { kind: 'event', event: { type: 'tool_call', toolStatus: 'completed' }, sourceIndex: 2 },
      { kind: 'event', event: { type: 'status', status: 'complete' }, sourceIndex: 3 },
    ];
    expect(countProcessingActions(items)).toEqual({ actions: 2, failed: 1 });
  });
  it('lets terminal outcomes override stale waiting flags and busy state', () => {
    const items: ChatTurnWorkItem[] = [
      {
        kind: 'event',
        sourceIndex: 0,
        event: { type: 'thread_status', threadActiveFlags: ['waitingOnApproval'] },
      },
    ];
    expect(getProcessingState({ items, busy: true, waiting: true, outcome: 'completed' })).toBe(
      'completed',
    );
    expect(getProcessingState({ items, busy: true, outcome: 'failed' })).toBe('failed');
    expect(getProcessingState({ items, busy: true, outcome: 'interrupted' })).toBe('stopped');
    expect(getProcessingState({ items: [], busy: false, outcome: 'inProgress' })).toBe('ended');
  });
  it('keeps interleaved commands separate by id and session while preserving output', () => {
    let entries = upsertCommandEntry([], {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      command: 'pnpm test',
      output: 'first',
    });
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'two',
      command: 'pnpm test',
    });
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      output: ' second',
    });
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      command: 'pnpm test',
      exitCode: 0,
    });
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'b',
      itemId: 'one',
      command: 'pnpm test',
    });
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ event: { output: 'first second', exitCode: 0 } });
    expect(entries[1]).toMatchObject({ event: { itemId: 'two' } });
    expect(entries[1].kind === 'event' && entries[1].event.exitCode).toBeUndefined();
    expect(entries[2]).toMatchObject({ event: { sessionId: 'b', itemId: 'one' } });
  });

  it('attaches id-less output to the running command and never adds a blank row', () => {
    let entries = upsertCommandEntry([], {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      command: "/bin/zsh -lc 'git diff --stat'",
      toolStatus: 'running',
    });
    entries = upsertCommandEntry(entries, { type: 'command_exec', sessionId: 'a', output: 'a.ts' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: { itemId: 'one', output: 'a.ts' } });

    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      command: "/bin/zsh -lc 'git diff --stat'",
      output: 'a.ts | 2 +-',
      exitCode: 0,
    });
    // Late deltas after completion (with or without an id) are dropped.
    entries = upsertCommandEntry(entries, { type: 'command_exec', sessionId: 'a', output: 'late' });
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'one',
      output: 'late',
    });
    // Output for an unknown command id is dropped too.
    entries = upsertCommandEntry(entries, {
      type: 'command_exec',
      sessionId: 'a',
      itemId: 'ghost',
      output: 'stray',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: { output: 'a.ts | 2 +-', exitCode: 0 } });
  });

  it('drops persisted output-only rows on reload instead of rendering blank commands', () => {
    const entries = chatMessagesToEntries([
      {
        id: 'm1',
        role: 'system',
        content: 'command_exec',
        timestamp: '2026-10-13T10:00:00.000Z',
        event: { type: 'command_exec', itemId: 'one', command: 'git status', exitCode: 0 },
      },
      {
        id: 'm2',
        role: 'system',
        content: 'command_exec',
        timestamp: '2026-10-13T10:00:01.000Z',
        event: { type: 'command_exec', command: '', output: 'stray tail' },
      },
    ] as Parameters<typeof chatMessagesToEntries>[0]);
    const commands = entries.filter(
      (entry) => entry.kind === 'event' && entry.event.type === 'command_exec',
    );
    expect(commands).toHaveLength(1);
  });

  it('does not invent successful outcomes for commands or sparse tool records', () => {
    expect(getOperationStatus({ type: 'command_exec' }, false)).toBe('recorded');
    expect(getOperationStatus({ type: 'tool_call', toolStatus: 'running' }, false)).toBe(
      'recorded',
    );
    expect(
      getOperationStatus({ type: 'command_exec', exitCode: 1, toolStatus: 'completed' }, false),
    ).toBe('failed');
  });

  it('reports waiting flags, clears them on later thread status, and keeps replay static', () => {
    const items: ChatTurnWorkItem[] = [
      {
        kind: 'event',
        sourceIndex: 0,
        event: { type: 'thread_status', threadActiveFlags: ['waitingOnApproval'] },
      },
    ];
    expect(getProcessingState({ items, busy: true })).toBe('waiting');
    items.push({
      kind: 'event',
      sourceIndex: 1,
      event: { type: 'thread_status', threadActiveFlags: [] },
    });
    expect(getProcessingState({ items, busy: true })).toBe('working');
    expect(getProcessingState({ items, busy: false })).toBe('ended');
  });

  it('hands the live indicator to a streaming answer without claiming an outcome', () => {
    const items: ChatTurnWorkItem[] = [
      { kind: 'event', sourceIndex: 0, event: { type: 'tool_call', toolName: 'read_file' } },
    ];
    expect(getProcessingState({ items, busy: true, answering: true })).toBe('answering');
    expect(getProcessingState({ items, busy: true, answering: true, waiting: true })).toBe(
      'waiting',
    );
    expect(getProcessingState({ items, busy: true, answering: true, outcome: 'completed' })).toBe(
      'completed',
    );
    const html = renderToStaticMarkup(
      createElement(TurnWorkMessage, { items, active: true, answering: true }),
    );
    expect(html).toContain('Work done');
    expect(html).toContain('data-processing-motion="paused"');
  });

  it('renders one collapsed card and an initial activity card without mounting hidden tool output', () => {
    const items: ChatTurnWorkItem[] = [
      {
        kind: 'event',
        sourceIndex: 1,
        event: { type: 'tool_call', toolName: 'Read schema', toolOutput: 'large output' },
      },
    ];
    const html = renderToStaticMarkup(createElement(TurnWorkMessage, { items, active: true }));
    expect(html.match(/class="processing-card"/g)).toHaveLength(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('large output');
    expect(
      renderToStaticMarkup(createElement(TurnWorkMessage, { items: [], active: true })),
    ).toContain('Preparing the next step');
  });

  it('restores measured turn bounds instead of starting a new timer on replay', () => {
    const entries = chatMessagesToEntries([
      { id: 'user', role: 'user', content: 'Test', timestamp: '2026-10-12T10:00:00.000Z' },
      {
        id: 'end',
        role: 'system',
        content: '',
        timestamp: '2026-10-12T10:00:07.000Z',
        event: { type: 'turn_outcome', turnOutcome: 'completed' },
      },
    ]);
    expect(composeChatTurns(entries)[0]).toMatchObject({
      startedAt: '2026-10-12T10:00:00.000Z',
      endedAt: '2026-10-12T10:00:07.000Z',
    });
  });

  it('settles a no-action turn in place when a late thread title refresh arrives', () => {
    const entries = chatMessagesToEntries([
      { id: 'user', role: 'user', content: 'Hi', timestamp: '2026-10-12T10:00:00.000Z' },
      {
        id: 'answer',
        role: 'assistant',
        content: 'Hi — what are we working on?',
        timestamp: '2026-10-12T10:00:03.000Z',
      },
      {
        id: 'end',
        role: 'system',
        content: '',
        timestamp: '2026-10-12T10:00:04.000Z',
        event: { type: 'turn_outcome', turnOutcome: 'completed' },
      },
    ]);
    entries.push({
      kind: 'event',
      event: { type: 'thread_metadata', threadTitle: 'Greeting' },
      timestamp: '2026-10-12T10:00:20.000Z',
    });
    const [turn] = composeChatTurns(entries);
    expect(turn).toMatchObject({ work: [], trailingWork: [], runOutcome: 'completed' });
    expect(turn.endedAt).toBe('2026-10-12T10:00:04.000Z');
    const html = renderToStaticMarkup(
      createElement(TurnWorkMessage, { items: [], outcome: turn.runOutcome }),
    );
    expect(html).toContain('Work completed');
    expect(html).toContain('Answered directly');
  });

  it('hides resolved approvals without hiding a request with the same id in another session', () => {
    const items: ChatTurnWorkItem[] = [
      {
        kind: 'event',
        sourceIndex: 0,
        event: {
          type: 'approval_request',
          sessionId: 'a',
          approvalRequestId: 1,
          approvalCommand: 'old-command',
        },
      },
      {
        kind: 'event',
        sourceIndex: 1,
        event: { type: 'request_resolved', sessionId: 'a', resolvedRequestId: 1 },
      },
      {
        kind: 'event',
        sourceIndex: 2,
        event: {
          type: 'approval_request',
          sessionId: 'b',
          approvalRequestId: 1,
          approvalCommand: 'current-command',
          approvalKind: 'command',
        },
      },
    ];
    const html = renderToStaticMarkup(createElement(TurnWorkMessage, { items, active: true }));
    expect(html).not.toContain('old-command');
    expect(html).toContain('current-command');
    expect(html).toContain('Approve command');
  });
});
