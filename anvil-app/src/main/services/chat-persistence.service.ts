import { randomUUID } from 'node:crypto';
import type {
  ChatAttachment,
  ChatGoalSnapshot,
  ChatMessage,
  ChatPlanSnapshot,
  ChatThread,
  WorkItemProvider,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface CreateChatThreadInput {
  workspaceId?: string | null;
  personaId: string;
  title?: string;
  workItemId?: string;
  workItemProvider?: WorkItemProvider;
  workItemTitle?: string;
  repoIds?: string[];
  activeRepoId?: string | null;
}

interface UpdateChatThreadInput {
  title?: string;
  personaId?: string;
  workItemTitle?: string;
  repoIds?: string[];
  activeRepoId?: string | null;
}

interface EnsureWorkItemThreadInput {
  workspaceId?: string | null;
  personaId: string;
  workItemId: string;
  workItemProvider: WorkItemProvider;
  workItemTitle: string;
  repoIds?: string[];
  activeRepoId?: string | null;
}

interface ChatThreadRow {
  id: string;
  workspace_id: string | null;
  persona_id: string;
  title: string;
  work_item_id: string | null;
  work_item_provider: string | null;
  work_item_title: string | null;
  repo_ids_json: string;
  active_repo_id: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  preview: string | null;
  message_count: number;
  provider_thread_id: string | null;
  active_plan_json: string | null;
  active_plan_updated_at: string | null;
  active_goal_json: string | null;
}

function defaultThreadTitle(personaId: string): string {
  return `New ${personaId} thread`;
}

function parseRepoIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function serialiseRepoIds(repoIds: string[] | undefined): string {
  return JSON.stringify(repoIds ?? []);
}

function parseAttachments(value: string | null | undefined): ChatAttachment[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;

    const attachments = parsed.filter((entry): entry is ChatAttachment => {
      if (!entry || typeof entry !== 'object') return false;
      const candidate = entry as Partial<ChatAttachment>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.mimeType === 'string' &&
        typeof candidate.size === 'number' &&
        (candidate.kind === 'image' || candidate.kind === 'file') &&
        typeof candidate.path === 'string' &&
        typeof candidate.createdAt === 'string'
      );
    });

    return attachments.length > 0 ? attachments : undefined;
  } catch {
    return undefined;
  }
}

function serialiseAttachments(attachments: ChatAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  return JSON.stringify(attachments);
}

export function findChatAttachment(attachmentId: string): ChatAttachment | null {
  const id = attachmentId.trim();
  if (!id) return null;

  const rows = getDb()
    .prepare(
      `SELECT attachments_json
       FROM chat_messages
       WHERE attachments_json IS NOT NULL`,
    )
    .all() as Array<{ attachments_json: string | null }>;

  for (const row of rows) {
    const attachment = parseAttachments(row.attachments_json)?.find(
      (candidate) => candidate.id === id,
    );
    if (attachment) return attachment;
  }

  return null;
}

function parsePlanSnapshot(value: string | null | undefined): ChatPlanSnapshot | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ChatPlanSnapshot>;
    if (!Array.isArray(parsed.steps) || typeof parsed.updatedAt !== 'string') return undefined;

    return {
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : undefined,
      updatedAt: parsed.updatedAt,
      steps: parsed.steps
        .filter((step): step is ChatPlanSnapshot['steps'][number] => {
          return (
            !!step &&
            typeof step === 'object' &&
            typeof step.step === 'string' &&
            (step.status === 'pending' ||
              step.status === 'in_progress' ||
              step.status === 'completed')
          );
        })
        .map((step) => ({ step: step.step, status: step.status })),
    };
  } catch {
    return undefined;
  }
}

function parseGoalSnapshot(value: string | null | undefined): ChatGoalSnapshot | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ChatGoalSnapshot>;
    if (typeof parsed.objective !== 'string' || !parsed.objective.trim()) return undefined;
    if (
      parsed.status !== 'active' &&
      parsed.status !== 'paused' &&
      parsed.status !== 'budgetLimited' &&
      parsed.status !== 'complete'
    ) {
      return undefined;
    }

    return {
      objective: parsed.objective,
      status: parsed.status,
      tokenBudget: typeof parsed.tokenBudget === 'number' ? parsed.tokenBudget : null,
      tokensUsed: typeof parsed.tokensUsed === 'number' ? parsed.tokensUsed : 0,
      timeUsedSeconds: typeof parsed.timeUsedSeconds === 'number' ? parsed.timeUsedSeconds : 0,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return undefined;
  }
}

