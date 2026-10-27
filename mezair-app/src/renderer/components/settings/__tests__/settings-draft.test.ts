import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../../shared/types';
import {
  initialSettingsDraftState,
  pickSettingsKeys,
  settingsDraftReducer,
  type SettingsDraftState,
} from '../settings-draft';

const hydrated = (settings: Partial<AppSettings>): SettingsDraftState =>
  settingsDraftReducer(initialSettingsDraftState, { type: 'hydrate', settings });

describe('settingsDraftReducer', () => {
  it('hydrates clean — the badge never opens as "Unsaved changes" (ST3)', () => {
    const state = hydrated({ theme: 'dark', adoPat: 'pat' });
    expect(state.loaded).toBe(true);
    expect(state.dirty.size).toBe(0);
    expect(state.draft).toEqual({ theme: 'dark', adoPat: 'pat' });
  });

  it('marks only the edited key dirty', () => {
    let state = hydrated({ theme: 'dark' });
    state = settingsDraftReducer(state, { type: 'change', key: 'reasoningLevel', value: 'high' });
    expect(state.dirty.has('reasoningLevel')).toBe(true);
    expect(state.dirty.has('theme')).toBe(false);
  });

  it('clears a key when the draft value returns to the persisted one', () => {
    let state = hydrated({ reasoningLevel: 'medium' });
    state = settingsDraftReducer(state, { type: 'change', key: 'reasoningLevel', value: 'high' });
    state = settingsDraftReducer(state, { type: 'change', key: 'reasoningLevel', value: 'medium' });
    expect(state.dirty.size).toBe(0);
  });

  it('save-success clears only the saved keys (ST1)', () => {
    let state = hydrated({ theme: 'dark' });
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'new-pat' });
    state = settingsDraftReducer(state, { type: 'change', key: 'reasoningLevel', value: 'high' });
    state = settingsDraftReducer(state, { type: 'save-start', keys: ['reasoningLevel'] });
    state = settingsDraftReducer(state, {
      type: 'save-success',
      patch: { reasoningLevel: 'high' },
    });

    expect(state.dirty.has('reasoningLevel')).toBe(false);
    expect(state.dirty.has('adoPat')).toBe(true); // unrelated pending edit survives
    expect(state.persisted.reasoningLevel).toBe('high');
    expect(state.persisted.adoPat).toBeUndefined();
    expect(state.recentlySaved.has('reasoningLevel')).toBe(true);
  });

  it('an instant-save action merges without clearing unrelated dirty keys (ST1)', () => {
    let state = hydrated({ theme: 'dark' });
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'half-typed' });
    state = settingsDraftReducer(state, {
      type: 'apply-external',
      patch: { theme: 'light', cloudFeaturesEnabled: true },
    });

    expect(state.dirty.has('adoPat')).toBe(true);
    expect(state.persisted.theme).toBe('light');
    expect(state.draft.theme).toBe('light');
    expect(state.draft.adoPat).toBe('half-typed');
  });

  it('apply-external does not clobber a key the user is mid-edit on', () => {
    let state = hydrated({ theme: 'dark' });
    state = settingsDraftReducer(state, { type: 'change', key: 'theme', value: 'light' });
    state = settingsDraftReducer(state, {
      type: 'apply-external',
      patch: { theme: 'merge-conflict' },
    });
    expect(state.persisted.theme).toBe('merge-conflict');
    expect(state.draft.theme).toBe('light');
    expect(state.dirty.has('theme')).toBe(true);
  });

  it('save-failure keeps keys dirty so the edit is not lost', () => {
    let state = hydrated({});
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'pat' });
    state = settingsDraftReducer(state, { type: 'save-start', keys: ['adoPat'] });
    state = settingsDraftReducer(state, { type: 'save-failure', keys: ['adoPat'] });
    expect(state.dirty.has('adoPat')).toBe(true);
    expect(state.saving.size).toBe(0);
  });

  it('discard restores persisted values and clears dirty state (ST5)', () => {
    let state = hydrated({ adoPat: 'old', linearApiKey: 'lin' });
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'new' });
    state = settingsDraftReducer(state, { type: 'change', key: 'linearApiKey', value: '' });
    state = settingsDraftReducer(state, { type: 'discard', keys: ['adoPat', 'linearApiKey'] });
    expect(state.draft.adoPat).toBe('old');
    expect(state.draft.linearApiKey).toBe('lin');
    expect(state.dirty.size).toBe(0);
  });

  it('keeps edits made during a save dirty and records only the submitted snapshot', () => {
    let state = hydrated({ adoPat: 'old' });
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'submitted' });
    state = settingsDraftReducer(state, { type: 'save-start', keys: ['adoPat'] });
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: 'newer edit' });
    state = settingsDraftReducer(state, { type: 'save-success', patch: { adoPat: 'submitted' } });
    expect(state.persisted.adoPat).toBe('submitted');
    expect(state.draft.adoPat).toBe('newer edit');
    expect(state.dirty.has('adoPat')).toBe(true);
    expect(state.recentlySaved.has('adoPat')).toBe(false);
  });

  it('recognises reverted nested connection edits and preserves an explicit clear', () => {
    const connections = [{ id: 'linear', name: 'Linear', provider: 'linear' as const }];
    let state = hydrated({ workItemConnections: connections, adoPat: 'masked' });
    state = settingsDraftReducer(state, {
      type: 'change',
      key: 'workItemConnections',
      value: [{ ...connections[0] }],
    });
    expect(state.dirty.size).toBe(0);
    state = settingsDraftReducer(state, { type: 'change', key: 'adoPat', value: undefined });
    expect(pickSettingsKeys(state.draft, ['adoPat'])).toEqual({ adoPat: undefined });
    expect(Object.keys(pickSettingsKeys(state.draft, ['adoPat']))).toEqual(['adoPat']);
  });

  it('tick-expired clears the inline saved indicator only', () => {
    let state = hydrated({});
    state = settingsDraftReducer(state, { type: 'change', key: 'theme', value: 'dark' });
    state = settingsDraftReducer(state, { type: 'save-success', patch: { theme: 'dark' } });
    expect(state.recentlySaved.has('theme')).toBe(true);
    state = settingsDraftReducer(state, { type: 'tick-expired', keys: ['theme'] });
    expect(state.recentlySaved.size).toBe(0);
    expect(state.persisted.theme).toBe('dark');
  });
});

describe('pickSettingsKeys', () => {
  it('saves only the requested subset', () => {
    const draft: Partial<AppSettings> = { adoPat: 'pat', theme: 'dark', jiraApiToken: 'tok' };
    expect(pickSettingsKeys(draft, ['adoPat', 'jiraApiToken'])).toEqual({
      adoPat: 'pat',
      jiraApiToken: 'tok',
    });
  });

  it('omits keys absent from the draft', () => {
    const draft: Partial<AppSettings> = { theme: 'dark' };
    expect(pickSettingsKeys(draft, ['theme', 'adoPat'])).toEqual({ theme: 'dark' });
  });
});
