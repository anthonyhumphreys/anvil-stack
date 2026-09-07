import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../../db/schema.js';
const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
const fixture = vi.hoisted(() => ({
  type: 'code_review',
  tree: 'current',
  config: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../lifecycle.service.js', () => ({
  getItem: () => ({ workspaceId: 'ws', linkedRepoIds: ['one', 'two'] }),
  getGateTemplates: () => [
    {
      gate: 'gate_1',
      criteria: [
        {
          id: 'criterion',
          type: fixture.type,
          label: 'Required',
          required: true,
          config: fixture.config,
        },
      ],
    },
  ],
}));
vi.mock('../review-binding.service.js', () => ({ currentRepoTree: () => fixture.tree }));
import { checkReadiness } from '../gate-readiness.service.js';
let root: string;
beforeEach(() => {
  db.exec(
    'DELETE FROM code_review_findings; DELETE FROM code_reviews; DELETE FROM security_audits; DELETE FROM repo_summaries; DELETE FROM repos;',
  );
  root = mkdtempSync(join(tmpdir(), 'anvil-gate-test-'));
  fixture.type = 'code_review';
  fixture.config = undefined;
  fixture.tree = 'current';
  for (const id of ['one', 'two']) {
    mkdirSync(join(root, id));
    db.prepare('INSERT INTO repos (id,name,path) VALUES (?,?,?)').run(id, id, join(root, id));
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function review(id: string, tree: string) {
  db.prepare(
    "INSERT INTO code_reviews (id,repo_id,mode,scope_type,status,source_tree) VALUES (?,?, 'standard','full_codebase','completed',?)",
  ).run(id, id, tree);
}
describe('readiness evidence', () => {
  it('requires a current review for every linked repository', () => {
    review('one', 'current');
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    review('two', 'old');
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    db.prepare("UPDATE code_reviews SET source_tree = 'current'").run();
    expect(checkReadiness('item', 'gate_1').overall).toBe('green');
  });
  it('does not treat missing audit provenance as current security evidence', () => {
    fixture.type = 'security_audit';
    db.prepare(
      "INSERT INTO security_audits (id,repo_id,scope,status) VALUES ('audit','one','[]','completed')",
    ).run();
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
  });
  it('does not treat indexing or repository existence as documents', () => {
    for (const id of ['one', 'two'])
      db.prepare('INSERT INTO repo_summaries(repo_id,overview) VALUES (?,?)').run(id, 'Indexed');
    fixture.type = 'adr_exists';
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    fixture.type = 'compliance_doc';
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
  });
  it('finds actual nonempty compliance documents in each required repository', () => {
    fixture.type = 'compliance_doc';
    for (const id of ['one', 'two']) {
      mkdirSync(join(root, id, 'docs'));
      writeFileSync(join(root, id, 'docs', 'DPIA.md'), '# DPIA\nA documented assessment.');
    }
    expect(checkReadiness('item', 'gate_1').overall).toBe('green');
    writeFileSync(join(root, 'two', 'docs', 'DPIA.md'), '');
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
  });
  it('supports custom paths, file matching and shared repository documents', () => {
    fixture.type = 'compliance_doc';
    fixture.config = { paths: ['design.md', 'approval.md'], match: 'all', repositories: 'any' };
    writeFileSync(join(root, 'one', 'design.md'), 'Design');
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    writeFileSync(join(root, 'one', 'approval.md'), 'Approval');
    expect(checkReadiness('item', 'gate_1').overall).toBe('green');
    fixture.config.repositories = 'all';
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    fixture.config = { paths: ['missing.md', 'design.md'], match: 'any', repositories: 'any' };
    expect(checkReadiness('item', 'gate_1').overall).toBe('green');
  });
  it('keeps external documents unchecked and reports their reference', () => {
    fixture.type = 'adr_exists';
    fixture.config = { source: 'manual', reference: 'Design link on the Work Item' };
    const readiness = checkReadiness('item', 'gate_1');
    expect(readiness.overall).toBe('red');
    expect(readiness.criteria[0].status).toBe('partial');
    expect(readiness.criteria[0].detail).toContain('Design link on the Work Item');
  });
  it('does not accept parent paths or symlinks outside the repository', () => {
    fixture.type = 'compliance_doc';
    writeFileSync(join(root, 'outside.md'), 'Outside');
    fixture.config = { paths: ['../outside.md'], repositories: 'any' };
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    symlinkSync(join(root, 'outside.md'), join(root, 'one', 'linked.md'));
    fixture.config.paths = ['linked.md'];
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
  });
  it('supports a custom ADR path and ignores empty ADR files', () => {
    fixture.type = 'adr_exists';
    fixture.config = { paths: ['decision.md'], repositories: 'any' };
    writeFileSync(join(root, 'one', 'decision.md'), '');
    expect(checkReadiness('item', 'gate_1').overall).toBe('red');
    writeFileSync(join(root, 'one', 'decision.md'), '# Decision');
    expect(checkReadiness('item', 'gate_1').overall).toBe('green');
  });
});