function mapThreadRow(row: ChatThreadRow): ChatThread {
  return {
    id: row.id,
    workspaceId: row.workspace_id ?? undefined,
    personaId: row.persona_id,
    title: row.title,
    workItemId: row.work_item_id ?? undefined,
    workItemProvider: parseWorkItemProvider(row.work_item_provider),
    workItemTitle: row.work_item_title ?? undefined,
    repoIds: parseRepoIds(row.repo_ids_json),
    activeRepoId: row.active_repo_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at ?? undefined,
    preview: row.preview?.trim() ? row.preview : undefined,
    messageCount: Number(row.message_count ?? 0),
    providerThreadId: row.provider_thread_id ?? undefined,
    activePlan: parsePlanSnapshot(row.active_plan_json),
    activeGoal: parseGoalSnapshot(row.active_goal_json),
  };
}

function parseWorkItemProvider(value: string | null | undefined): WorkItemProvider | undefined {
  return value === 'ado' || value === 'linear' || value === 'jira' ? value : undefined;
}

export function listChatThreads(workspaceId: string | null, personaId: string): ChatThread[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         t.id,
         t.workspace_id,
         t.persona_id,
         t.title,
         t.work_item_id,
         t.work_item_provider,
         t.work_item_title,
         t.repo_ids_json,
         t.active_repo_id,
         t.created_at,
         t.updated_at,
         t.last_message_at,
         t.provider_thread_id,
         t.active_plan_json,
         t.active_plan_updated_at,
         t.active_goal_json,
         (
           SELECT m2.content
           FROM chat_messages m2
           WHERE m2.thread_id = t.id AND m2.role IN ('user', 'assistant')
           ORDER BY m2.timestamp DESC
           LIMIT 1
         ) AS preview,
         SUM(CASE WHEN m.role IN ('user', 'assistant') THEN 1 ELSE 0 END) AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE
         (
           (? IS NULL AND t.workspace_id IS NULL)
           OR t.workspace_id = ?
         )
         AND t.persona_id = ?
         AND t.work_item_id IS NULL
       GROUP BY t.id
       ORDER BY
         COALESCE(t.last_message_at, t.updated_at, t.created_at) DESC,
         t.created_at DESC,
         t.id DESC`,
    )
    .all(workspaceId, workspaceId, personaId) as ChatThreadRow[];

  return rows.map(mapThreadRow);
}

export function listWorkItemChatThreads(workspaceId: string | null): ChatThread[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         t.id,
         t.workspace_id,
         t.persona_id,
         t.title,
         t.work_item_id,
         t.work_item_provider,
         t.work_item_title,
         t.repo_ids_json,
         t.active_repo_id,
         t.created_at,
         t.updated_at,
         t.last_message_at,
         t.provider_thread_id,
         t.active_plan_json,
         t.active_plan_updated_at,
         t.active_goal_json,
         (
           SELECT m2.content
           FROM chat_messages m2
           WHERE m2.thread_id = t.id AND m2.role IN ('user', 'assistant')
           ORDER BY m2.timestamp DESC
           LIMIT 1
         ) AS preview,
         SUM(CASE WHEN m.role IN ('user', 'assistant') THEN 1 ELSE 0 END) AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE
         (
           (? IS NULL AND t.workspace_id IS NULL)
           OR t.workspace_id = ?
         )
         AND t.work_item_id IS NOT NULL
       GROUP BY t.id
       ORDER BY
         COALESCE(t.last_message_at, t.updated_at, t.created_at) DESC,
         t.created_at DESC,
         t.id DESC`,
    )
    .all(workspaceId, workspaceId) as ChatThreadRow[];

  return rows.map(mapThreadRow);
}

export function getChatThread(threadId: string): ChatThread | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         t.id,
         t.workspace_id,
         t.persona_id,
         t.title,
         t.work_item_id,
         t.work_item_provider,
         t.work_item_title,
         t.repo_ids_json,
         t.active_repo_id,
         t.created_at,
         t.updated_at,
         t.last_message_at,
         t.provider_thread_id,
         t.active_plan_json,
         t.active_plan_updated_at,
         t.active_goal_json,
         (
           SELECT m2.content
           FROM chat_messages m2
           WHERE m2.thread_id = t.id AND m2.role IN ('user', 'assistant')
           ORDER BY m2.timestamp DESC
           LIMIT 1
         ) AS preview,
         SUM(CASE WHEN m.role IN ('user', 'assistant') THEN 1 ELSE 0 END) AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE t.id = ?
       GROUP BY t.id`,
    )
    .get(threadId) as ChatThreadRow | undefined;

  return row ? mapThreadRow(row) : null;
}

export function findWorkItemChatThread(
  workspaceId: string | null,
  workItemProvider: WorkItemProvider,
  workItemId: string,
): ChatThread | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         t.id,
         t.workspace_id,
         t.persona_id,
         t.title,
         t.work_item_id,
         t.work_item_provider,
         t.work_item_title,
         t.repo_ids_json,
         t.active_repo_id,
         t.created_at,
         t.updated_at,
         t.last_message_at,
         t.provider_thread_id,
         t.active_plan_json,
         t.active_plan_updated_at,
         t.active_goal_json,
         (
           SELECT m2.content
           FROM chat_messages m2
           WHERE m2.thread_id = t.id AND m2.role IN ('user', 'assistant')
           ORDER BY m2.timestamp DESC
           LIMIT 1
         ) AS preview,
         SUM(CASE WHEN m.role IN ('user', 'assistant') THEN 1 ELSE 0 END) AS message_count
       FROM chat_threads t
       LEFT JOIN chat_messages m ON m.thread_id = t.id
       WHERE
         (
           (? IS NULL AND t.workspace_id IS NULL)
           OR t.workspace_id = ?
         )
         AND t.work_item_provider = ?
         AND t.work_item_id = ?
       GROUP BY t.id`,
    )
    .get(workspaceId, workspaceId, workItemProvider, workItemId) as ChatThreadRow | undefined;

  return row ? mapThreadRow(row) : null;
}

