import { randomUUID } from 'node:crypto';
import type { ChatTurnSummary, CodexEvent, TurnEvidenceItem } from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface ChatEvidenceRow {
  id: string;
  role: string;
  content: string;
  event_json: string | null;
  timestamp: string;
}

interface PersistedEventRow {
  id: string;
  event_json: string;
}

const MAX_PERSISTED_COMMAND_OUTPUT_CHARS = 120_000;

interface ActiveTurn {
  id: string;
  threadId: string;
  userMessageId: string;
  userPrompt: string;
  startedAt: string;
  completedAt?: string;
  assistantMessageId?: string;
  assistantPreview?: string;
  changedFiles: Set<string>;
  commands: TurnEvidenceItem[];
  tests: TurnEvidenceItem[];
  errors: TurnEvidenceItem[];
  evidence: TurnEvidenceItem[];
}

export function saveChatEvent(
  threadId: string,
  repoId: string | null,
  sessionId: string | null,
  event: CodexEvent,
  timestamp: string,
): void {
  const db = getDb();
  const existingCommand = findCommandEventToUpdate(threadId, sessionId, event);
  if (existingCommand) {
    const existingEvent = parseEvent(existingCommand.event_json);
    if (existingEvent?.type === 'command_exec') {
      const output = event.command
        ? (event.output ?? existingEvent.output)
        : limitCommandOutput((existingEvent.output ?? '') + (event.output ?? ''));
      const mergedEvent: CodexEvent = {
        ...existingEvent,
        ...event,
        command: event.command || existingEvent.command,
        output,
      };
      db.prepare(
        `UPDATE chat_messages
         SET content = ?, event_json = ?, timestamp = ?
         WHERE id = ?`,
      ).run(describeEvent(mergedEvent), JSON.stringify(mergedEvent), timestamp, existingCommand.id);
      return;
    }
  }

  db.prepare(
    `INSERT INTO chat_messages
     (
       id,
       thread_id,
       repo_id,
       persona_id,
       session_id,
       kind,
       role,
       content,
       attachments_json,
       event_json,
       timestamp
     )
     VALUES (?, ?, ?, NULL, ?, 'event', 'system', ?, NULL, ?, ?)`,
  ).run(
    randomUUID(),
    threadId,
    repoId,
    sessionId,
    describeEvent(event),
    JSON.stringify(event),
    timestamp,
  );

  db.prepare(
    `UPDATE chat_threads
     SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
     WHERE id = ?`,
  ).run(timestamp, timestamp, threadId);
}

function findCommandEventToUpdate(
  threadId: string,
  sessionId: string | null,
  event: CodexEvent,
): PersistedEventRow | null {
  if (event.type !== 'command_exec') return null;

  const rows = getDb()
    .prepare(
      `SELECT id, event_json
       FROM chat_messages
       WHERE thread_id = ?
         AND session_id IS ?
         AND event_json IS NOT NULL
       ORDER BY rowid DESC
       LIMIT 20`,
    )
    .all(threadId, sessionId) as PersistedEventRow[];

  for (const row of rows) {
    const candidate = parseEvent(row.event_json);
    if (candidate?.type !== 'command_exec') continue;
    if (!event.command) return candidate.exitCode === undefined ? row : null;
    if (candidate.command === event.command && candidate.exitCode === undefined) return row;
    return null;
  }

  return null;
}

function limitCommandOutput(output: string): string {
  if (output.length <= MAX_PERSISTED_COMMAND_OUTPUT_CHARS) return output;
  return output.slice(-MAX_PERSISTED_COMMAND_OUTPUT_CHARS);
}

