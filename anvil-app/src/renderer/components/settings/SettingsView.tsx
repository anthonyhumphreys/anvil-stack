import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle, Loader2, Save, Search, Settings, X } from 'lucide-react';
import type { AppSettings, AppTheme, UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { InlineNotice } from '../layout/ViewScaffold';
import { RoleHiddenNotice } from '../shared/RoleHiddenNotice';
import { Button, ConfirmDialog, cx } from '../ui';
import { SettingsContextProvider } from './SettingsContext';
import { useSettingsDraft, CREDENTIAL_SETTING_KEYS } from './useSettingsDraft';
import {
  SETTINGS_CATEGORIES,
  getSettingsCategory,
  resolveSettingsCategoryId,
} from './settings-registry';
import { parseSettingsLocation, settingsPanelDomId } from './settings-route';
import { searchSettings } from './settings-search';

/**
 * Settings shell (ST3/ST4/ST6/ST7).
 *
 * - One lazily-mounted component per category from `settings-registry`; hidden
 *   categories no longer mount at all.
 * - Deep-linkable: `/settings/:category#panel` (route param lands via the
 *   integration pass; `?category=` works today) — see `settings-route.ts`.
 * - Save state derives from the draft's per-field `dirtyKeys`; the badge can
 *   never claim "Saved" while unrelated edits are pending (ST1/ST3).
 * - Switching away from a category with unsaved credential edits asks first
 *   (ST5); simple fields autosave so there is nothing to lose.
 */

interface SettingsViewProps {
  onSettingsSaved?: () => void;
  onRoleChange?: (role: UserRole) => void;
  onThemeChange?: (theme: AppTheme) => void;
  onPreviewOnboarding?: () => void;
  userRole?: UserRole;
  /** Controlled category override (e.g. a route param passed down by App.tsx). */
  category?: string;
}

export function SettingsView({
  onSettingsSaved,
  onRoleChange,
  onThemeChange,
  onPreviewOnboarding,
  userRole,
  category: categoryProp,
}: SettingsViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [activeCategory, setActiveCategory] = useState<string>(() => {
    const fromLocation = parseSettingsLocation(
      location.pathname,
      location.search,
      location.hash,
    ).category;
    return categoryProp ?? fromLocation ?? 'profile';
  });
  const [pendingPanel, setPendingPanel] = useState<string | null>(
    () => parseSettingsLocation(location.pathname, location.search, location.hash).panel ?? null,
  );
  const [statusError, setStatusError] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const draft = useSettingsDraft({
    onSaved: () => onSettingsSaved?.(),
    onError: (message) => setStatusError(message),
  });

  // React to deep links: `/settings/:category#panel` (or `?category=` until
  // the param route lands in App.tsx).
  useEffect(() => {
    const parsed = parseSettingsLocation(location.pathname, location.search, location.hash);
    const target = categoryProp ?? parsed.category;
    if (target && target !== activeCategory) setActiveCategory(target);
    if (parsed.panel) setPendingPanel(parsed.panel);
  }, [location.pathname, location.search, location.hash, categoryProp, activeCategory]);

  // Scroll to a deep-linked panel once its (lazy) category has mounted —
  // retry on frames for a short window since Suspense resolves async.
  useEffect(() => {
    if (!pendingPanel) return;
    let frame = 0;
    const deadline = Date.now() + 2000;
    const tryScroll = () => {
      const element = document.getElementById(settingsPanelDomId(pendingPanel));
      if (element) {
        element.scrollIntoView({ block: 'start' });
        setPendingPanel(null);
        return;
      }
      if (Date.now() < deadline) frame = requestAnimationFrame(tryScroll);
    };
    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }, [pendingPanel, activeCategory]);

  // ⌘F / Ctrl+F focuses the settings search (ST7).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Warn before closing the window with unsaved credential edits (ST5).
  const activeCredentialKeys = useMemo(
    () => getSettingsCategory(activeCategory)?.credentialKeys ?? [],
    [activeCategory],
  );
  const dirtyCredentials = useMemo(
    () =>
      [...draft.dirtyKeys].filter(
        (key): key is keyof AppSettings =>
          CREDENTIAL_SETTING_KEYS.has(key as keyof AppSettings) &&
          activeCredentialKeys.includes(key as keyof AppSettings),
      ),
    [draft.dirtyKeys, activeCredentialKeys],
  );
  useEffect(() => {
    if (draft.dirtyKeys.size === 0) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [draft.dirtyKeys.size]);

  const commitCategory = useCallback(
    (id: string, panel?: string) => {
      setActiveCategory(id);
      if (panel) setPendingPanel(panel);
      // Reflect the deep link in the URL — `/settings/:category?` is routed in
      // App.tsx, so every category switch is addressable.
      navigate(`/settings/${id}${panel ? `#${panel}` : ''}`);
    },
    [navigate],
  );

  const selectCategory = useCallback(
    (id: string, panel?: string) => {
      if (id === activeCategory) {
        if (panel) setPendingPanel(panel);
        return;
      }
      if (dirtyCredentials.length > 0) {
        setDiscardTarget(panel ? `${id}#${panel}` : id);
        return;
      }
      commitCategory(id, panel);
    },
    [activeCategory, dirtyCredentials.length, commitCategory],
  );

  const searchResults = useMemo(() => searchSettings(searchQuery), [searchQuery]);

  const activeMeta = getSettingsCategory(activeCategory) ?? SETTINGS_CATEGORIES[0];
  const ActiveComponent = activeMeta.component;
  // ST8: a category wholly backed by a role-gated feature shows an explanatory
  // notice instead of its panels — "Show anyway" enables the Show all tools
  // setting; "Change role" deep-links to the profile panel.
  const categoryHiddenByRole =
    activeMeta.feature !== undefined &&
    !draft.settings.showAllTools &&
    (!userRole || !ROLE_FEATURES[userRole].includes(activeMeta.feature));
  const dirtyCount = draft.dirtyKeys.size;
  const allSaved = draft.loaded && dirtyCount === 0;
  const saveStateLabel = draft.saving
    ? 'Saving…'
    : !draft.loaded
      ? 'Loading…'
      : dirtyCount === 0
        ? 'All changes saved'
        : `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`;

  const categoryDescription = (id: string): string => {
    // Keep the live delivery summary from the old layout.
    if (id === 'delivery') {
      const active = (draft.settings.workItemConnections ?? []).find(
        (connection) => connection.id === draft.settings.activeWorkItemConnectionId,
      );
      return [
        active?.name ?? 'No work items',
        (draft.settings.docsProvider ?? 'confluence') === 'none'
          ? 'No docs'
          : (draft.settings.docsProvider ?? 'confluence'),
        draft.settings.adoPat || draft.settings.adoOrganizationUrl ? 'ADO Git' : 'GitHub',
      ].join(' / ');
    }
    return activeMeta.description;
  };

  return (
    <SettingsContextProvider
      value={{
        draft,
        userRole,
        onSettingsSaved,
        onRoleChange,
        onThemeChange,
        onPreviewOnboarding,
        reportError: setStatusError,
      }}
    >
      <div className="h-full overflow-auto p-4 md:p-6">
        <div className="mx-auto max-w-7xl space-y-5">
          <header className="border-b border-border pb-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <Settings size={18} className="shrink-0 text-accent" />
                  <div>
                    <h1 className="text-base font-semibold text-text-primary">Settings</h1>
                    <p className="text-sm text-text-secondary">
                      Configure identity, AI backends, delivery tools, and local devices.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <div className="relative">
                  <Search
                    size={13}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                  />
                  <input
                    ref={searchInputRef}
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setSearchQuery('');
                    }}
                    placeholder="Search settings (⌘F)"
                    aria-label="Search settings"
                    className="w-56 rounded-md border border-border bg-bg-secondary py-1.5 pl-8 pr-7 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      aria-label="Clear settings search"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <span
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                    allSaved
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-border-subtle bg-bg-primary text-text-tertiary',
                  )}
                >
                  {draft.saving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : allSaved ? (
                    <CheckCircle size={12} />
                  ) : (
                    <Save size={12} />
                  )}
                  {saveStateLabel}
                </span>
                {dirtyCount > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={draft.saving}
                    onClick={() => void draft.saveAllDirty()}
                  >
                    Save all
                  </Button>
                )}
              </div>
            </div>

            {statusError && (
              <InlineNotice tone="error" className="mt-4">
                {statusError}
              </InlineNotice>
            )}
          </header>

          {searchQuery.trim() !== '' && (
            <div
              className="rounded-lg border border-border bg-bg-secondary p-2"
              role="listbox"
              aria-label="Settings search results"
            >
              {searchResults.length === 0 ? (
                <p className="px-3 py-2 text-sm text-text-tertiary">
                  No settings match &ldquo;{searchQuery.trim()}&rdquo;.
                </p>
              ) : (
                searchResults.map((result) => (
                  <button
                    key={`${result.category.id}:${result.panel?.id ?? 'category'}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      selectCategory(result.category.id, result.panel?.id);
                      setSearchQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-tertiary"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-primary">
                        {result.panel?.title ?? result.category.label}
                      </span>
                      {result.panel?.description && (
                        <span className="block truncate text-xs text-text-tertiary">
                          {result.panel.description}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-text-tertiary">{result.breadcrumb}</span>
                  </button>
                ))
              )}
            </div>
          )}

          <nav className="flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="Settings sections">
            {SETTINGS_CATEGORIES.map((category) => {
              const Icon = category.icon;
              return (
                <button
                  key={category.id}
                  onClick={() => selectCategory(category.id)}
                  aria-current={activeCategory === category.id ? 'page' : undefined}
                  className={cx(
                    'inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors',
                    activeCategory === category.id
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-border bg-bg-secondary text-text-secondary hover:border-text-tertiary hover:text-text-primary',
                  )}
                >
                  <Icon size={14} />
                  {category.label}
                </button>
              );
            })}
          </nav>

          <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <aside className="hidden lg:block">
              <nav
                className="sticky top-6 space-y-1 rounded-lg border border-border bg-bg-secondary p-2"
                aria-label="Settings sections"
              >
                {SETTINGS_CATEGORIES.map((category) => {
                  const Icon = category.icon;
                  return (
                    <button
                      key={category.id}
                      onClick={() => selectCategory(category.id)}
                      aria-current={activeCategory === category.id ? 'page' : undefined}
                      className={cx(
                        'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors',
                        activeCategory === category.id ? 'bg-accent/10' : 'hover:bg-bg-tertiary',
                      )}
                    >
                      <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary">
                          {category.label}
                        </span>
                        <span className="block text-xs text-text-tertiary">
                          {category.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            <main className="space-y-6">
              <Suspense
                fallback={
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-secondary p-5 text-sm text-text-secondary">
                    <Loader2 size={14} className="animate-spin" />
                    Loading {activeMeta.label}…
                  </div>
                }
              >
                <section
                  id={`settings-${activeMeta.id}`}
                  className="space-y-3"
                  aria-label={activeMeta.label}
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-accent">
                      <activeMeta.icon size={18} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-text-primary">
                        {activeMeta.label}
                      </h3>
                      <p className="text-sm text-text-secondary">
                        {categoryDescription(activeMeta.id)}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {categoryHiddenByRole && activeMeta.feature ? (
                      <RoleHiddenNotice
                        feature={activeMeta.feature}
                        userRole={userRole}
                        onShowAnyway={() => draft.update('showAllTools', true)}
                      />
                    ) : (
                      <ActiveComponent />
                    )}
                  </div>
                </section>
              </Suspense>
            </main>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={discardTarget !== null}
        title="Discard changes?"
        description="You have unsaved credential changes. Discarding restores the last saved values."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        tone="danger"
        onConfirm={() => {
          if (!discardTarget) return;
          draft.discardKeys(dirtyCredentials as Array<keyof AppSettings>);
          const [id, panel] = discardTarget.split('#');
          setDiscardTarget(null);
          const resolved = resolveSettingsCategoryId(id);
          if (resolved) commitCategory(resolved, panel);
        }}
        onCancel={() => setDiscardTarget(null)}
      />
    </SettingsContextProvider>
  );
}