export function createChatThread(input: CreateChatThreadInput, threadId?: string): ChatThread {
  const db = getDb();
  const id = threadId ?? randomUUID();
  const title = input.title?.trim() || defaultThreadTitle(input.personaId);
  const repoIds = input.repoIds ?? [];
  const activeRepoId = input.activeRepoId ?? repoIds[0] ?? null;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO chat_threads (
       id,
       workspace_id,
       persona_id,
       title,
       work_item_id,
       work_item_provider,
       work_item_title,
       repo_ids_json,
       active_repo_id,
       created_at,
       updated_at,
       last_message_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.workspaceId ?? null,
    input.personaId,
    title,
    input.workItemId ?? null,
    input.workItemProvider ?? null,
    input.workItemTitle ?? null,
    serialiseRepoIds(repoIds),
    activeRepoId,
    now,
    now,
  );

  return getChatThread(id)!;
}

export function ensureWorkItemChatThread(input: EnsureWorkItemThreadInput): ChatThread {
  const existing = findWorkItemChatThread(
    input.workspaceId ?? null,
    input.workItemProvider,
    input.workItemId,
  );

  if (existing) {
    return (
      updateChatThread(existing.id, {
        title: buildWorkItemThreadTitle(input.workItemId, input.workItemTitle),
        workItemTitle: input.workItemTitle,
        repoIds: input.repoIds,
        activeRepoId: input.activeRepoId,
      }) ?? existing
    );
  }

  return createChatThread({
    workspaceId: input.workspaceId ?? null,
    personaId: input.personaId,
    title: buildWorkItemThreadTitle(input.workItemId, input.workItemTitle),
    workItemId: input.workItemId,
    workItemProvider: input.workItemProvider,
    workItemTitle: input.workItemTitle,
    repoIds: input.repoIds,
    activeRepoId: input.activeRepoId,
  });
}

export function updateChatThread(
  threadId: string,
  updates: UpdateChatThreadInput,
): ChatThread | null {
  const db = getDb();
  const assignments = ['updated_at = ?'];
  const values: Array<string | null> = [new Date().toISOString()];

  if (typeof updates.title === 'string') {
    assignments.push('title = ?');
    values.push(updates.title.trim() || 'Untitled thread');
  }

  if (typeof updates.personaId === 'string') {
    assignments.push('persona_id = ?');
    values.push(updates.personaId.trim() || 'coder');
  }

  if (typeof updates.workItemTitle === 'string') {
    assignments.push('work_item_title = ?');
    values.push(updates.workItemTitle.trim() || null);
  }

  if (updates.repoIds) {
    assignments.push('repo_ids_json = ?');
    values.push(serialiseRepoIds(updates.repoIds));
  }

  if ('activeRepoId' in updates) {
    assignments.push('active_repo_id = ?');
    values.push(updates.activeRepoId ?? null);
  }

  db.prepare(`UPDATE chat_threads SET ${assignments.join(', ')} WHERE id = ?`).run(
    ...values,
    threadId,
  );

  return getChatThread(threadId);
}

function buildWorkItemThreadTitle(workItemId: string, title: string): string {
  const trimmedTitle = title.trim();
  return trimmedTitle ? `${workItemId}: ${trimmedTitle}` : workItemId;
}

export function deleteChatThread(threadId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM chat_sessions WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId);
  });
  tx();
}

