import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import { getGateTemplates, resetGateTemplates, updateGateTemplate } from '../lifecycle.service.js';

function seedWorkspace(workspaceId: string): void {
  inMemoryDb
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(workspaceId, 'Workspace');
}

function insertGateTemplate(
  workspaceId: string,
  gate: string,
  label: string,
  criteria: Array<Record<string, unknown>>,
): void {
  inMemoryDb
    .prepare(
      `INSERT INTO gate_templates (id, workspace_id, gate, label, criteria)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`template-${workspaceId}-${gate}`, workspaceId, gate, label, JSON.stringify(criteria));
}

beforeEach(() => {
  inMemoryDb.exec('DELETE FROM gate_templates');
  inMemoryDb.exec('DELETE FROM lifecycle_items');
  inMemoryDb.exec('DELETE FROM workspaces');
});

describe('gate templates', () => {
  it('creates blank gate templates for a workspace by default', () => {
    seedWorkspace('ws-blank');

    const templates = getGateTemplates('ws-blank');

    expect(templates).toHaveLength(4);
    expect(templates.map((template) => template.gate)).toEqual([
      'gate_1',
      'gate_2',
      'gate_3',
      'gate_4',
    ]);
    expect(templates.every((template) => template.label === '')).toBe(true);
    expect(templates.every((template) => template.criteria.length === 0)).toBe(true);
  });

  it('persists user-configured gate labels and criteria', () => {
    seedWorkspace('ws-configured');

    const updated = updateGateTemplate('ws-configured', 'gate_2', {
      label: 'Risk review',
      criteria: [
        {
          id: 'criterion-1',
          type: 'manual_approval',
          label: 'Risk owner approval',
          required: true,
        },
      ],
    });

    expect(updated.label).toBe('Risk review');
    expect(updated.criteria).toEqual([
      {
        id: 'criterion-1',
        type: 'manual_approval',
        label: 'Risk owner approval',
        required: true,
      },
    ]);
  });

  it('clears gate templates back to blank records', () => {
    seedWorkspace('ws-clear');
    updateGateTemplate('ws-clear', 'gate_4', {
      label: 'Release approval',
      criteria: [
        {
          id: 'criterion-1',
          type: 'handover_pack',
          label: 'Handover pack reviewed',
          required: true,
        },
      ],
    });

    const templates = resetGateTemplates('ws-clear');

    expect(templates).toHaveLength(4);
    expect(templates.every((template) => template.label === '')).toBe(true);
    expect(templates.every((template) => template.criteria.length === 0)).toBe(true);
  });

  it('migration 29 clears shipped defaults without touching custom templates', () => {
    seedWorkspace('ws-migration');
    insertGateTemplate('ws-migration', 'gate_1', 'Proceed to Ideation', [
      {
        id: 'criterion-1',
        type: 'governance_document',
        label: 'Business Vision document',
        required: true,
      },
      {
        id: 'criterion-2',
        type: 'manual_approval',
        label: 'Steering approval',
        required: true,
      },
    ]);
    insertGateTemplate('ws-migration', 'gate_2', 'Custom review', [
      {
        id: 'criterion-3',
        type: 'manual_approval',
        label: 'Product approval',
        required: true,
      },
    ]);

    inMemoryDb.exec(MIGRATIONS[29]);

    const templates = getGateTemplates('ws-migration');
    const cleared = templates.find((template) => template.gate === 'gate_1');
    const custom = templates.find((template) => template.gate === 'gate_2');

    expect(cleared?.label).toBe('');
    expect(cleared?.criteria).toEqual([]);
    expect(custom?.label).toBe('Custom review');
    expect(custom?.criteria).toHaveLength(1);
  });
});
