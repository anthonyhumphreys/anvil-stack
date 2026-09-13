import { randomUUID } from 'node:crypto';
import type { CodexEvent } from '../../shared/types.js';
import type {
  DojoAnalytics,
  DojoPeriod,
  DojoPrice,
  DojoRecommendationState,
  DojoRecommendationStatus,
  DojoRun,
  DojoTokenUsage,
} from '../../shared/dojo-types.js';
import { getDb } from '../db/database.js';
import { classifyDojoMessage, getDojoConfig, getDojoReport } from './dojo.service.js';

export function listDojoPrices(): DojoPrice[] {
  return (
    getDb().prepare('SELECT * FROM dojo_prices ORDER BY provider, model').all() as Array<{
      provider: string;
      model: string;
      input: number;
      cached_input: number;
      output: number;
      updated_at: string;
    }>
  ).map((row) => ({
    provider: row.provider,
    model: row.model,
    input: row.input,
    cachedInput: row.cached_input,
    output: row.output,
    updatedAt: row.updated_at,
  }));
}

export function saveDojoPrice(input: Omit<DojoPrice, 'updatedAt'>): DojoPrice[] {
  if (
    !input ||
    !['codex', 'cursor', 'openai', 'azure'].includes(input.provider) ||
    typeof input.model !== 'string' ||
    !input.model.trim() ||
    input.model.length > 160 ||
    ![input.input, input.cachedInput, input.output].every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000,
    )
  ) {
    throw new Error('Enter a provider, model, and non-negative USD rates per million tokens.');
  }
  getDb()
    .prepare(
      `INSERT INTO dojo_prices VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, model) DO UPDATE SET input=excluded.input, cached_input=excluded.cached_input, output=excluded.output, updated_at=excluded.updated_at`,
    )
    .run(
      input.provider,
      input.model.trim(),
      input.input,
      input.cachedInput,
      input.output,
      new Date().toISOString(),
    );
  return listDojoPrices();
}

export function priceDojoUsage(usage: DojoTokenUsage, price: DojoPrice): number {
  return (
    ((usage.input - usage.cachedInput) * price.input +
      usage.cachedInput * price.cachedInput +
      usage.output * price.output) /
    1_000_000
  );
}