export function saveChatThreadPlan(threadId: string, plan: ChatPlanSnapshot): ChatThread | null {
  const db = getDb();
  const updatedAt = plan.updatedAt || new Date().toISOString();
  db.prepare(
    `UPDATE chat_threads
     SET active_plan_json = ?, active_plan_updated_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify({ ...plan, updatedAt }), updatedAt, updatedAt, threadId);

  return getChatThread(threadId);
}

export function saveChatThreadGoal(
  threadId: string,
  goal: ChatGoalSnapshot | null,
): ChatThread | null {
  const db = getDb();
  const updatedAt = new Date().toISOString();
  db.prepare(
    `UPDATE chat_threads
     SET active_goal_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(goal ? JSON.stringify(goal) : null, updatedAt, threadId);

  return getChatThread(threadId);
}

export function createChatSession(
  threadId: string | null,
  repoId: string | null,
  personaId: string,
  sessionId?: string,
  providerThreadId?: string | null,
): string {
  const db = getDb();
  const id = sessionId ?? randomUUID();
  db.prepare(
    `INSERT INTO chat_sessions
     (id, thread_id, repo_id, persona_id, provider_thread_id, started_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, threadId, repoId, personaId, providerThreadId ?? null);

  if (threadId && providerThreadId) {
    setChatThreadProviderThreadId(threadId, providerThreadId);
  }

  return id;
}

export function getChatThreadProviderThreadId(threadId: string | null | undefined): string | null {
  if (!threadId) return null;
  const row = getDb()
    .prepare('SELECT provider_thread_id FROM chat_threads WHERE id = ?')
    .get(threadId) as { provider_thread_id: string | null } | undefined;
  return row?.provider_thread_id ?? null;
}

export function setChatThreadProviderThreadId(threadId: string, providerThreadId: string): void {
  getDb()
    .prepare(
      `UPDATE chat_threads
       SET provider_thread_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(providerThreadId, new Date().toISOString(), threadId);
}

export function setChatSessionProviderTurnId(
  sessionId: string,
  providerTurnId: string | null,
): void {
  getDb()
    .prepare('UPDATE chat_sessions SET provider_turn_id = ? WHERE id = ?')
    .run(providerTurnId, sessionId);
}

export function endChatSession(sessionId: string): void {
  const db = getDb();
  db.prepare(`UPDATE chat_sessions SET ended_at = datetime('now') WHERE id = ?`).run(sessionId);
}

export function saveChatEntry(
  threadId: string,
  repoId: string | null,
  sessionId: string | null,
  entry: ChatMessage,
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO chat_messages
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       thread_id = excluded.thread_id,
       repo_id = excluded.repo_id,
       persona_id = excluded.persona_id,
       session_id = excluded.session_id,
       kind = excluded.kind,
       role = excluded.role,
       content = excluded.content,
       attachments_json = excluded.attachments_json,
       event_json = excluded.event_json,
       timestamp = excluded.timestamp`,
  ).run(
    entry.id,
    threadId,
    repoId,
    entry.personaId ?? null,
    sessionId,
    entry.role,
    entry.role,
    entry.content,
    serialiseAttachments(entry.attachments),
    entry.event ? JSON.stringify(entry.event) : null,
    entry.timestamp,
  );

  const advancesConversation =
    entry.role === 'user' ||
    (entry.role === 'assistant' &&
      (!entry.event || entry.event.type !== 'text' || entry.event.assistantPhase !== 'progress'));

  if (advancesConversation) {
    db.prepare(
      `UPDATE chat_threads
       SET
         updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END,
         last_message_at = CASE
           WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
           ELSE last_message_at
         END
       WHERE id = ?`,
    ).run(entry.timestamp, entry.timestamp, entry.timestamp, entry.timestamp, threadId);
  }
}

export function loadChatHistory(threadId: string): ChatMessage[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         id,
         role,
         content,
         attachments_json,
         timestamp,
         persona_id,
         session_id,
         thread_id,
         repo_id,
         event_json
       FROM chat_messages
       WHERE thread_id = ?
       ORDER BY timestamp ASC, rowid ASC`,
    )
    .all(threadId) as Array<{
    id: string;
    role: string;
    content: string;
    attachments_json: string | null;
    timestamp: string;
    persona_id: string | null;
    session_id: string | null;
    thread_id: string | null;
    repo_id: string | null;
    event_json: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    timestamp: row.timestamp,
    event: parseChatEvent(row.event_json),
    personaId: row.persona_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    repoContext: row.repo_id ?? undefined,
    attachments: parseAttachments(row.attachments_json),
  }));
}

function parseChatEvent(value: string | null): ChatMessage['event'] {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ChatMessage['event'];
    return parsed && typeof parsed.type === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearChatHistory(threadId: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM chat_sessions WHERE thread_id = ?').run(threadId);
    db.prepare(
      `UPDATE chat_threads
       SET updated_at = ?, last_message_at = NULL
       WHERE id = ?`,
    ).run(new Date().toISOString(), threadId);
  });
  tx();
}
