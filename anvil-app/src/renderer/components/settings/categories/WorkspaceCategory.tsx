import { useEffect, useState } from 'react';
import { CheckCircle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CodexMode, RepoInfo } from '../../../../shared/types';
import { useWorkspace, repoIsMapped } from '../../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../../contexts/RepoIndexContext';
import { AddRepositoriesDialog } from '../../shared/AddRepositoriesDialog';
import { RemoveRepoDialog } from '../../repos/RemoveRepoDialog';
import { SettingsLink } from '../../shared/SettingsLink';
import { Button, SegmentedControl } from '../../ui';
import { useSettingsContext } from '../SettingsContext';
import { SettingsPanel } from '../settings-ui';
import {
  CHAT_ACCESS_LEVELS,
  DEFAULT_CHAT_ACCESS_LEVEL,
  chatAccessLevelDescription,
  chatAccessLevelLabel,
  isChatAccessLevel,
  readThreadAccessStore,
  setThreadAccessLevel,
  writeThreadAccessStore,
} from '../../chat/thread-access';

type WorkspaceDefaultOption = CodexMode | 'app-default';

/**
 * ST9 / J10 / first-plan S3 — the Workspace category.
 *
 * Everything here is scoped to the *active* workspace: its name, its repo
 * list (add / remove / re-index / forget), pointers to the integration
 * panels that own workspace-adjacent credentials, and the per-workspace
 * default chat access level.
 *
 * The access default persists through `WorkspaceContext.workspaceAccessDefault`
 * (localStorage per workspace until `workspace_preferences.access` lands) and
 * is also mirrored into the per-workspace thread-access store's `defaultLevel`
 * so `resolveThreadAccessLevel` picks it up for threads with no override.
 */
