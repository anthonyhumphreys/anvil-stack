import { randomUUID } from 'node:crypto';
import type {
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationEventType,
  AutomationLoopConfig,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunStatus,
  AutomationRunTrigger,
  AutomationRunWorktree,
  AutomationTriageItem,
  WatchtowerEvent,
  WatchtowerEventType,
  WatchtowerState,
  WatchtowerTarget,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface AutomationDefinitionRow {
  id: string;
  workspace_id: string;
  name: string;
  persona_id: string;
  prompt: string;
  repo_ids_json: string;
  trigger_mode: string;
  watch_event: string | null;
  watch_target_json: string | null;
  watch_state_json: string | null;
  schedule_cron: string;
  timezone: string;
  enabled: number;
  allow_repo_write: number;
  allow_command_run: number;
  loop_config_json: string | null;
  execution_mode: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  id: string;
  automation_id: string;
  workspace_id: string;
  trigger: string;
  trigger_context_json: string | null;
  status: string;
  assistant_message: string | null;
  error_message: string | null;
  changed_file_count: number;
  worktrees_json: string;
  started_at: string;
  completed_at: string | null;
}

interface AutomationRunEventRow {
  id: string;
  run_id: string;
  type: string;
  content: string;
  metadata_json: string | null;
  created_at: string;
}

interface WatchtowerEventRow {
  id: string;
  automation_id: string;
  event_type: string;
  source_id: string;
  payload_json: string;
  status: string;
  observed_at: string;
  dispatched_at: string | null;
  run_id: string | null;
}

export interface PendingWatchtowerEvent {
  id: string;
  automationId: string;
  event: WatchtowerEvent;
  observedAt: string;
}

const WATCHTOWER_EVENT_TYPES = new Set<WatchtowerEventType>([
  'workflow.completed',
  'workflow.failed',
  'pull_request.merged',
  'pull_request.closed',
  'pipeline.completed',
  'pipeline.failed',
]);

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as T)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseWatchtowerEvent(value: string | null | undefined): WatchtowerEvent | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as WatchtowerEvent;
    return parsed && typeof parsed === 'object' && typeof parsed.id === 'string'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseLoopConfig(value: string | null | undefined): AutomationLoopConfig | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<AutomationLoopConfig>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const memberPersonaIds = Array.isArray(parsed.memberPersonaIds)
      ? parsed.memberPersonaIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : [];
    return {
      enabled: parsed.enabled === true,
      mode: parsed.mode === 'dynamic' ? 'dynamic' : 'sequence',
      memberPersonaIds,
      separateThreads: parsed.separateThreads !== false,
      maxIterations:
        typeof parsed.maxIterations === 'number' && Number.isFinite(parsed.maxIterations)
          ? parsed.maxIterations
          : 1,
      stopCondition: typeof parsed.stopCondition === 'string' ? parsed.stopCondition : '',
    };
  } catch {
    return undefined;
  }
}

function serialiseLoopConfig(config: AutomationLoopConfig | undefined): string | null {
  if (!config?.enabled) return null;
  return JSON.stringify({
    enabled: true,
    mode: config.mode,
    memberPersonaIds: config.memberPersonaIds,
    separateThreads: config.separateThreads,
    maxIterations: config.maxIterations,
    stopCondition: config.stopCondition.trim(),
  });
}

