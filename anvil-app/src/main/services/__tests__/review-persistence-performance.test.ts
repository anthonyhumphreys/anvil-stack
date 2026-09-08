import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema.js';
import * as codeReview from '../code-review-persistence.service.js';
import * as security from '../security-persistence.service.js';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));

afterAll(() => db.close());
beforeEach(() => {
  db.exec(`
    DELETE FROM code_review_findings;
    DELETE FROM security_findings;
    DELETE FROM code_reviews;
    DELETE FROM security_audits;
    DELETE FROM repos;
    INSERT INTO repos (id, name, path) VALUES ('repo', 'Repo', '/repo');
  `);
});

describe('finding batches', () => {
  it('preserves code review fields, severity ordering and single inserts', () => {
    const reviewId = codeReview.createReview({
      repoId: 'repo',
      mode: 'quick_glance',
      scopeType: 'latest_commit',
    });
    const inputs: codeReview.CreateFindingInput[] = [
      { reviewId, severity: 'minor', category: 'Style', description: 'First' },
      {
        reviewId,
        severity: 'critical',
        category: 'Correctness',
        description: 'Second',
        filePath: 'src/a.ts',
        lineStart: 4,
        lineEnd: 8,
        suggestion: 'Fix it',
      },
    ];
    const ids = codeReview.createFindings(inputs);
    expect(new Set(ids).size).toBe(2);
    expect(codeReview.getFindings(reviewId).map((finding) => finding.id)).toEqual([ids[1], ids[0]]);
    inputs.forEach((input, index) =>
      expect(codeReview.getFinding(ids[index])).toMatchObject({ ...input, dismissed: false }),
    );
    expect(codeReview.getFinding(codeReview.createFinding(inputs[0]))).toMatchObject(inputs[0]);
    expect(codeReview.createFindings([])).toEqual([]);
  });

  it('preserves security metadata and rolls back the entire batch on failure', () => {
    const auditId = security.createAudit({ repoId: 'repo', scope: ['OWASP'] });
    const input: security.CreateFindingInput = {
      auditId,
      severity: 'high',
      category: 'Injection',
      affectedFiles: ['a.ts', 'b.ts'],
      description: 'Unsafe input',
      owaspRef: 'A03',
      cweRef: 'CWE-89',
      remediation: 'Bind parameters',
    };
    const [id] = security.createFindings([input]);
    expect(security.getFinding(id)).toMatchObject({ ...input, dismissed: false });
    expect(() => security.createFindings([input, { ...input, auditId: 'missing' }])).toThrow();
    expect(security.getFindings(auditId)).toHaveLength(1);
    expect(security.getFinding(security.createFinding(input))).toMatchObject(input);
    expect(security.createFindings([])).toEqual([]);
  });

  it('rolls back code review batches without removing existing findings', () => {
    const reviewId = codeReview.createReview({
      repoId: 'repo',
      mode: 'senior_dev',
      scopeType: 'branch_diff',
    });
    const input: codeReview.CreateFindingInput = {
      reviewId,
      severity: 'major',
      category: 'Bug',
      description: 'Broken',
    };
    codeReview.createFinding(input);
    expect(() => codeReview.createFindings([input, { ...input, reviewId: 'missing' }])).toThrow();
    expect(codeReview.getFindings(reviewId)).toHaveLength(1);
  });
});

const indexQueries = [
  [
    'idx_code_reviews_repo_started',
    'SELECT * FROM code_reviews WHERE repo_id = ? ORDER BY started_at DESC',
  ],
  [
    'idx_code_reviews_running',
    "SELECT * FROM code_reviews WHERE repo_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
  ],
  ['idx_code_review_findings_review', 'SELECT * FROM code_review_findings WHERE review_id = ?'],
  [
    'idx_security_audits_repo_started',
    'SELECT * FROM security_audits WHERE repo_id = ? ORDER BY started_at DESC',
  ],
  [
    'idx_security_audits_running',
    "SELECT * FROM security_audits WHERE repo_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
  ],
  ['idx_security_findings_audit', 'SELECT * FROM security_findings WHERE audit_id = ?'],
];

describe('review lookup indexes', () => {
  it.each(indexQueries)('uses %s on a fresh database', (index, query) => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all('repo') as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes(`USING INDEX ${index}`))).toBe(true);
    expect(
      plan.some(({ detail }) => detail.includes('SCAN ') || detail.includes('TEMP B-TREE')),
    ).toBe(false);
  });

  it('adds the same indexes to existing databases without changing review data', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec(SCHEMA_SQL);
      for (const [index] of indexQueries) legacy.exec(`DROP INDEX ${index}`);
      legacy.exec(
        "INSERT INTO repos (id, name, path) VALUES ('repo', 'Repo', '/repo'); INSERT INTO code_reviews (id, repo_id, mode, scope_type) VALUES ('review', 'repo', 'quick_glance', 'latest_commit')",
      );
      const before = legacy.prepare('SELECT * FROM code_reviews').all();
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of MIGRATIONS[63]
          .split(';')
          .map((sql) => sql.trim())
          .filter(Boolean)) {
          try {
            legacy.exec(statement);
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('duplicate column'))
              throw error;
          }
        }
      }
      expect(legacy.prepare('SELECT * FROM code_reviews').all()).toEqual(before);
      for (const [index, query] of indexQueries) {
        const plan = legacy.prepare(`EXPLAIN QUERY PLAN ${query}`).all('repo') as Array<{
          detail: string;
        }>;
        expect(plan.some(({ detail }) => detail.includes(`USING INDEX ${index}`))).toBe(true);
      }
    } finally {
      legacy.close();
    }
  });
});
