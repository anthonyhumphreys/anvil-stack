import { randomUUID } from 'node:crypto';
import { getDb } from '../db/database.js';
import { DEFAULT_LIFECYCLE_STAGES, GATE_IDS } from '../../shared/lifecycle-types.js';
import type {
  LifecycleItem,
  LifecycleStage,
  LifecycleStageDefinition,
  LifecycleStageUpdate,
  GateTemplate,
  GateId,
  GateCriterion,
  GateTemplateUpdate,
  GateDecision,
  GateDecisionOutcome,
} from '../../shared/lifecycle-types.js';
import type { WorkItemProvider } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface LifecycleItemRow {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  stage: string;
  linked_work_item_id: string | null;
  linked_work_item_provider: string | null;
  change_classification: string | null;
  created_at: string;
  updated_at: string;
}

interface GateTemplateRow {
  id: string;
  workspace_id: string;
  gate: string;
  label: string;
  criteria: string;
}

interface GateDecisionRow {
  id: string;
  lifecycle_item_id: string;
  gate: string;
  decision: string;
  decided_by: string;
  conditions: string | null;
  rationale: string | null;
  decided_at: string;
}

interface LifecycleStageRow {
  stage: string;
  label: string;
  sort_order: number;
}

interface RepoIdRow {
  repo_id: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function hydrateRepoIds(lifecycleItemId: string): string[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT repo_id FROM lifecycle_item_repos WHERE lifecycle_item_id = ?')
    .all(lifecycleItemId) as RepoIdRow[];
  return rows.map((r) => r.repo_id);
}

function mapItem(row: LifecycleItemRow): LifecycleItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description ?? undefined,
    stage: row.stage as LifecycleStage,
    linkedWorkItemId: row.linked_work_item_id ?? undefined,
    linkedWorkItemProvider: (row.linked_work_item_provider as WorkItemProvider) ?? undefined,
    linkedRepoIds: hydrateRepoIds(row.id),
    changeClassification:
      (row.change_classification as 'major' | 'minor' | 'standard') ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTemplate(row: GateTemplateRow): GateTemplate {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    gate: row.gate as GateId,
    label: row.label,
    criteria: JSON.parse(row.criteria) as GateCriterion[],
  };
}

function mapDecision(row: GateDecisionRow): GateDecision {
  return {
    id: row.id,
    lifecycleItemId: row.lifecycle_item_id,
    gate: row.gate as GateId,
    decision: row.decision as GateDecisionOutcome,
    decidedBy: row.decided_by,
    conditions: row.conditions ?? undefined,
    rationale: row.rationale ?? undefined,
    decidedAt: row.decided_at,
  };
}