function mapAutomationDefinition(row: AutomationDefinitionRow): AutomationDefinition {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    personaId: row.persona_id,
    prompt: row.prompt,
    repoIds: parseJsonArray<string>(row.repo_ids_json),
    triggerMode: row.trigger_mode === 'watchtower' ? 'watchtower' : 'schedule',
    watchEvent:
      row.watch_event && WATCHTOWER_EVENT_TYPES.has(row.watch_event as WatchtowerEventType)
        ? (row.watch_event as WatchtowerEventType)
        : undefined,
    watchTarget: parseJsonObject<WatchtowerTarget>(row.watch_target_json),
    watchState: parseJsonObject<WatchtowerState>(row.watch_state_json),
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    allowRepoWrite: row.allow_repo_write === 1,
    allowCommandRun: row.allow_command_run === 1,
    loopConfig: parseLoopConfig(row.loop_config_json),
    executionMode: row.execution_mode as AutomationDefinition['executionMode'],
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunStatus: (row.last_run_status as AutomationRunStatus | null) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAutomationRun(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    workspaceId: row.workspace_id,
    trigger: row.trigger as AutomationRunTrigger,
    triggerContext: parseWatchtowerEvent(row.trigger_context_json),
    status: row.status as AutomationRunStatus,
    assistantMessage: row.assistant_message ?? undefined,
    errorMessage: row.error_message ?? undefined,
    changedFileCount: row.changed_file_count,
    worktrees: parseJsonArray<AutomationRunWorktree>(row.worktrees_json),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapAutomationRunEvent(row: AutomationRunEventRow): AutomationRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type as AutomationEventType,
    content: row.content,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

export function listAutomations(workspaceId: string): AutomationDefinition[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT *
       FROM automation_definitions
       WHERE workspace_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(workspaceId) as AutomationDefinitionRow[];
  return rows.map(mapAutomationDefinition);
}

export function getAutomation(automationId: string): AutomationDefinition | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM automation_definitions WHERE id = ?').get(automationId) as
    | AutomationDefinitionRow
    | undefined;
  return row ? mapAutomationDefinition(row) : null;
}

export function createAutomationRecord(
  workspaceId: string,
  input: AutomationDefinitionInput,
  nextRunAt: string | null,
): AutomationDefinition {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO automation_definitions (
       id,
       workspace_id,
       name,
       persona_id,
       prompt,
       repo_ids_json,
       trigger_mode,
       watch_event,
       watch_target_json,
       schedule_cron,
       timezone,
       enabled,
       allow_repo_write,
       allow_command_run,
       loop_config_json,
       execution_mode,
       next_run_at,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'disposable-worktree', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.name.trim(),
    input.personaId,
    input.prompt.trim(),
    JSON.stringify(input.repoIds),
    input.triggerMode ?? 'schedule',
    input.watchEvent ?? null,
    input.watchTarget ? JSON.stringify(input.watchTarget) : null,
    input.scheduleCron.trim(),
    input.timezone.trim(),
    input.enabled ? 1 : 0,
    input.allowRepoWrite ? 1 : 0,
    input.allowCommandRun ? 1 : 0,
    serialiseLoopConfig(input.loopConfig),
    nextRunAt,
    now,
    now,
  );

  return getAutomation(id)!;
}

export function updateAutomationRecord(
  automationId: string,
  input: AutomationDefinitionInput,
  nextRunAt: string | null,
): AutomationDefinition | null {
  const db = getDb();
  db.prepare(
    `UPDATE automation_definitions
     SET
       name = ?,
       persona_id = ?,
       prompt = ?,
       repo_ids_json = ?,
       trigger_mode = ?,
       watch_event = ?,
       watch_target_json = ?,
       watch_state_json = NULL,
       schedule_cron = ?,
       timezone = ?,
       enabled = ?,
       allow_repo_write = ?,
       allow_command_run = ?,
       loop_config_json = ?,
       next_run_at = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name.trim(),
    input.personaId,
    input.prompt.trim(),
    JSON.stringify(input.repoIds),
    input.triggerMode ?? 'schedule',
    input.watchEvent ?? null,
    input.watchTarget ? JSON.stringify(input.watchTarget) : null,
    input.scheduleCron.trim(),
    input.timezone.trim(),
    input.enabled ? 1 : 0,
    input.allowRepoWrite ? 1 : 0,
    input.allowCommandRun ? 1 : 0,
    serialiseLoopConfig(input.loopConfig),
    nextRunAt,
    new Date().toISOString(),
    automationId,
  );

  return getAutomation(automationId);
}

export function deleteAutomationRecord(automationId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM automation_definitions WHERE id = ?').run(automationId);
}

export function countEnabledAutomations(): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM automation_definitions
       WHERE enabled = 1
         AND (trigger_mode = 'schedule' OR watch_target_json IS NOT NULL)`,
    )
    .get() as { count: number };
  return Number(row.count ?? 0);
}

export function createAutomationRun(
  automation: AutomationDefinition,
  trigger: AutomationRunTrigger,
  triggerContext?: WatchtowerEvent,
): AutomationRun {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    const running = db
      .prepare(
        `SELECT id
         FROM automation_runs
         WHERE automation_id = ? AND status IN ('queued', 'running')
         LIMIT 1`,
      )
      .get(automation.id) as { id: string } | undefined;
    if (running) {
      throw new Error('This automation already has an active run.');
    }

    db.prepare(
      `INSERT INTO automation_runs (
         id,
         automation_id,
         workspace_id,
         trigger,
         trigger_context_json,
         status,
         worktrees_json,
         started_at
       ) VALUES (?, ?, ?, ?, ?, 'running', '[]', ?)`,
    ).run(
      id,
      automation.id,
      automation.workspaceId,
      trigger,
      triggerContext ? JSON.stringify(triggerContext) : null,
      now,
    );

    db.prepare(
      `UPDATE automation_definitions
       SET last_run_at = ?, last_run_status = 'running', updated_at = ?
       WHERE id = ?`,
    ).run(now, now, automation.id);
  });
  txn();

  return getAutomationRun(id)!;
}