export function setDojoRecommendationState(
  workspaceId: string,
  reportId: string,
  key: string,
  status: DojoRecommendationStatus,
): DojoRecommendationState {
  const report = getDojoReport(reportId);
  if (!report || report.workspaceId !== workspaceId)
    throw new Error('Review not found in this workspace.');
  const keys = [
    ...report.promptRecommendations.map((_, i) => `prompt:${i}`),
    ...report.skillRecommendations.map((_, i) => `curated:${i}`),
    ...(report.craftedSkills ?? []).map((_, i) => `crafted:${i}`),
  ];
  if (!keys.includes(key) || !['suggested', 'accepted', 'applied', 'dismissed'].includes(status))
    throw new Error('Invalid recommendation update.');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO dojo_recommendation_states VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(report_id, recommendation_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at,
    applied_at=CASE WHEN excluded.status='applied' THEN COALESCE(dojo_recommendation_states.applied_at, excluded.applied_at) ELSE NULL END`,
    )
    .run(reportId, key, status, now, status === 'applied' ? now : null);
  return listRecommendationStates(workspaceId).find(
    (row) => row.reportId === reportId && row.key === key,
  )!;
}

function listRecommendationStates(workspaceId: string): DojoRecommendationState[] {
  return getDb()
    .prepare(
      `SELECT s.report_id AS reportId, s.recommendation_key AS key, s.status, s.updated_at AS updatedAt, s.applied_at AS appliedAt
    FROM dojo_recommendation_states s JOIN dojo_reports r ON r.id=s.report_id WHERE r.workspace_id=?`,
    )
    .all(workspaceId) as DojoRecommendationState[];
}

export function validDojoUsage(value: unknown): value is DojoTokenUsage {
  if (!value || typeof value !== 'object') return false;
  const u = value as DojoTokenUsage;
  return (
    [u.input, u.cachedInput, u.output].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    u.cachedInput <= u.input
  );
}

function parseEvent(raw: string | null): CodexEvent | null {
  if (!raw) return null;
  try {
    const event = JSON.parse(raw);
    return event && typeof event.type === 'string' ? event : null;
  } catch {
    return null;
  }
}
function time(value: string): number {
  return Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}
function iso(value: string): string {
  const ms = time(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarizeDojoRuns(runs: DojoRun[]): DojoPeriod {
  const userMessages = runs.reduce((n, r) => n + r.userMessages, 0);
  const corrections = runs.reduce((n, r) => n + r.corrections, 0);
  const durations = runs.flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]));
  const priced = runs.filter((r) => r.cost !== null);
  return {
    runs: runs.length,
    completed: runs.filter((r) => r.outcome === 'completed').length,
    failed: runs.filter((r) => r.outcome === 'failed').length,
    interrupted: runs.filter((r) => r.outcome === 'interrupted').length,
    unfinished: runs.filter((r) => r.outcome === 'unfinished').length,
    unknown: runs.filter((r) => r.outcome === 'unknown').length,
    medianMs: percentile(durations, 0.5),
    p90Ms: percentile(durations, 0.9),
    correctionRate: userMessages ? (corrections / userMessages) * 100 : null,
    userMessages,
    corrections,
    measuredRuns: runs.filter((r) => r.usage !== null).length,
    tokens: runs.reduce((n, r) => n + (r.usage ? r.usage.input + r.usage.output : 0), 0),
    estimatedTokens: runs.filter((r) => !r.usage).reduce((n, r) => n + r.estimatedTokens, 0),
    cost: priced.length ? priced.reduce((n, r) => n + r.cost!, 0) : null,
    pricedRuns: priced.length,
    retries: runs.reduce((n, r) => n + r.retries, 0),
    toolFailures: runs.reduce((n, r) => n + r.failures.length, 0),
  };
}

export function getDojoAnalytics(workspaceId: string, days = 30, now = new Date()): DojoAnalytics {
  if (
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365
  )
    throw new Error('Invalid analytics window.');
  const end = now.getTime();
  const start = end - days * 86_400_000;
  const previousStart = start - days * 86_400_000;
  const timezone = getDojoConfig(workspaceId).timezone;
  const sessions = getDb()
    .prepare(
      `SELECT s.id, s.thread_id, s.provider, s.persona_id, s.started_at, s.ended_at,
    t.title, t.work_item_provider, t.work_item_id FROM chat_sessions s JOIN chat_threads t ON t.id=s.thread_id
    WHERE t.workspace_id=? AND julianday(s.started_at)>=julianday(?) AND julianday(s.started_at)<julianday(?) ORDER BY s.started_at DESC`,
    )
    .all(workspaceId, new Date(previousStart).toISOString(), now.toISOString()) as Array<{
    id: string;
    thread_id: string;
    provider: string | null;
    persona_id: string | null;
    started_at: string;
    ended_at: string | null;
    title: string;
    work_item_provider: string | null;
    work_item_id: string | null;
  }>;
  const rows = getDb()
    .prepare(
      `SELECT m.id,m.session_id,m.role,m.content,m.event_json,m.timestamp FROM chat_messages m
    JOIN chat_sessions s ON s.id=m.session_id JOIN chat_threads t ON t.id=s.thread_id
    WHERE t.workspace_id=? AND julianday(s.started_at)>=julianday(?) AND julianday(s.started_at)<julianday(?)
    AND julianday(m.timestamp)<julianday(?) ORDER BY julianday(m.timestamp),m.rowid`,
    )
    .all(
      workspaceId,
      new Date(previousStart).toISOString(),
      now.toISOString(),
      now.toISOString(),
    ) as Array<{
    id: string;
    session_id: string;
    role: string;
    content: string;
    event_json: string | null;
    timestamp: string;
  }>;
  const telemetry = getDb()
    .prepare(
      `SELECT e.id,e.session_id,'system' AS role,'' AS content,e.event_json,e.timestamp
    FROM dojo_execution_events e JOIN chat_sessions s ON s.id=e.session_id JOIN chat_threads t ON t.id=s.thread_id
    WHERE t.workspace_id=? AND julianday(s.started_at)>=julianday(?) AND julianday(s.started_at)<julianday(?)
    AND julianday(e.timestamp)<julianday(?) ORDER BY julianday(e.timestamp),e.rowid`,
    )
    .all(
      workspaceId,
      new Date(previousStart).toISOString(),
      now.toISOString(),
      now.toISOString(),
    ) as typeof rows;
  rows.push(...telemetry);
  rows.sort((a, b) => time(a.timestamp) - time(b.timestamp));
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const entries = bySession.get(row.session_id) ?? [];
    entries.push(row);
    bySession.set(row.session_id, entries);
  }
  const seenUsage = new Set<string>();
  const runs: DojoRun[] = sessions.map((s) => {
    const r: DojoRun = {
      id: s.id,
      threadId: s.thread_id,
      title: s.title,
      provider: s.provider ?? 'unknown',
      model: 'unknown',
      role: s.persona_id ?? 'Unattributed',
      workItem: s.work_item_id ? `${s.work_item_provider ?? 'work'}:${s.work_item_id}` : null,
      startedAt: iso(s.started_at),
      endedAt: s.ended_at ? iso(s.ended_at) : null,
      durationMs: null,
      outcome: s.ended_at ? 'unknown' : 'unfinished',
      userMessages: 0,
      corrections: 0,
      estimatedTokens: 0,
      usage: null,
      cost: null,
      pricedUsageCount: 0,
      usageCount: 0,
      failures: [],
      retries: 0,
      tools: 0,
      goalsCompleted: 0,
      contextCompactions: 0,
      contextPercent: null,
      agents: [],
    };
    const failedCommands = new Set<string>();
    const seenTools = new Set<string>();
    const goals = new Set<string>();
    for (const row of bySession.get(s.id) ?? []) {
      if (row.role === 'user') {
        r.userMessages++;
        if (classifyDojoMessage(row.content).correction) r.corrections++;
      }
      if (row.role === 'user' || row.role === 'assistant')
        r.estimatedTokens += Math.ceil(row.content.length / 4);
      const e = parseEvent(row.event_json);
      if (!e) continue;
      if (e.model) r.model = e.model;
      if (e.type === 'turn_outcome' && e.turnOutcome) {
        r.outcome = e.turnOutcome === 'inProgress' ? 'unfinished' : e.turnOutcome;
        r.endedAt = e.turnOutcome === 'inProgress' ? null : iso(row.timestamp);
      }
      if (e.type === 'status' && e.status === 'thinking') {
        r.outcome = 'unfinished';
        r.endedAt = null;
      }
      if (e.type === 'status' && e.status === 'error') r.outcome = 'failed';
      const usageKey = `${r.provider}:${e.usageId}`;
      if (e.type === 'usage' && validDojoUsage(e.usage) && e.usageId && !seenUsage.has(usageKey)) {
        seenUsage.add(usageKey);
        r.usageCount++;
        r.usage ??= { input: 0, cachedInput: 0, output: 0 };
        r.usage.input += e.usage.input;
        r.usage.cachedInput += e.usage.cachedInput;
        r.usage.output += e.usage.output;
        if (
          e.usagePrice &&
          [e.usagePrice.input, e.usagePrice.cachedInput, e.usagePrice.output].every(
            (n) => Number.isFinite(n) && n >= 0,
          )
        ) {
          r.cost = (r.cost ?? 0) + priceDojoUsage(e.usage, e.usagePrice);
          r.pricedUsageCount++;
        }
      }
      if (e.type === 'command_exec' && e.command) {
        const key = e.itemId ?? row.id;
        if (!seenTools.has(key)) {
          seenTools.add(key);
          r.tools++;
          if (failedCommands.has(e.command)) r.retries++;
        }
        if (e.exitCode !== undefined && e.exitCode !== 0) {
          failedCommands.add(e.command);
          r.failures.push({ label: e.command.slice(0, 180), timestamp: iso(row.timestamp) });
        } else if (e.exitCode === 0) {
          failedCommands.delete(e.command);
        }
      }
      if (e.type === 'tool_call') {
        const key = e.itemId ?? row.id;
        if (!seenTools.has(key)) {
          seenTools.add(key);
          r.tools++;
        }
        if (e.toolStatus === 'failed' && !failedCommands.has(key)) {
          failedCommands.add(key);
          r.failures.push({ label: e.toolName ?? 'Tool failed', timestamp: iso(row.timestamp) });
        }
      }
      if (e.type === 'usage_context') {
        if (e.contextUsage && e.contextUsage.size > 0)
          r.contextPercent = (e.contextUsage.used / e.contextUsage.size) * 100;
        if (
          typeof e.observedCostUsd === 'number' &&
          Number.isFinite(e.observedCostUsd) &&
          e.observedCostUsd >= 0
        )
          r.cost = (r.cost ?? 0) + e.observedCostUsd;
      }
      if (e.type === 'error' || (e.type === 'status' && e.status === 'error'))
        r.failures.push({
          label: (e.errorMessage ?? 'Provider error').slice(0, 180),
          timestamp: iso(row.timestamp),
        });
      if (e.type === 'context_compaction') r.contextCompactions++;
      if (e.type === 'goal_update' && e.goal?.status === 'complete') goals.add(e.goal.objective);
      if (e.type === 'subagent_update' && e.subagent) {
        const sub = e.subagent;
        for (const id of new Set([
          ...sub.receiverThreadIds,
          ...sub.agents.map((a) => a.threadId),
          ...(sub.agentThreadId ? [sub.agentThreadId] : []),
        ])) {
          let agent = r.agents.find((a) => a.id === id);
          if (!agent) {
            agent = {
              id,
              label: sub.agentPath ?? `Agent ${id.slice(0, 8)}`,
              model: sub.model ?? 'unknown',
              status: 'running',
              startedAt: iso(row.timestamp),
              endedAt: null,
            };
            r.agents.push(agent);
          }
          const state = sub.agents.find((a) => a.threadId === id);
          if (state) {
            agent.status = state.status;
            if (['completed', 'errored', 'shutdown', 'interrupted'].includes(state.status))
              agent.endedAt = iso(row.timestamp);
          }
          if (sub.model) agent.model = sub.model;
        }
      }
    }
    r.goalsCompleted = goals.size;
    if (r.endedAt) {
      const duration = time(r.endedAt) - time(r.startedAt);
      if (Number.isFinite(duration) && duration >= 0) r.durationMs = duration;
    }
    return r;
  });
  const currentRuns = runs.filter((r) => time(r.startedAt) >= start);
  const dateFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const buckets = new Map<string, DojoRun[]>();
  for (let t = start; t < end; t += 86_400_000) buckets.set(dateFormat.format(new Date(t)), []);
  for (const r of currentRuns) {
    const date = dateFormat.format(new Date(r.startedAt));
    const bucket = buckets.get(date) ?? [];
    bucket.push(r);
    buckets.set(date, bucket);
  }
  const reviews = getDb()
    .prepare(
      `SELECT status,error_message FROM dojo_reports WHERE workspace_id=? AND julianday(started_at)>=julianday(?) ORDER BY started_at DESC`,
    )
    .all(workspaceId, new Date(start).toISOString()) as Array<{
    status: string;
    error_message: string | null;
  }>;
  return {
    workspaceId,
    deliveries: getDb()
      .prepare(
        'SELECT work_item AS workItem, completed_at AS completedAt FROM dojo_deliveries WHERE workspace_id=?',
      )
      .all(workspaceId) as Array<{ workItem: string; completedAt: string }>,
    windowStart: new Date(start).toISOString(),
    windowEnd: now.toISOString(),
    timezone,
    current: summarizeDojoRuns(currentRuns),
    previous: summarizeDojoRuns(runs.filter((r) => time(r.startedAt) < start)),
    runs: currentRuns,
    days: [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rs]) => {
        const p = summarizeDojoRuns(rs);
        return {
          date,
          runs: p.runs,
          completed: p.completed,
          failed: p.failed,
          tokens: p.tokens,
          corrections: p.corrections,
          userMessages: p.userMessages,
          durationMs: p.medianMs,
          cost: p.cost,
        };
      }),
    prices: listDojoPrices(),
    followThrough: listRecommendationStates(workspaceId),
    reviews: {
      completed: reviews.filter((r) => r.status === 'completed').length,
      failed: reviews.filter((r) => r.status === 'failed').length,
      running: reviews.filter((r) => r.status === 'running').length,
      latestError: reviews.find((r) => r.status === 'failed')?.error_message ?? null,
    },
  };
}

export function setDojoDelivery(workspaceId: string, workItem: string, completed: boolean): void {
  if (
    typeof workspaceId !== 'string' ||
    typeof workItem !== 'string' ||
    typeof completed !== 'boolean'
  )
    throw new Error('Invalid delivery update.');
  const linked = getDb()
    .prepare(
      "SELECT 1 FROM chat_threads WHERE workspace_id=? AND work_item_provider || ':' || work_item_id = ?",
    )
    .get(workspaceId, workItem);
  if (!linked) throw new Error('Work item is not linked to this workspace.');
  if (completed)
    getDb()
      .prepare(
        'INSERT INTO dojo_deliveries VALUES (?,?,?) ON CONFLICT(workspace_id,work_item) DO NOTHING',
      )
      .run(workspaceId, workItem, new Date().toISOString());
  else
    getDb()
      .prepare('DELETE FROM dojo_deliveries WHERE workspace_id=? AND work_item=?')
      .run(workspaceId, workItem);
}

export function recordDojoExecutionEvent(
  sessionId: string,
  event: CodexEvent,
  timestamp = new Date().toISOString(),
): void {
  getDb()
    .prepare(
      'INSERT INTO dojo_execution_events(id,session_id,event_json,timestamp) VALUES (?,?,?,?)',
    )
    .run(randomUUID(), sessionId, JSON.stringify(event), timestamp);
}
