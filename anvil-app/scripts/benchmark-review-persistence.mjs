// Run from anvil-app with: node --experimental-strip-types scripts/benchmark-review-persistence.mjs
// Uses temporary WAL databases only. This measures SQLite work, not LLM or end-to-end latency.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SCHEMA_SQL, MIGRATIONS } from '../src/main/db/schema.ts';

const directory = mkdtempSync(join(tmpdir(), 'anvil-review-bench-'));
const indexes = [...MIGRATIONS[62].matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const insertSql = `INSERT INTO security_findings
  (id, audit_id, severity, category, affected_files, description)
  VALUES (?, ?, 'high', 'Injection', '["src/example.ts"]', 'Review finding')`;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(operation, repetitions = 1) {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    for (let i = 0; i < repetitions; i++) operation();
    samples.push((performance.now() - start) / repetitions);
  }
  return Number(median(samples).toFixed(3));
}
function benchmark(optimized) {
  const db = new Database(join(directory, optimized ? 'optimized.db' : 'baseline.db'));
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    if (!optimized) for (const index of indexes) db.exec(`DROP INDEX ${index}`);
    const repo = db.prepare('INSERT INTO repos (id, name, path) VALUES (?, ?, ?)');
    const audit = db.prepare(
      'INSERT INTO security_audits (id, repo_id, scope, status, started_at) VALUES (?, ?, ?, ?, ?)',
    );
    const finding = db.prepare(insertSql);
    db.transaction(() => {
      for (let r = 0; r < 20; r++) repo.run(`repo-${r}`, `Repo ${r}`, `/repo-${r}`);
      for (let a = 0; a < 1000; a++) {
        audit.run(
          `audit-${a}`,
          `repo-${a % 20}`,
          '["OWASP"]',
          a < 980 ? 'completed' : 'running',
          new Date(a * 1000).toISOString(),
        );
        for (let f = 0; f < 50; f++) finding.run(`seed-${a}-${f}`, `audit-${a}`);
      }
    })();
    const readFindingsMs = measure(
      () =>
        db
          .prepare(
            `SELECT * FROM security_findings WHERE audit_id = ?
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END`,
          )
          .all('audit-500'),
      50,
    );
    const historyMs = measure(
      () =>
        db
          .prepare('SELECT * FROM security_audits WHERE repo_id = ? ORDER BY started_at DESC')
          .all('repo-0'),
      50,
    );
    let batch = 0;
    const write200FindingsMs = measure(() => {
      const id = batch++;
      if (optimized) {
        const insert = db.prepare(insertSql);
        db.transaction(() => {
          for (let f = 0; f < 200; f++) insert.run(`batch-${id}-${f}`, 'audit-0');
        })();
      } else {
        for (let f = 0; f < 200; f++) db.prepare(insertSql).run(`batch-${id}-${f}`, 'audit-0');
      }
    });
    return { readFindingsMs, historyMs, write200FindingsMs };
  } finally {
    db.close();
  }
}
try {
  console.log(
    JSON.stringify(
      {
        fixture: { repositories: 20, audits: 1000, findings: 50000, writeBatch: 200, samples: 5 },
        baseline: benchmark(false),
        optimized: benchmark(true),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