export function listAutomationRuns(automationId: string): AutomationRun[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT *
       FROM automation_runs
       WHERE automation_id = ?
       ORDER BY started_at DESC`,
    )
    .all(automationId) as AutomationRunRow[];
  return rows.map(mapAutomationRun);
}

export function listAutomationTriageItems(workspaceId: string): AutomationTriageItem[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         r.*,
         d.name AS automation_name
       FROM automation_runs r
       JOIN automation_definitions d ON d.id = r.automation_id
       WHERE r.workspace_id = ?
         AND (
           r.status IN ('queued', 'running', 'failed')
           OR r.changed_file_count > 0
           OR r.worktrees_json <> '[]'
         )
       ORDER BY r.started_at DESC
       LIMIT 40`,
    )
    .all(workspaceId) as Array<AutomationRunRow & { automation_name: string }>;

  return rows
    .map((row) => {
      const run = mapAutomationRun(row);
      const retainedWorktreeCount = run.worktrees.filter(
        (worktree) => worktree.kept && worktree.path,
      ).length;
      const attention: AutomationTriageItem['attention'] =
        run.status === 'failed'
          ? 'blocked'
          : run.status === 'running' || run.status === 'queued'
            ? 'running'
            : 'changes';

      return {
        id: run.id,
        automationId: run.automationId,
        automationName: row.automation_name,
        status: run.status,
        trigger: run.trigger,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        changedFileCount: run.changedFileCount,
        summary: run.assistantMessage,
        errorMessage: run.errorMessage,
        retainedWorktreeCount,
        worktrees: run.worktrees,
        attention,
      };
    })
    .filter(
      (item) =>
        item.attention !== 'changes' || item.changedFileCount > 0 || item.retainedWorktreeCount > 0,
    );
}

export function getAutomationRun(runId: string): AutomationRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId) as
    | AutomationRunRow
    | undefined;
  return row ? mapAutomationRun(row) : null;
}

export function updateAutomationRunWorktrees(
  runId: string,
  worktrees: AutomationRunWorktree[],
): AutomationRun | null {
  const db = getDb();
  db.prepare('UPDATE automation_runs SET worktrees_json = ? WHERE id = ?').run(
    JSON.stringify(worktrees),
    runId,
  );
  return getAutomationRun(runId);
}

