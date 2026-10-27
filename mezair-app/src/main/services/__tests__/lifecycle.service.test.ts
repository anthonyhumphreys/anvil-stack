import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, SCHEMA_SQL } from '../../db/schema.js';

const inMemoryDb = new Database(':memory:');
inMemoryDb.exec(SCHEMA_SQL);

vi.mock('../../db/database.js', () => ({
  getDb: () => inMemoryDb,
}));

import {
  createItem,
  listLifecycleStages,
  resetGateTemplates,
  resetLifecycleStages,
  updateGateTemplate,
  updateItem,
  updateLifecycleStages,
  getGateTemplates,
} from '../lifecycle.service.js';

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
  inMemoryDb.exec('DELETE FROM lifecycle_stages');
  inMemoryDb.exec('DELETE FROM gate_templates');
  inMemoryDb.exec('DELETE FROM lifecycle_items');
  inMemoryDb.exec('DELETE FROM workspaces');
});

describe('lifecycle stages', () => {
  it('creates neutral default stages for a workspace', () => {
    seedWorkspace('ws-stages');

    const stages = listLifecycleStages('ws-stages');

    expect(stages).toEqual([
      { id: 'concept', label: 'Concept', order: 0 },
      { id: 'shape', label: 'Shape', order: 1 },
      { id: 'deliver', label: 'Deliver', order: 2 },
      { id: 'operate', label: 'Operate', order: 3 },
    ]);
  });

  it('persists workspace-defined stages and uses the first stage for new items', () => {
    seedWorkspace('ws-custom-stages');
    updateLifecycleStages('ws-custom-stages', [
      { id: 'triage', label: 'Triage' },
      { id: 'implementation', label: 'Implementation' },
      { id: 'operate', label: 'Operate' },
    ]);

    const item = createItem('ws-custom-stages', { title: 'Custom lifecycle item' });

    expect(listLifecycleStages('ws-custom-stages')).toEqual([
      { id: 'triage', label: 'Triage', order: 0 },
      { id: 'implementation', label: 'Implementation', order: 1 },
      { id: 'operate', label: 'Operate', order: 2 },
    ]);
    expect(item.stage).toBe('triage');
  });

  it('validates forward-only transitions against workspace-defined stage order', () => {
    seedWorkspace('ws-stage-order');
    updateLifecycleStages('ws-stage-order', [
      { id: 'triage', label: 'Triage' },
      { id: 'implementation', label: 'Implementation' },
      { id: 'operate', label: 'Operate' },
    ]);
    const item = createItem('ws-stage-order', { title: 'Stage order item' });

    const updated = updateItem(item.id, { stage: 'implementation' });

    expect(updated.stage).toBe('implementation');
    expect(() => updateItem(item.id, { stage: 'triage' })).toThrow(/forward-only/);
  });

  it('does not remove a stage that still has lifecycle items', () => {
    seedWorkspace('ws-active-stage');
    const item = createItem('ws-active-stage', { title: 'Active stage item' });

    expect(item.stage).toBe('concept');
    expect(() =>
      updateLifecycleStages('ws-active-stage', [
        { id: 'implementation', label: 'Implementation' },
        { id: 'operate', label: 'Operate' },
      ]),
    ).toThrow(/existing items/);
  });

  it('resets stages to the neutral defaults', () => {
    seedWorkspace('ws-reset-stages');
    updateLifecycleStages('ws-reset-stages', [
      { id: 'triage', label: 'Triage' },
      { id: 'implementation', label: 'Implementation' },
    ]);

    const stages = resetLifecycleStages('ws-reset-stages');

    expect(stages.map((stage) => stage.id)).toEqual(['concept', 'shape', 'deliver', 'operate']);
  });
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

  it('migration 29 clears existing gate template labels and criteria', () => {
    seedWorkspace('ws-migration');
    insertGateTemplate('ws-migration', 'gate_1', 'Configured gate', [
      {
        id: 'criterion-1',
        type: 'manual_approval',
        label: 'Approval',
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
    const alsoCleared = templates.find((template) => template.gate === 'gate_2');

    expect(cleared?.label).toBe('');
    expect(cleared?.criteria).toEqual([]);
    expect(alsoCleared?.label).toBe('');
    expect(alsoCleared?.criteria).toEqual([]);
  });
});
