import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AppSettings } from '../../../shared/types';
import {
  initialSettingsDraftState,
  pickSettingsKeys,
  settingsDraftReducer,
  type SettingsDraftAction,
} from './settings-draft';

/**
 * Debounce for autosaving simple fields (ST3). Credential-form keys never
 * autosave — they wait for an explicit panel Save (or a Test that saves only
 * its own panel's fields first, ST2).
 */
export const SETTINGS_AUTOSAVE_DELAY_MS = 600;

/** How long the inline "Saved" tick stays visible after a successful write. */
export const SETTINGS_SAVED_TICK_MS = 2500;

/**
 * Keys that are only persisted by an explicit per-panel save. These belong to
 * credential forms (delivery integrations, provider API keys) whose values
 * should not leak to disk until the user commits — and whose Test buttons save
 * just their own panel's fields.
 */
export const CREDENTIAL_SETTING_KEYS: ReadonlySet<keyof AppSettings> = new Set([
  'openaiApiKey',
  'llmGatewayApiKey',
  'llmGatewayBillingMode',
  'githubPat',
  'githubUsername',
  'workItemProvider',
  'workItemConnections',
  'activeWorkItemConnectionId',
  'adoOrganizationUrl',
  'adoProject',
  'adoTeam',
  'adoPat',
  'linearApiKey',
  'linearTeamId',
  'jiraHost',
  'jiraAuthMode',
  'jiraProject',
  'jiraBoardId',
  'jiraAcceptanceCriteriaField',
  'jiraEmail',
  'jiraApiToken',
  'docsProvider',
  'confluenceBaseUrl',
  'confluenceSpaceKey',
  'confluencePat',
  'notionOauthToken',
  'notionOauthExpiry',
  'notionDatabaseId',
  'foundryEndpoint',
  'foundryDeploymentName',
  'foundryApiVersion',
  'foundryApiKey',
]);

export type SettingsSaveMode = 'auto' | 'manual';

export interface UseSettingsDraftOptions {
  /** Called after any successful persistence (autosave flush or manual save). */
  onSaved?: (keys: ReadonlyArray<keyof AppSettings>) => void;
  /** Called when a persistence attempt fails. */
  onError?: (message: string) => void;
}

export interface SettingsDraft {
  /** Working copy rendered by the panels. */
  settings: Partial<AppSettings>;
  /** Last persisted snapshot — the baseline dirty keys diff against. */
  persisted: Partial<AppSettings>;
  /** False until the initial `settings.get()` resolves. */
  loaded: boolean;
  /** Keys with unsaved changes — the single source of the header badge (ST3). */
  dirtyKeys: ReadonlySet<string>;
  /** Keys with a save currently in flight. */
  savingKeys: ReadonlySet<string>;
  /** Keys saved within the recent tick window (inline "Saved" indicators). */
  recentlySavedKeys: ReadonlySet<string>;
  /** True while any save (auto or manual) is in flight. */
  saving: boolean;
  isDirty: (key: keyof AppSettings) => boolean;
  isSaving: (key: keyof AppSettings) => boolean;
  wasRecentlySaved: (key: keyof AppSettings) => boolean;
  /**
   * Edit a field. `auto` (the default for non-credential keys) schedules a
   * debounced write of just that key; `manual` marks the key dirty and waits
   * for an explicit `saveKeys`.
   */
  update: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
    mode?: SettingsSaveMode,
  ) => void;
  /** Update several keys at once (e.g. switching the active connection). */
  updateMany: (patch: Partial<AppSettings>, mode?: SettingsSaveMode) => void;
  /** Persist the given keys; clears only those dirty flags on success. */
  saveKeys: (keys: Iterable<keyof AppSettings>) => Promise<boolean>;
  /** Persist every dirty key (credential panels' explicit Save). */
  saveAllDirty: (keys?: Iterable<keyof AppSettings>) => Promise<boolean>;
  /** Reset the given keys to their persisted values and clear their dirty flags. */
  discardKeys: (keys: Iterable<keyof AppSettings>) => void;
  /**
   * Merge values that were already persisted by an instant action (theme
   * picker, Anvil Cloud toggle, LLMGateway connect). Never touches unrelated
   * dirty keys (ST1).
   */
  applyPersisted: (patch: Partial<AppSettings>) => void;
  /** Flush pending autosave writes immediately (e.g. before a connection test). */
  flushAutosave: () => Promise<boolean>;
  saveInstant: (patch: Partial<AppSettings>) => Promise<boolean>;
}