export function completeAutomationRun(
  runId: string,
  opts: {
    status: Extract<AutomationRunStatus, 'completed' | 'failed' | 'cancelled'>;
    assistantMessage?: string;
    errorMessage?: string;
    changedFileCount: number;
    worktrees: AutomationRunWorktree[];
  },
): AutomationRun | null {
  const db = getDb();
  const run = getAutomationRun(runId);
  if (!run) return null;

  const completedAt = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE automation_runs
       SET
         status = ?,
         assistant_message = ?,
         error_message = ?,
         changed_file_count = ?,
         worktrees_json = ?,
         completed_at = ?
       WHERE id = ?`,
    ).run(
      opts.status,
      opts.assistantMessage ?? null,
      opts.errorMessage ?? null,
      opts.changedFileCount,
      JSON.stringify(opts.worktrees),
      completedAt,
      runId,
    );

    db.prepare(
      `UPDATE automation_definitions
       SET
         last_run_status = ?,
         last_run_at = COALESCE(last_run_at, ?),
         updated_at = ?
       WHERE id = ?`,
    ).run(opts.status, run.startedAt, completedAt, run.automationId);
  });
  txn();

  return getAutomationRun(runId);
}

export function updateAutomationScheduleState(
  automationId: string,
  opts: {
    lastRunAt?: string | null;
    nextRunAt?: string | null;
    lastRunStatus?: AutomationRunStatus | null;
  },
): AutomationDefinition | null {
  const db = getDb();
  const assignments = ['updated_at = ?'];
  const values: Array<string | null> = [new Date().toISOString()];

  if ('lastRunAt' in opts) {
    assignments.push('last_run_at = ?');
    values.push(opts.lastRunAt ?? null);
  }
  if ('nextRunAt' in opts) {
    assignments.push('next_run_at = ?');
    values.push(opts.nextRunAt ?? null);
  }
  if ('lastRunStatus' in opts) {
    assignments.push('last_run_status = ?');
    values.push(opts.lastRunStatus ?? null);
  }

  db.prepare(`UPDATE automation_definitions SET ${assignments.join(', ')} WHERE id = ?`).run(
    ...values,
    automationId,
  );
  return getAutomation(automationId);
}

export function listDueAutomations(referenceTime: string): AutomationDefinition[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT *
       FROM automation_definitions
       WHERE enabled = 1
         AND trigger_mode = 'schedule'
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(referenceTime) as AutomationDefinitionRow[];
  return rows.map(mapAutomationDefinition);
}

export function listWatchtowerAutomations(
  workspaceId: string,
  eventType: WatchtowerEventType,
): AutomationDefinition[] {
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM automation_definitions
       WHERE workspace_id = ?
         AND enabled = 1
         AND trigger_mode = 'watchtower'
         AND watch_event = ?
       ORDER BY updated_at DESC`,
    )
    .all(workspaceId, eventType) as AutomationDefinitionRow[];
  return rows.map(mapAutomationDefinition);
}

export function listExternalWatchtowerAutomations(): AutomationDefinition[] {
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM automation_definitions
       WHERE enabled = 1
         AND trigger_mode = 'watchtower'
         AND watch_target_json IS NOT NULL
       ORDER BY updated_at ASC`,
    )
    .all() as AutomationDefinitionRow[];
  return rows.map(mapAutomationDefinition);
}

export function updateWatchtowerState(
  automationId: string,
  state: WatchtowerState,
): AutomationDefinition | null {
  getDb()
    .prepare(
      `UPDATE automation_definitions
       SET watch_state_json = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(state), new Date().toISOString(), automationId);
  return getAutomation(automationId);
}

export function enqueueWatchtowerEvent(
  automationId: string,
  event: WatchtowerEvent,
): PendingWatchtowerEvent {
  const observedAt = new Date().toISOString();
  const id = `${automationId}:${event.type}:${event.sourceId}`;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO watchtower_events (
         id,
         automation_id,
         event_type,
         source_id,
         payload_json,
         status,
         observed_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, automationId, event.type, event.sourceId, JSON.stringify(event), observedAt);

  return { id, automationId, event, observedAt };
}

