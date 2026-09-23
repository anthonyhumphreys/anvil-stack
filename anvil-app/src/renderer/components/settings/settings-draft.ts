import type { AppSettings } from '../../../shared/types';

/**
 * Per-field dirty tracking for Settings (ST1/ST3).
 *
 * The draft holds two copies of the settings object:
 * - `persisted` — last known values in the main-process store.
 * - `draft` — the working copy rendered by the panels.
 *
 * A key is in `dirty` when the draft value differs from what was loaded or
 * last saved. Only an explicit save (or a successful autosave flush) clears
 * keys — instant-save actions such as theme or Anvil Cloud toggles go through
 * `applyExternal`/`saved` for *their* keys and never clear unrelated pending
 * edits, which is the bug the old single `saved` boolean produced.
 */

export interface SettingsDraftState {
  /** False until the initial `settings.get()` resolves (hydrate). */
  loaded: boolean;
  /** Last persisted snapshot (from load or a successful save). */
  persisted: Partial<AppSettings>;
  /** Working copy edited by the UI. */
  draft: Partial<AppSettings>;
  /** Keys whose draft value differs from persisted and haven't been saved. */
  dirty: ReadonlySet<string>;
  /** Keys with a save currently in flight. */
  saving: ReadonlySet<string>;
  /** Keys saved within the recent "tick" window (for inline saved ticks). */
  recentlySaved: ReadonlySet<string>;
}

export type SettingsDraftAction =
  | { type: 'hydrate'; settings: Partial<AppSettings> }
  | { type: 'change'; key: keyof AppSettings; value: AppSettings[keyof AppSettings] }
  | { type: 'save-start'; keys: ReadonlyArray<keyof AppSettings> }
  | { type: 'save-success'; keys: ReadonlyArray<keyof AppSettings> }
  | { type: 'save-failure'; keys: ReadonlyArray<keyof AppSettings> }
  | { type: 'discard'; keys: ReadonlyArray<keyof AppSettings> }
  | { type: 'apply-external'; patch: Partial<AppSettings> }
  | { type: 'tick-expired'; keys: ReadonlyArray<keyof AppSettings> };

export const initialSettingsDraftState: SettingsDraftState = {
  loaded: false,
  persisted: {},
  draft: {},
  dirty: new Set(),
  saving: new Set(),
  recentlySaved: new Set(),
};

function withoutKeys<T>(set: ReadonlySet<T>, keys: Iterable<T>): Set<T> {
  const next = new Set(set);
  for (const key of keys) next.delete(key);
  return next;
}

export function settingsDraftReducer(
  state: SettingsDraftState,
  action: SettingsDraftAction,
): SettingsDraftState {
  switch (action.type) {
    case 'hydrate':
      return {
        loaded: true,
        persisted: action.settings,
        draft: action.settings,
        dirty: new Set(),
        saving: new Set(),
        recentlySaved: new Set(),
      };

    case 'change': {
      const draft: Partial<AppSettings> = { ...state.draft };
      (draft as Record<string, unknown>)[action.key] = action.value;
      const dirty = new Set(state.dirty);
      if (draft[action.key] === state.persisted[action.key]) {
        dirty.delete(action.key);
      } else {
        dirty.add(action.key);
      }
      const recentlySaved = withoutKeys(state.recentlySaved, [action.key]);
      return { ...state, draft, dirty, recentlySaved };
    }

    case 'save-start': {
      const saving = new Set(state.saving);
      for (const key of action.keys) saving.add(key);
      return { ...state, saving };
    }

    case 'save-success': {
      const persisted: Partial<AppSettings> = { ...state.persisted };
      const persistedRecord = persisted as Record<string, unknown>;
      for (const key of action.keys) persistedRecord[key] = state.draft[key];
      const recentlySaved = new Set(state.recentlySaved);
      for (const key of action.keys) recentlySaved.add(key);
      return {
        ...state,
        persisted,
        dirty: withoutKeys(state.dirty, action.keys),
        saving: withoutKeys(state.saving, action.keys),
        recentlySaved,
      };
    }

    case 'save-failure':
      // Keys stay dirty so the caller can retry or the user can discard.
      return { ...state, saving: withoutKeys(state.saving, action.keys) };

    case 'discard': {
      const draft: Partial<AppSettings> = { ...state.draft };
      const draftRecord = draft as Record<string, unknown>;
      for (const key of action.keys) {
        const persistedValue = state.persisted[key];
        if (persistedValue === undefined) delete draftRecord[key];
        else draftRecord[key] = persistedValue;
      }
      return {
        ...state,
        draft,
        dirty: withoutKeys(state.dirty, action.keys),
        saving: withoutKeys(state.saving, action.keys),
        recentlySaved: withoutKeys(state.recentlySaved, action.keys),
      };
    }

    case 'apply-external': {
      // Instant-save actions (theme, cloud features, LLMGateway connect) merge
      // into the persisted snapshot and the draft — except keys the user is
      // mid-edit on, which keep their unsaved draft value.
      const persisted = { ...state.persisted, ...action.patch };
      const draft: Partial<AppSettings> = { ...state.draft };
      const draftRecord = draft as Record<string, unknown>;
      for (const key of Object.keys(action.patch) as Array<keyof AppSettings>) {
        if (!state.dirty.has(key)) draftRecord[key] = action.patch[key];
      }
      return { ...state, persisted, draft };
    }

    case 'tick-expired':
      return { ...state, recentlySaved: withoutKeys(state.recentlySaved, action.keys) };
  }
}

/** Pick a subset of an AppSettings object by key. */
export function pickSettingsKeys(
  source: Partial<AppSettings>,
  keys: Iterable<keyof AppSettings>,
): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  const outRecord = out as Record<string, unknown>;
  for (const key of keys) {
    if (key in source) outRecord[key] = source[key];
  }
  return out;
}