export function useSettingsDraft(options?: UseSettingsDraftOptions): SettingsDraft {
  const [state, reactDispatch] = useReducer(settingsDraftReducer, initialSettingsDraftState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback((action: SettingsDraftAction) => {
    stateRef.current = settingsDraftReducer(stateRef.current, action);
    reactDispatch(action);
  }, []);
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const pendingAutosaveRef = useRef<Set<keyof AppSettings>>(new Set());
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.anvil.settings
      .get()
      .then((settings) => {
        if (cancelled) return;
        dispatch({ type: 'hydrate', settings });
      })
      .catch((error) => {
        optionsRef.current?.onError?.(
          error instanceof Error ? error.message : 'Failed to load settings',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  const scheduleTickExpiry = useCallback(() => {
    if (tickTimerRef.current) clearTimeout(tickTimerRef.current);
    tickTimerRef.current = setTimeout(() => {
      tickTimerRef.current = null;
      dispatch({
        type: 'tick-expired',
        keys: [...stateRef.current.recentlySaved] as Array<keyof AppSettings>,
      });
    }, SETTINGS_SAVED_TICK_MS);
  }, [dispatch]);

  const persistPatch = useCallback(
    async (patch: Partial<AppSettings>, instant: boolean) => {
      const keys = Object.keys(patch) as Array<keyof AppSettings>;
      if (keys.length === 0) return true;
      dispatch({ type: 'save-start', keys });
      try {
        await window.anvil.settings.update(patch);
      } catch (error) {
        dispatch({ type: 'save-failure', keys });
        optionsRef.current?.onError?.(
          error instanceof Error
            ? error.message
            : 'Failed to save settings. Your edits are retained; try again.',
        );
        return false;
      }
      if (instant) {
        dispatch({ type: 'apply-external', patch });
        dispatch({ type: 'save-failure', keys });
      } else dispatch({ type: 'save-success', patch });
      scheduleTickExpiry();
      optionsRef.current?.onSaved?.(keys);
      return true;
    },
    [dispatch, scheduleTickExpiry],
  );

  const saveKeys = useCallback(
    (keys: Iterable<keyof AppSettings>): Promise<boolean> => {
      const requested = [...new Set(keys)];
      for (const key of requested) pendingAutosaveRef.current.delete(key);
      const task = saveQueueRef.current.then(() => {
        const changed = requested.filter((key) => stateRef.current.dirty.has(key));
        return persistPatch(pickSettingsKeys(stateRef.current.draft, changed), false);
      });
      saveQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [persistPatch],
  );

  const saveInstant = useCallback(
    (patch: Partial<AppSettings>): Promise<boolean> => {
      const task = saveQueueRef.current.then(() => persistPatch(patch, true));
      saveQueueRef.current = task.catch(() => undefined);
      return task;
    },
    [persistPatch],
  );

  const flushAutosave = useCallback(async (): Promise<boolean> => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const pending = [...pendingAutosaveRef.current];
    pendingAutosaveRef.current.clear();
    return pending.length === 0 || (await saveKeys(pending));
  }, [saveKeys]);

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K], mode?: SettingsSaveMode) => {
      dispatch({ type: 'change', key, value });
      const saveMode = mode ?? (CREDENTIAL_SETTING_KEYS.has(key) ? 'manual' : 'auto');
      if (saveMode !== 'auto') return;
      pendingAutosaveRef.current.add(key);
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        const pending = [...pendingAutosaveRef.current];
        pendingAutosaveRef.current.clear();
        void saveKeys(pending);
      }, SETTINGS_AUTOSAVE_DELAY_MS);
    },
    [saveKeys, dispatch],
  );

  const updateMany = useCallback(
    (patch: Partial<AppSettings>, mode?: SettingsSaveMode) => {
      for (const key of Object.keys(patch) as Array<keyof AppSettings>) {
        update(key, patch[key] as AppSettings[typeof key], mode);
      }
    },
    [update],
  );

  const discardKeys = useCallback(
    (keys: Iterable<keyof AppSettings>) => {
      const keyList = [...keys];
      for (const key of keyList) pendingAutosaveRef.current.delete(key);
      dispatch({ type: 'discard', keys: keyList });
    },
    [dispatch],
  );

  const applyPersisted = useCallback(
    (patch: Partial<AppSettings>) => {
      dispatch({ type: 'apply-external', patch });
      scheduleTickExpiry();
      optionsRef.current?.onSaved?.(Object.keys(patch) as Array<keyof AppSettings>);
    },
    [dispatch, scheduleTickExpiry],
  );

  const saveAllDirty = useCallback(
    async (keys?: Iterable<keyof AppSettings>) => {
      const targets = keys ? [...keys] : [...stateRef.current.dirty];
      return saveKeys(targets as Array<keyof AppSettings>);
    },
    [saveKeys],
  );

  useEffect(
    () => () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (tickTimerRef.current) clearTimeout(tickTimerRef.current);
    },
    [],
  );

  return {
    settings: state.draft,
    persisted: state.persisted,
    loaded: state.loaded,
    dirtyKeys: state.dirty,
    savingKeys: state.saving,
    recentlySavedKeys: state.recentlySaved,
    saving: state.saving.size > 0,
    isDirty: (key) => state.dirty.has(key),
    isSaving: (key) => state.saving.has(key),
    wasRecentlySaved: (key) => state.recentlySaved.has(key),
    update,
    updateMany,
    saveKeys,
    saveAllDirty,
    discardKeys,
    applyPersisted,
    flushAutosave,
    saveInstant,
  };
}