export function listPendingWatchtowerEvents(): PendingWatchtowerEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM watchtower_events
       WHERE status = 'pending'
       ORDER BY observed_at ASC`,
    )
    .all() as WatchtowerEventRow[];

  return rows.flatMap((row) => {
    const event = parseWatchtowerEvent(row.payload_json);
    return event
      ? [{ id: row.id, automationId: row.automation_id, event, observedAt: row.observed_at }]
      : [];
  });
}

export function claimPendingWatchtowerEvent(eventId: string): AutomationRun | null {
  const db = getDb();
  let runId: string | null = null;
  const txn = db.transaction(() => {
    const eventRow = db
      .prepare("SELECT * FROM watchtower_events WHERE id = ? AND status = 'pending'")
      .get(eventId) as WatchtowerEventRow | undefined;
    if (!eventRow) return;

    const automationRow = db
      .prepare('SELECT * FROM automation_definitions WHERE id = ?')
      .get(eventRow.automation_id) as AutomationDefinitionRow | undefined;
    if (!automationRow || automationRow.enabled !== 1) {
      db.prepare(
        "UPDATE watchtower_events SET status = 'ignored', dispatched_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), eventId);
      return;
    }

    const running = db
      .prepare(
        `SELECT id
         FROM automation_runs
         WHERE automation_id = ? AND status IN ('queued', 'running')
         LIMIT 1`,
      )
      .get(eventRow.automation_id) as { id: string } | undefined;
    if (running) return;

    const event = parseWatchtowerEvent(eventRow.payload_json);
    if (!event) {
      db.prepare(
        "UPDATE watchtower_events SET status = 'ignored', dispatched_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), eventId);
      return;
    }

    const now = new Date().toISOString();
    runId = randomUUID();
    db.prepare(
      `INSERT INTO automation_runs (
         id,
         automation_id,
         workspace_id,
         trigger,
         trigger_context_json,
         status,
         worktrees_json,
         started_at
       ) VALUES (?, ?, ?, 'watchtower', ?, 'running', '[]', ?)`,
    ).run(runId, automationRow.id, automationRow.workspace_id, JSON.stringify(event), now);

    db.prepare(
      `UPDATE automation_definitions
       SET last_run_at = ?, last_run_status = 'running', updated_at = ?
       WHERE id = ?`,
    ).run(now, now, automationRow.id);

    db.prepare(
      `UPDATE watchtower_events
       SET status = 'dispatched', dispatched_at = ?, run_id = ?
       WHERE id = ?`,
    ).run(now, runId, eventId);
  });
  txn();
  return runId ? getAutomationRun(runId) : null;
}

export function listAutomationRunEvents(runId: string): AutomationRunEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT *
       FROM automation_run_events
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId) as AutomationRunEventRow[];
  return rows.map(mapAutomationRunEvent);
}

export function appendAutomationRunEvent(
  runId: string,
  type: AutomationEventType,
  content: string,
  metadata?: Record<string, unknown>,
): AutomationRunEvent {
  const db = getDb();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  if (type === 'text' || type === 'thinking' || type === 'system') {
    const previous = db
      .prepare(
        `SELECT *
         FROM automation_run_events
         WHERE run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(runId) as AutomationRunEventRow | undefined;

    if (previous && previous.type === type && (previous.metadata_json ?? null) === metadataJson) {
      const mergedContent = `${previous.content}${content}`;
      db.prepare('UPDATE automation_run_events SET content = ? WHERE id = ?').run(
        mergedContent,
        previous.id,
      );
      return {
        id: previous.id,
        runId,
        type,
        content: mergedContent,
        metadata,
        createdAt: previous.created_at,
      };
    }
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO automation_run_events (id, run_id, type, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, runId, type, content, metadataJson, createdAt);

  return {
    id,
    runId,
    type,
    content,
    metadata,
    createdAt,
  };
}

export function markStaleAutomationRunsFailed(message: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const staleRuns = db
    .prepare(
      `SELECT id, automation_id
       FROM automation_runs
       WHERE status IN ('queued', 'running')`,
    )
    .all() as Array<{ id: string; automation_id: string }>;

  const txn = db.transaction(() => {
    for (const run of staleRuns) {
      db.prepare(
        `UPDATE automation_runs
         SET status = 'failed', error_message = ?, completed_at = ?
         WHERE id = ?`,
      ).run(message, now, run.id);
      db.prepare(
        `UPDATE automation_definitions
         SET last_run_status = 'failed', updated_at = ?
         WHERE id = ?`,
      ).run(now, run.automation_id);
    }
  });

  txn();
}
