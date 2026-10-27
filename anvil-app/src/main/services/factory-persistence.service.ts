import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  FactoryDefinition,
  FactoryIssue,
  FactoryReceipt,
  FactoryRun,
} from '../../shared/factories.js';

/** No Electron/provider dependency: this store also runs in a plain Node daemon. */
export class FactoryStore {
  constructor(readonly db: Database.Database) {}
  getFactory(id: string): FactoryDefinition | null {
    const row = this.db
      .prepare('SELECT record_json FROM factory_definitions WHERE id = ?')
      .get(id) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }
  listFactories(workspaceId?: string): FactoryDefinition[] {
    const rows = workspaceId
      ? this.db
          .prepare(
            'SELECT record_json FROM factory_definitions WHERE workspace_id=? ORDER BY updated_at DESC',
          )
          .all(workspaceId)
      : this.db
          .prepare('SELECT record_json FROM factory_definitions ORDER BY updated_at DESC')
          .all();
    return (rows as Array<{ record_json: string }>).map((row) => JSON.parse(row.record_json));
  }
  getRevision(factoryId: string, revision: number): FactoryDefinition | null {
    const row = this.db
      .prepare('SELECT record_json FROM factory_revisions WHERE factory_id=? AND revision=?')
      .get(factoryId, revision) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }
  saveRevision(factory: FactoryDefinition, expectedRevision?: number): void {
    this.db.transaction(() => {
      const current = this.getFactory(factory.id);
      if ((current?.revision ?? 0) !== (expectedRevision ?? 0))
        throw new Error('Factory changed. Review its latest revision.');
      this.db
        .prepare(
          'INSERT INTO factory_definitions(id,workspace_id,record_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at',
        )
        .run(factory.id, factory.workspaceId, JSON.stringify(factory), factory.updatedAt);
      this.db
        .prepare('INSERT INTO factory_revisions(factory_id,revision,record_json) VALUES(?,?,?)')
        .run(factory.id, factory.revision, JSON.stringify(factory));
    })();
  }
  updateFactory(factory: FactoryDefinition): void {
    const changed = this.db
      .prepare('UPDATE factory_definitions SET record_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(factory), factory.updatedAt, factory.id);
    if (changed.changes !== 1) throw new Error('Factory not found.');
  }
  getRun(id: string): FactoryRun | null {
    const row = this.db.prepare('SELECT record_json FROM factory_runs WHERE id=?').get(id) as
      { record_json: string } | undefined;
    if (!row) return null;
    return { ...JSON.parse(row.record_json), receipts: this.receipts(id) };
  }
  listRuns(factoryId: string): FactoryRun[] {
    return (
      this.db
        .prepare('SELECT id FROM factory_runs WHERE factory_id=? ORDER BY updated_at DESC')
        .all(factoryId) as Array<{ id: string }>
    ).map((row) => this.getRun(row.id)!);
  }
  intake(factory: FactoryDefinition, issue: FactoryIssue, now: Date): FactoryRun {
    const key = `${factory.definition.github.host.toLowerCase()}/${factory.definition.github.owner.toLowerCase()}/${factory.definition.github.repo.toLowerCase()}#${issue.number}`;
    const existing = this.db
      .prepare('SELECT id,factory_id FROM factory_runs WHERE issue_key=?')
      .get(key) as { id: string; factory_id: string } | undefined;
    if (existing) {
      if (existing.factory_id !== factory.id)
        throw new Error(
          'Issue is already claimed by another factory. Inspect the existing lifecycle.',
        );
      return this.getRun(existing.id)!;
    }
    const at = now.toISOString();
    const run: FactoryRun = {
      id: randomUUID(),
      factoryId: factory.id,
      revision: factory.revision,
      workspaceId: factory.workspaceId,
      snapshot: factory,
      issue,
      stage: 'received',
      version: 1,
      repairRounds: 0,
      commandsUsed: 0,
      createdAt: at,
      updatedAt: at,
      deadlineAt: new Date(
        now.getTime() + factory.definition.limits.maxRunMinutes * 60000,
      ).toISOString(),
      receipts: [],
    };
    this.db
      .prepare(
        'INSERT OR IGNORE INTO factory_runs(id,factory_id,issue_key,stage,record_json,version,updated_at) VALUES(?,?,?,?,?,1,?)',
      )
      .run(run.id, factory.id, key, run.stage, JSON.stringify(run), at);
    const row = this.db
      .prepare('SELECT id,factory_id FROM factory_runs WHERE issue_key=?')
      .get(key) as { id: string; factory_id: string };
    if (row.factory_id !== factory.id) throw new Error('Issue was claimed by another factory.');
    return this.getRun(row.id)!;
  }
  updateRun(run: FactoryRun, expectedVersion = run.version): FactoryRun {
    const next = { ...run, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const changed = this.db
      .prepare(
        'UPDATE factory_runs SET stage=?,record_json=?,version=?,updated_at=? WHERE id=? AND version=?',
      )
      .run(
        next.stage,
        JSON.stringify({ ...next, receipts: [] }),
        next.version,
        next.updatedAt,
        next.id,
        expectedVersion,
      );
    if (changed.changes !== 1) throw new Error('Factory run changed. Reload its current state.');
    return { ...next, receipts: this.receipts(next.id) };
  }
  claim(id: string, owner: string, now: Date, ttlMs = 120000): boolean {
    return this.db.transaction(() => {
      const run = this.getRun(id);
      if (!run) return false;
      if (run.stage === 'received') {
        const factory = this.getFactory(run.factoryId);
        if (!factory) return false;
        const occupied = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM factory_runs WHERE factory_id=? AND id<>? AND (stage IN ('implementing','validating','publishing','waiting-checks','repairing','awaiting-merge-approval','merging','verifying-merge') OR (lease_owner IS NOT NULL AND lease_until>?))",
          )
          .get(run.factoryId, id, now.toISOString()) as { n: number };
        if (occupied.n >= factory.definition.limits.maxConcurrentRuns) return false;
      }
      return (
        this.db
          .prepare(
            'UPDATE factory_runs SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner IS NULL OR lease_until<=? OR lease_owner=?)',
          )
          .run(owner, new Date(now.getTime() + ttlMs).toISOString(), id, now.toISOString(), owner)
          .changes === 1
      );
    })();
  }
  release(id: string, owner: string): void {
    this.db
      .prepare(
        'UPDATE factory_runs SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?',
      )
      .run(id, owner);
  }
  ownsLease(id: string, owner: string, now: Date): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM factory_runs WHERE id=? AND lease_owner=? AND lease_until>?')
        .get(id, owner, now.toISOString()),
    );
  }
  receipt(runId: string, key: string, kind: FactoryReceipt['kind']): FactoryReceipt {
    const now = new Date().toISOString();
    const receipt: FactoryReceipt = {
      id: randomUUID(),
      runId,
      key,
      kind,
      status: 'intent',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'INSERT OR IGNORE INTO factory_receipts(id,run_id,receipt_key,record_json) VALUES(?,?,?,?)',
      )
      .run(receipt.id, runId, key, JSON.stringify(receipt));
    return this.receipts(runId).find((row) => row.key === key)!;
  }
  saveReceipt(receipt: FactoryReceipt): void {
    this.db
      .prepare('UPDATE factory_receipts SET record_json=? WHERE id=? AND run_id=?')
      .run(
        JSON.stringify({ ...receipt, updatedAt: new Date().toISOString() }),
        receipt.id,
        receipt.runId,
      );
  }
  receipts(runId: string): FactoryReceipt[] {
    return (
      this.db
        .prepare('SELECT record_json FROM factory_receipts WHERE run_id=? ORDER BY rowid')
        .all(runId) as Array<{ record_json: string }>
    ).map((row) => JSON.parse(row.record_json));
  }
  cursor(factoryId: string): string | undefined {
    return (
      this.db.prepare('SELECT cursor FROM factory_cursors WHERE factory_id=?').get(factoryId) as
        { cursor: string } | undefined
    )?.cursor;
  }
  saveCursor(factoryId: string, cursor: string): void {
    this.db
      .prepare(
        'INSERT INTO factory_cursors(factory_id,cursor) VALUES(?,?) ON CONFLICT(factory_id) DO UPDATE SET cursor=excluded.cursor',
      )
      .run(factoryId, cursor);
  }
  audit(factoryId: string, actorId: string, action: string, detail: unknown, runId?: string): void {
    this.db
      .prepare(
        'INSERT INTO factory_audit(factory_id,run_id,actor_id,action,detail_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        factoryId,
        runId ?? null,
        actorId,
        action,
        JSON.stringify(detail),
        new Date().toISOString(),
      );
  }
}