export function listChatTurnSummaries(threadId: string): ChatTurnSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, role, content, event_json, timestamp
       FROM chat_messages
       WHERE thread_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all(threadId) as ChatEvidenceRow[];

  const summaries: ChatTurnSummary[] = [];
  let active: ActiveTurn | null = null;

  const flush = () => {
    if (!active) return;
    summaries.push({
      id: active.id,
      threadId: active.threadId,
      userMessageId: active.userMessageId,
      userPrompt: active.userPrompt,
      startedAt: active.startedAt,
      completedAt: active.completedAt,
      assistantMessageId: active.assistantMessageId,
      assistantPreview: active.assistantPreview,
      changedFiles: [...active.changedFiles],
      commands: active.commands,
      tests: active.tests,
      errors: active.errors,
      evidence: active.evidence,
    });
    active = null;
  };

  for (const row of rows) {
    if (row.role === 'user') {
      flush();
      active = {
        id: row.id,
        threadId,
        userMessageId: row.id,
        userPrompt: row.content,
        startedAt: row.timestamp,
        changedFiles: new Set<string>(),
        commands: [],
        tests: [],
        errors: [],
        evidence: [],
      };
      continue;
    }

    if (!active) continue;

    if (row.role === 'assistant') {
      active.assistantMessageId = row.id;
      active.assistantPreview = row.content.replace(/\s+/g, ' ').trim().slice(0, 240);
      active.completedAt = row.timestamp;
      continue;
    }

    const event = parseEvent(row.event_json);
    if (!event) continue;
    const item = eventToEvidenceItem(row.id, event, row.timestamp);
    if (!item) continue;

    active.evidence.push(item);
    if (item.filePath && event.type === 'file_edit') active.changedFiles.add(item.filePath);
    if (item.type === 'command') active.commands.push(item);
    if (item.type === 'command' && isLikelyTestCommand(item.command ?? item.label)) {
      active.tests.push(item);
    }
    if (item.failed || item.type === 'error') active.errors.push(item);
  }

  flush();
  return summaries;
}

function parseEvent(value: string | null): CodexEvent | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CodexEvent>;
    return typeof parsed.type === 'string' ? (parsed as CodexEvent) : null;
  } catch {
    return null;
  }
}

function eventToEvidenceItem(
  id: string,
  event: CodexEvent,
  timestamp: string,
): TurnEvidenceItem | null {
  switch (event.type) {
    case 'file_edit':
      return {
        id,
        type: 'file_edit',
        label: event.filePath ? `Edited ${event.filePath}` : 'File edited',
        filePath: event.filePath,
        diff: event.diff,
        timestamp,
      };
    case 'file_read':
      return {
        id,
        type: 'file_read',
        label: event.filePath ? `Read ${event.filePath}` : 'File read',
        filePath: event.filePath,
        timestamp,
      };
    case 'command_exec':
      return {
        id,
        type: 'command',
        label: event.command?.trim() || 'Command output',
        detail: summariseOutput(event.output),
        command: event.command,
        exitCode: event.exitCode,
        failed: typeof event.exitCode === 'number' && event.exitCode !== 0,
        timestamp,
      };
    case 'approval_request':
      return {
        id,
        type: 'approval',
        label:
          event.approvalKind === 'command'
            ? `Approval requested: ${event.approvalCommand ?? 'command'}`
            : 'File-change approval requested',
        detail: event.approvalReason,
        command: event.approvalCommand,
        timestamp,
      };
    case 'tool_call':
      return {
        id,
        type: 'tool',
        label: event.toolName ? `Tool: ${event.toolName}` : 'Tool call',
        timestamp,
      };
    case 'error':
      return {
        id,
        type: 'error',
        label: event.errorMessage ?? 'Error',
        failed: true,
        timestamp,
      };
    case 'plan_update':
      return {
        id,
        type: 'plan',
        label: event.plan ? `Plan updated: ${event.plan.steps.length} steps` : 'Plan updated',
        timestamp,
      };
    case 'goal_update':
      return {
        id,
        type: 'goal',
        label: event.goal ? `Goal updated: ${event.goal.objective}` : 'Goal updated',
        timestamp,
      };
    case 'goal_cleared':
      return {
        id,
        type: 'goal',
        label: 'Goal cleared',
        timestamp,
      };
    default:
      return null;
  }
}

function describeEvent(event: CodexEvent): string {
  return eventToEvidenceItem('preview', event, new Date().toISOString())?.label ?? event.type;
}

function summariseOutput(output: string | undefined): string | undefined {
  const trimmed = output?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function isLikelyTestCommand(command: string): boolean {
  return /\b(test|vitest|jest|pytest|playwright|dotnet\s+test|npm\s+test|pnpm\s+test|yarn\s+test)\b/i.test(
    command,
  );
}
