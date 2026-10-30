import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import { constrainPermissionMode, PERMISSION_MODES } from '../../../../cloud/contract/permissions';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
import {
  effectiveMeshPermissionMode,
  requestedMeshPermissionMode,
} from '../mesh-permissions.service';

beforeEach(() => db.exec('DELETE FROM mesh_worker_state'));

describe('running mode authorization', () => {
  it.each(PERMISSION_MODES)('never broadens a requested %s mode', (requested) => {
    for (const maximum of PERMISSION_MODES) {
      const effective = constrainPermissionMode(requested, maximum);
      expect(PERMISSION_MODES.indexOf(effective)).toBeLessThanOrEqual(
        PERMISSION_MODES.indexOf(requested),
      );
      expect(PERMISSION_MODES.indexOf(effective)).toBeLessThanOrEqual(
        PERMISSION_MODES.indexOf(maximum),
      );
    }
  });
  it('defaults old nodes and workspace-write jobs to approval mode', () => {
    expect(requestedMeshPermissionMode({ sandbox: 'workspace-write' })).toBe('on-request');
    expect(effectiveMeshPermissionMode({ sandbox: 'danger-full-access' })).toBe('on-request');
  });
  it('uses the local ceiling even when source inputs request full access', () => {
    db.prepare(
      "INSERT INTO mesh_worker_state (id, enabled, max_permission_mode, updated_at) VALUES (1, 1, 'read-only', datetime('now'))",
    ).run();
    expect(
      effectiveMeshPermissionMode({
        permissionMode: 'full-access',
        maxPermissionMode: 'full-access',
      }),
    ).toBe('read-only');
  });
  it('rejects an unknown requested mode', () => {
    expect(() => effectiveMeshPermissionMode({ permissionMode: 'unrestricted' })).toThrow(
      'invalid-job-permission-mode',
    );
  });
});
