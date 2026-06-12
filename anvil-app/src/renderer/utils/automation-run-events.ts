import type { AutomationRunEvent, CodexEvent } from '../../shared/types';

type CodexEventStatus = NonNullable<CodexEvent['status']>;

export type AutomationDisplayEntry =
  | { kind: 'assistant'; content: string; createdAt: string }
  | { kind: 'thinking'; content: string; createdAt: string }
  | { kind: 'system'; content: string; createdAt: string }
  | { kind: 'activity'; events: CodexEvent[]; createdAt: string }
  | { kind: 'event'; event: CodexEvent; createdAt: string };

const ACTIVITY_EVENT_TYPES = new Set(['tool_call', 'command_exec', 'file_edit']);

export function buildAutomationDisplayEntries(
  events: AutomationRunEvent[],
): AutomationDisplayEntry[] {
  const entries: AutomationDisplayEntry[] = [];

  for (const event of events) {
    const createdAt = event.createdAt;
    if (event.type === 'text') {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'assistant') {
        previous.content += event.content;
      } else {
        entries.push({ kind: 'assistant', content: event.content, createdAt });
      }
      continue;
    }

    if (event.type === 'thinking') {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'thinking') {
        previous.content += event.content;
      } else {
        entries.push({ kind: 'thinking', content: event.content, createdAt });
      }
      continue;
    }

    if (event.type === 'system') {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'system') {
        previous.content += event.content;
      } else {
        entries.push({ kind: 'system', content: event.content, createdAt });
      }
      continue;
    }

    const codexEvent = toCodexEvent(event);
    if (!codexEvent) continue;

    if (ACTIVITY_EVENT_TYPES.has(codexEvent.type)) {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'activity') {
        previous.events.push(codexEvent);
      } else {
        entries.push({ kind: 'activity', events: [codexEvent], createdAt });
      }
      continue;
    }

    entries.push({ kind: 'event', event: codexEvent, createdAt });
  }

  return entries;
}

function toCodexEvent(event: AutomationRunEvent): CodexEvent | null {
  switch (event.type) {
    case 'status':
      return { type: 'status', status: readCodexEventStatus(event.content) };
    case 'error':
      return { type: 'error', errorMessage: event.content };
    case 'file_edit':
      return {
        type: 'file_edit',
        diff: event.content,
        filePath: readStringMetadata(event.metadata?.['filePath']),
      };
    case 'command_exec':
      return {
        type: 'command_exec',
        command: readStringMetadata(event.metadata?.['command']),
        output: event.content,
        exitCode: readNumberMetadata(event.metadata?.['exitCode']),
      };
    case 'tool_call':
      return {
        type: 'tool_call',
        toolName: event.content,
        toolInput: readRecordMetadata(event.metadata?.['toolInput']),
      };
    default:
      return null;
  }
}

function readCodexEventStatus(value: string): CodexEventStatus | undefined {
  if (value === 'thinking' || value === 'executing' || value === 'complete' || value === 'error') {
    return value;
  }

  return undefined;
}

function readStringMetadata(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumberMetadata(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readRecordMetadata(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}
