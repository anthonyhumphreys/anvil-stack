import { describe, expect, it } from 'vitest';
import type { AutomationRunEvent } from '../../../shared/types';
import { buildAutomationDisplayEntries } from '../automation-run-events';

function event(overrides: Partial<AutomationRunEvent>): AutomationRunEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    runId: overrides.runId ?? 'run-1',
    type: overrides.type ?? 'text',
    content: overrides.content ?? '',
    metadata: overrides.metadata,
    createdAt: overrides.createdAt ?? '2026-04-29T10:00:00.000Z',
  };
}

describe('buildAutomationDisplayEntries', () => {
  it('merges adjacent text, thinking, and system events and groups activity events', () => {
    const entries = buildAutomationDisplayEntries([
      event({ type: 'text', content: 'Hello' }),
      event({ type: 'text', content: ' world' }),
      event({ type: 'thinking', content: 'Plan' }),
      event({ type: 'thinking', content: ' more' }),
      event({ type: 'tool_call', content: 'search', metadata: { toolInput: { q: 'test' } } }),
      event({
        type: 'command_exec',
        content: 'ok',
        metadata: { command: 'npm test', exitCode: 0 },
      }),
      event({ type: 'system', content: 'Retained' }),
      event({ type: 'system', content: ' worktree' }),
      event({ type: 'status', content: 'complete' }),
      event({ type: 'status', content: 'unexpected' }),
      event({ type: 'error', content: 'boom' }),
    ]);

    expect(entries).toHaveLength(7);
    expect(entries[0]).toEqual(
      expect.objectContaining({ kind: 'assistant', content: 'Hello world' }),
    );
    expect(entries[1]).toEqual(expect.objectContaining({ kind: 'thinking', content: 'Plan more' }));
    expect(entries[2]).toMatchObject({
      kind: 'activity',
      events: [
        expect.objectContaining({ type: 'tool_call', toolName: 'search' }),
        expect.objectContaining({ type: 'command_exec', command: 'npm test', output: 'ok' }),
      ],
    });
    expect(entries[3]).toEqual(
      expect.objectContaining({ kind: 'system', content: 'Retained worktree' }),
    );
    expect(entries[4]).toEqual(
      expect.objectContaining({
        kind: 'event',
        event: expect.objectContaining({ type: 'status', status: 'complete' }),
      }),
    );
    expect(entries[5]).toEqual(
      expect.objectContaining({
        kind: 'event',
        event: expect.objectContaining({ type: 'status', status: undefined }),
      }),
    );
    expect(entries[6]).toEqual(
      expect.objectContaining({
        kind: 'event',
        event: expect.objectContaining({ type: 'error', errorMessage: 'boom' }),
      }),
    );
  });
});