function mapStage(row: LifecycleStageRow): LifecycleStageDefinition {
  return {
    id: row.stage,
    label: row.label,
    order: row.sort_order,
  };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export function listLifecycleStages(workspaceId: string): LifecycleStageDefinition[] {
  ensureLifecycleStages(workspaceId);
  const rows = getDb()
    .prepare(
      `SELECT stage, label, sort_order
       FROM lifecycle_stages
       WHERE workspace_id = ?
       ORDER BY sort_order ASC`,
    )
    .all(workspaceId) as LifecycleStageRow[];

  return rows.map(mapStage);
}

export function updateLifecycleStages(
  workspaceId: string,
  stages: LifecycleStageUpdate[],
): LifecycleStageDefinition[] {
  const normalized = normalizeStageUpdates(stages);
  const db = getDb();
  const activeStageRows = db
    .prepare(
      `SELECT stage, COUNT(*) AS count
       FROM lifecycle_items
       WHERE workspace_id = ?
       GROUP BY stage`,
    )
    .all(workspaceId) as Array<{ stage: string; count: number }>;
  const nextStageIds = new Set(normalized.map((stage) => stage.id));
  const removedActiveStages = activeStageRows
    .filter((row) => row.count > 0 && !nextStageIds.has(row.stage))
    .map((row) => row.stage);

  if (removedActiveStages.length > 0) {
    throw new Error(
      `Cannot remove lifecycle stages with existing items: ${removedActiveStages.join(', ')}`,
    );
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM lifecycle_stages WHERE workspace_id = ?').run(workspaceId);
    const insert = db.prepare(
      `INSERT INTO lifecycle_stages
        (id, workspace_id, stage, label, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );

    normalized.forEach((stage, index) => {
      insert.run(randomUUID(), workspaceId, stage.id, stage.label, index);
    });
  });

  tx();
  return listLifecycleStages(workspaceId);
}

export function resetLifecycleStages(workspaceId: string): LifecycleStageDefinition[] {
  return updateLifecycleStages(workspaceId, DEFAULT_LIFECYCLE_STAGES);
}

export function ensureLifecycleStages(workspaceId: string): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT COUNT(*) AS count FROM lifecycle_stages WHERE workspace_id = ?')
    .get(workspaceId) as { count: number };

  if (existing.count > 0) {
    return;
  }

  const insert = db.prepare(
    `INSERT INTO lifecycle_stages
      (id, workspace_id, stage, label, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  const tx = db.transaction(() => {
    DEFAULT_LIFECYCLE_STAGES.forEach((stage, index) => {
      insert.run(randomUUID(), workspaceId, stage.id, stage.label, index);
    });
  });

  tx();
}

function validateStageTransition(
  workspaceId: string,
  current: LifecycleStage,
  next: LifecycleStage,
): void {
  const stageOrder = listLifecycleStages(workspaceId).map((stage) => stage.id);
  const currentIdx = stageOrder.indexOf(current);
  const nextIdx = stageOrder.indexOf(next);

  if (nextIdx === -1) {
    throw new Error(`Unknown lifecycle stage: ${next}`);
  }

  if (currentIdx === -1) {
    throw new Error(`Unknown current lifecycle stage: ${current}`);
  }

  if (nextIdx <= currentIdx) {
    throw new Error(
      `Cannot move from '${current}' to '${next}' — stage transitions must be forward-only`,
    );
  }
}

function normalizeStageUpdates(stages: LifecycleStageUpdate[]): LifecycleStageUpdate[] {
  if (stages.length === 0) {
    throw new Error('At least one lifecycle stage is required');
  }

  const seen = new Set<string>();

  return stages.map((stage) => {
    const id = stage.id.trim();
    const label = stage.label.trim();

    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      throw new Error(
        `Invalid lifecycle stage id '${stage.id}'. Use lowercase letters, numbers, and underscores.`,
      );
    }

    if (!label) {
      throw new Error(`Lifecycle stage '${id}' needs a label`);
    }

    if (seen.has(id)) {
      throw new Error(`Duplicate lifecycle stage id: ${id}`);
    }

    seen.add(id);
    return { id, label };
  });
}

// ---------------------------------------------------------------------------
// Lifecycle Item CRUD
// ---------------------------------------------------------------------------

export function createItem(
  workspaceId: string,
  opts: {
    title: string;
    description?: string;
    linkedWorkItemId?: string;
    linkedWorkItemProvider?: WorkItemProvider;
    changeClassification?: 'major' | 'minor' | 'standard';
  },
): LifecycleItem {
  const db = getDb();
  const id = randomUUID();
  const [firstStage] = listLifecycleStages(workspaceId);

  if (!firstStage) {
    throw new Error(`Workspace has no lifecycle stages: ${workspaceId}`);
  }

  db.prepare(
    `INSERT INTO lifecycle_items (id, workspace_id, title, description, stage, linked_work_item_id, linked_work_item_provider, change_classification, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    id,
    workspaceId,
    opts.title,
    opts.description ?? null,
    firstStage.id,
    opts.linkedWorkItemId ?? null,
    opts.linkedWorkItemProvider ?? null,
    opts.changeClassification ?? null,
  );
  const row = db.prepare('SELECT * FROM lifecycle_items WHERE id = ?').get(id) as LifecycleItemRow;
  return mapItem(row);
}

export function updateItem(
  id: string,
  opts: {
    title?: string;
    description?: string;
    stage?: LifecycleStage;
    changeClassification?: 'major' | 'minor' | 'standard';
    linkedWorkItemId?: string | null;
    linkedWorkItemProvider?: WorkItemProvider | null;
  },
): LifecycleItem {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM lifecycle_items WHERE id = ?').get(id) as
    | LifecycleItemRow
    | undefined;
  if (!existing) throw new Error(`Lifecycle item not found: ${id}`);

  if (opts.stage && opts.stage !== existing.stage) {
    validateStageTransition(existing.workspace_id, existing.stage as LifecycleStage, opts.stage);
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  if (opts.title !== undefined) {
    sets.push('title = ?');
    params.push(opts.title);
  }
  if (opts.description !== undefined) {
    sets.push('description = ?');
    params.push(opts.description);
  }
  if (opts.stage !== undefined) {
    sets.push('stage = ?');
    params.push(opts.stage);
  }
  if (opts.changeClassification !== undefined) {
    sets.push('change_classification = ?');
    params.push(opts.changeClassification);
  }
  if (opts.linkedWorkItemId !== undefined) {
    sets.push('linked_work_item_id = ?');
    params.push(opts.linkedWorkItemId);
  }
  if (opts.linkedWorkItemProvider !== undefined) {
    sets.push('linked_work_item_provider = ?');
    params.push(opts.linkedWorkItemProvider);
  }

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE lifecycle_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const row = db.prepare('SELECT * FROM lifecycle_items WHERE id = ?').get(id) as LifecycleItemRow;
  return mapItem(row);
}

export function deleteItem(id: string): void {
  getDb().prepare('DELETE FROM lifecycle_items WHERE id = ?').run(id);
}

export function getItem(id: string): LifecycleItem {
  const row = getDb().prepare('SELECT * FROM lifecycle_items WHERE id = ?').get(id) as
    | LifecycleItemRow
    | undefined;
  if (!row) throw new Error(`Lifecycle item not found: ${id}`);
  return mapItem(row);
}

export function listItems(
  workspaceId: string,
  filters?: { stage?: LifecycleStage; linkedWorkItemId?: string },
): LifecycleItem[] {
  const db = getDb();
  let sql = 'SELECT * FROM lifecycle_items WHERE workspace_id = ?';
  const params: unknown[] = [workspaceId];

  if (filters?.stage) {
    sql += ' AND stage = ?';
    params.push(filters.stage);
  }
  if (filters?.linkedWorkItemId) {
    sql += ' AND linked_work_item_id = ?';
    params.push(filters.linkedWorkItemId);
  }

  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params) as LifecycleItemRow[];
  return rows.map(mapItem);
}

// ---------------------------------------------------------------------------
// Repo linking
// ---------------------------------------------------------------------------

export function linkRepos(lifecycleItemId: string, repoIds: string[]): void {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO lifecycle_item_repos (lifecycle_item_id, repo_id) VALUES (?, ?)',
  );
  const tx = db.transaction(() => {
    for (const repoId of repoIds) {
      stmt.run(lifecycleItemId, repoId);
    }
  });
  tx();
  db.prepare("UPDATE lifecycle_items SET updated_at = datetime('now') WHERE id = ?").run(
    lifecycleItemId,
  );
}

export function unlinkRepo(lifecycleItemId: string, repoId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM lifecycle_item_repos WHERE lifecycle_item_id = ? AND repo_id = ?').run(
    lifecycleItemId,
    repoId,
  );
  db.prepare("UPDATE lifecycle_items SET updated_at = datetime('now') WHERE id = ?").run(
    lifecycleItemId,
  );
}

// ---------------------------------------------------------------------------
// Gate Templates
// ---------------------------------------------------------------------------

export function getGateTemplates(workspaceId: string): GateTemplate[] {
  ensureGateTemplates(workspaceId);
  const rows = getDb()
    .prepare('SELECT * FROM gate_templates WHERE workspace_id = ? ORDER BY gate ASC')
    .all(workspaceId) as GateTemplateRow[];
  return rows.map(mapTemplate);
}

export function updateGateTemplate(
  workspaceId: string,
  gate: GateId,
  updates: GateTemplateUpdate,
): GateTemplate {
  const db = getDb();
  ensureGateTemplates(workspaceId);
  db.prepare(
    `UPDATE gate_templates SET label = ?, criteria = ? WHERE workspace_id = ? AND gate = ?`,
  ).run(updates.label, JSON.stringify(updates.criteria), workspaceId, gate);
  const row = db
    .prepare('SELECT * FROM gate_templates WHERE workspace_id = ? AND gate = ?')
    .get(workspaceId, gate) as GateTemplateRow;
  return mapTemplate(row);
}

export function resetGateTemplates(workspaceId: string): GateTemplate[] {
  const db = getDb();
  db.prepare('DELETE FROM gate_templates WHERE workspace_id = ?').run(workspaceId);
  ensureGateTemplates(workspaceId);
  return getGateTemplates(workspaceId);
}

export function ensureGateTemplates(workspaceId: string): void {
  const db = getDb();
  const existingRows = db
    .prepare('SELECT gate FROM gate_templates WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ gate: string }>;
  const existingGates = new Set(existingRows.map((row) => row.gate));

  const stmt = db.prepare(
    'INSERT INTO gate_templates (id, workspace_id, gate, label, criteria) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    for (const gate of GATE_IDS) {
      if (!existingGates.has(gate)) {
        stmt.run(randomUUID(), workspaceId, gate, '', '[]');
      }
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// Gate Decisions
// ---------------------------------------------------------------------------

export function recordGateDecision(
  lifecycleItemId: string,
  opts: {
    gate: GateId;
    decision: GateDecisionOutcome;
    decidedBy: string;
    conditions?: string;
    rationale?: string;
  },
): GateDecision {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO gate_decisions (id, lifecycle_item_id, gate, decision, decided_by, conditions, rationale, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    lifecycleItemId,
    opts.gate,
    opts.decision,
    opts.decidedBy,
    opts.conditions ?? null,
    opts.rationale ?? null,
  );
  const row = db.prepare('SELECT * FROM gate_decisions WHERE id = ?').get(id) as GateDecisionRow;
  return mapDecision(row);
}

export function listGateDecisions(lifecycleItemId: string): GateDecision[] {
  const rows = getDb()
    .prepare('SELECT * FROM gate_decisions WHERE lifecycle_item_id = ? ORDER BY decided_at ASC')
    .all(lifecycleItemId) as GateDecisionRow[];
  return rows.map(mapDecision);
}