export function WorkspaceCategory() {
  const {
    activeWorkspace,
    repos,
    updateWorkspace,
    refreshWorkspaces,
    workspaceAccessDefault,
    setWorkspaceAccessDefault,
  } = useWorkspace();
  const repoIndex = useRepoIndex();
  const { reportError } = useSettingsContext();

  const [name, setName] = useState(activeWorkspace?.name ?? '');
  const [nameState, setNameState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [showAddRepos, setShowAddRepos] = useState(false);
  const [repoToRemove, setRepoToRemove] = useState<RepoInfo | null>(null);
  const [reindexingRepoId, setReindexingRepoId] = useState<string | null>(null);

  // Keep the field in sync when the workspace (or its name) changes elsewhere.
  useEffect(() => {
    setName(activeWorkspace?.name ?? '');
    setNameState('idle');
  }, [activeWorkspace?.id, activeWorkspace?.name]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!activeWorkspace || !trimmed || trimmed === activeWorkspace.name) return;
    setNameState('saving');
    try {
      await updateWorkspace(activeWorkspace.id, { name: trimmed });
      setNameState('saved');
      window.setTimeout(() => setNameState('idle'), 2000);
    } catch (err) {
      setNameState('error');
      reportError(err instanceof Error ? err.message : 'Failed to rename the workspace');
    }
  };

  const applyAccessDefault = (level: WorkspaceDefaultOption) => {
    const next = level === 'app-default' ? null : level;
    setWorkspaceAccessDefault(next);
    // Keep the composer-side per-workspace store in lockstep so threads with
    // no override resolve this level (and so the composer's own default chip
    // reflects it).
    if (activeWorkspace && next && isChatAccessLevel(next)) {
      const store = readThreadAccessStore(activeWorkspace.id);
      writeThreadAccessStore(activeWorkspace.id, setThreadAccessLevel(store, null, next));
    }
  };

  const storeDefault = activeWorkspace
    ? readThreadAccessStore(activeWorkspace.id).defaultLevel
    : DEFAULT_CHAT_ACCESS_LEVEL;

  const accessValue: WorkspaceDefaultOption = workspaceAccessDefault ?? 'app-default';
  const effectiveAccessLevel = workspaceAccessDefault ?? storeDefault;

  const reindex = async (repo: RepoInfo) => {
    setReindexingRepoId(repo.id);
    reportError(null);
    try {
      await repoIndex.startIndex(repo.id);
    } catch (err) {
      reportError(err instanceof Error ? err.message : `Failed to start indexing ${repo.name}`);
    } finally {
      setReindexingRepoId(null);
    }
  };

  if (!activeWorkspace) {
    return (
      <SettingsPanel
        panelId="workspace"
        title="Workspace"
        description="No workspace is active. Create one to manage its repositories and defaults here."
      >
        <p className="text-sm text-text-tertiary">No active workspace.</p>
      </SettingsPanel>
    );
  }

  return (
    <>
      <SettingsPanel
        panelId="workspace"
        title="Workspace"
        description="The workspace your chats, repos and tools are scoped to."
      >
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="workspace-name" className="block text-sm text-text-secondary">
              Name
            </label>
            <span className="text-xs text-text-tertiary" aria-live="polite">
              {nameState === 'saving' && (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Saving…
                </span>
              )}
              {nameState === 'saved' && (
                <span className="inline-flex items-center gap-1.5 text-success">
                  <CheckCircle size={12} /> Saved
                </span>
              )}
              {nameState === 'error' && <span className="text-error">Save failed</span>}
              {nameState === 'idle' && 'Changes save on blur'}
            </span>
          </div>
          <input
            id="workspace-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
          />
        </div>
      </SettingsPanel>

      <SettingsPanel
        panelId="repositories"
        title="Repositories"
        description="Repositories in this workspace. Indexing runs automatically; re-index to refresh structure and summaries."
      >
        {repos.length === 0 ? (
          <p className="text-sm text-text-tertiary">
            No repositories yet — add one to unlock repo-powered features.
          </p>
        ) : (
          <ul className="space-y-2">
            {repos.map((repo) => {
              const indexing = repoIndex.isIndexing(repo.id);
              const lastError = repoIndex.lastErrorForRepo(repo.id);
              return (
                <li
                  key={repo.id}
                  className="flex items-center gap-3 rounded-md border border-border bg-bg-primary px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text-primary">
                        {repo.name}
                      </span>
                      <RepoTierChip repo={repo} indexing={indexing} failed={!!lastError} />
                    </div>
                    <p className="truncate font-mono text-xs text-text-tertiary" title={repo.path}>
                      {repo.path}
                    </p>
                    {lastError && !indexing && (
                      <p
                        className="mt-0.5 truncate text-xs text-error"
                        title={lastError.error ?? ''}
                      >
                        {lastError.error}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={indexing || reindexingRepoId === repo.id}
                    onClick={() => void reindex(repo)}
                    title={indexing ? 'Indexing in progress' : 'Re-index this repository'}
                  >
                    {indexing || reindexingRepoId === repo.id ? (
                      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw size={12} aria-hidden="true" />
                    )}
                    {indexing ? 'Indexing' : 'Re-index'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRepoToRemove(repo)}
                    title={`Remove ${repo.name} from this workspace`}
                    aria-label={`Remove ${repo.name} from this workspace`}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Button variant="secondary" size="sm" onClick={() => setShowAddRepos(true)}>
            <Plus size={13} aria-hidden="true" /> Add repositories
          </Button>
        </div>
      </SettingsPanel>

      <SettingsPanel
        panelId="chat-access"
        title="Chat access default"
        description="The access level new threads in this workspace start with. Per-thread choices in the composer still win."
      >
        <SegmentedControl<WorkspaceDefaultOption>
          label="Default chat access level"
          value={accessValue}
          onChange={applyAccessDefault}
          options={[
            { value: 'app-default', label: `App default (${chatAccessLevelLabel(storeDefault)})` },
            ...CHAT_ACCESS_LEVELS.map((level) => ({
              value: level as WorkspaceDefaultOption,
              label: chatAccessLevelLabel(level),
            })),
          ]}
        />
        <p className="text-sm text-text-secondary">
          {chatAccessLevelDescription(effectiveAccessLevel)}
        </p>
      </SettingsPanel>

      <SettingsPanel
        panelId="connections"
        title="Connections & preferences"
        description="Integrations used by this workspace live in their own settings panels."
      >
        <ul className="space-y-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span className="text-text-secondary">Work-item connection (ADO, Linear, Jira)</span>
            <SettingsLink to="delivery#work-items">Open work-item settings</SettingsLink>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="text-text-secondary">Documentation provider (Confluence, Notion)</span>
            <SettingsLink to="delivery#docs">Open docs settings</SettingsLink>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="text-text-secondary">Git provider credentials for cloning</span>
            <SettingsLink to="delivery#git">Open Git settings</SettingsLink>
          </li>
        </ul>
      </SettingsPanel>

      <AddRepositoriesDialog
        open={showAddRepos}
        onClose={() => setShowAddRepos(false)}
        onReposAdded={() => void refreshWorkspaces()}
      />
      <RemoveRepoDialog
        repo={repoToRemove}
        open={repoToRemove !== null}
        onClose={() => setRepoToRemove(null)}
        onRemoved={() => void refreshWorkspaces()}
      />
    </>
  );
}

function RepoTierChip({
  repo,
  indexing,
  failed,
}: {
  repo: RepoInfo;
  indexing: boolean;
  failed: boolean;
}) {
  const label = indexing
    ? 'Indexing'
    : failed
      ? 'Index failed'
      : repo.indexTier === 'enriched' || repo.status === 'indexed'
        ? 'Enriched'
        : repoIsMapped(repo)
          ? 'Mapped'
          : repo.status === 'error'
            ? 'Error'
            : 'Connected';
  const tone = indexing
    ? 'bg-info/15 text-info'
    : failed || repo.status === 'error'
      ? 'bg-error/15 text-error'
      : repo.indexTier === 'enriched' || repo.status === 'indexed'
        ? 'bg-success/15 text-success'
        : repoIsMapped(repo)
          ? 'bg-info/15 text-info'
          : 'bg-bg-tertiary text-text-tertiary';
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-eyebrow font-medium ${tone}`}>
      {label}
    </span>
  );
}
