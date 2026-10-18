import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_SQL } from '../../db/schema';
import type { ModelPickerPreferences } from '../../../shared/model-picker';

const db = new Database(':memory:');
db.exec(SCHEMA_SQL);
vi.mock('../../db/database.js', () => ({ getDb: () => db }));
vi.mock('../auth.service.js', () => ({
  decryptSecret: () => undefined,
  readStoredSecret: () => ({ state: 'not-configured' }),
  encryptSecret: (value: string) => Buffer.from(value),
}));
import { getSettings, updateSettings } from '../settings.service';

beforeEach(() => {
  db.exec('DELETE FROM settings; INSERT INTO settings (id) VALUES (1)');
});
afterAll(() => db.close());

describe('persisted model picker preferences', () => {
  it('round-trips cross-provider presets without changing the current model', () => {
    const preferences: ModelPickerPreferences = {
      style: 'slider',
      presets: [
        { id: 'quick', label: 'Quick', provider: 'cursor', model: 'auto' },
        {
          id: 'deep',
          label: 'Deep work',
          provider: 'llmgateway',
          model: 'vendor/model',
          reasoningEffort: 'high',
        },
      ],
    };
    const original = getSettings();
    updateSettings({ modelPicker: preferences });
    expect(getSettings().modelPicker).toEqual(preferences);
    expect(getSettings().openaiModel).toBe(original.openaiModel);
    updateSettings({ modelPicker: { ...preferences, style: 'dropdown' } });
    expect(getSettings().modelPicker).toEqual({ ...preferences, style: 'dropdown' });
  });

  it('recovers from corrupt persisted settings', () => {
    db.prepare('UPDATE settings SET model_picker = ?').run('{invalid');
    expect(getSettings().modelPicker).toEqual({ style: 'dropdown', presets: [] });
  });
});
