import type { AgentProvider, CodexMode } from '../../../shared/types';
import { isAcpAgentProvider, type AcpAgentProvider } from '../../../shared/agent-providers';
import { agentProviderLabel } from '../../utils/agent-display';

/**
 * CH1 — per-thread access levels.
 *
 * Levels map onto the existing `CodexMode` transport. The user-facing labels
 * differ from the enum names on purpose (see ui-surfaces-review.md CH1):
 *
 *   read-only       → "Read only"
 *   on-request      → "Approve for me"
 *   workspace-auto  → "Auto approve"
 *   full-access     → "Full access"
 *
 * Storage is renderer-local (localStorage, keyed per workspace) because the
 * durable per-thread contract (`ChatThread.codexMode` + `chat:update-thread`
 * field + schema column) belongs to the shared/main workstream. The store
 * shape below is designed so that wiring later can swap `read/write` calls
 * for the thread record without touching the UI.
 */

export const CHAT_ACCESS_LEVELS: readonly CodexMode[] = [
  'read-only',
  'on-request',
  'workspace-auto',
  'full-access',
] as const;

export const DEFAULT_CHAT_ACCESS_LEVEL: CodexMode = 'on-request';

export function isChatAccessLevel(value: unknown): value is CodexMode {
  return typeof value === 'string' && (CHAT_ACCESS_LEVELS as readonly string[]).includes(value);
}

/** Full label used in the composer chip menu and confirmations. */
export function chatAccessLevelLabel(mode: CodexMode): string {
  switch (mode) {
    case 'read-only':
      return 'Read only';
    case 'on-request':
      return 'Approve for me';
    case 'workspace-auto':
      return 'Auto approve';
    case 'full-access':
      return 'Full access';
    default:
      return 'Approve for me';
  }
}

/** Compact label for dense surfaces like the thread rail. */
export function chatAccessLevelShortLabel(mode: CodexMode): string {
  switch (mode) {
    case 'read-only':
      return 'Read only';
    case 'on-request':
      return 'Approve';
    case 'workspace-auto':
      return 'Auto';
    case 'full-access':
      return 'Full';
    default:
      return 'Approve';
  }
}

export function chatAccessLevelDescription(mode: CodexMode): string {
  switch (mode) {
    case 'read-only':
      return 'Anvil can read and explain, but cannot change files or run commands.';
    case 'on-request':
      return 'Anvil asks before changing files or running commands.';
    case 'workspace-auto':
      return 'Anvil edits files and runs commands inside the workspace without asking.';
    case 'full-access':
      return 'Anvil can act anywhere on this machine without asking. Use with care.';
    default:
      return '';
  }
}

/** Auto/Full levels get warning styling and a shield icon (CH1). */
export function chatAccessLevelIsElevated(mode: CodexMode): boolean {
  return mode === 'workspace-auto' || mode === 'full-access';
}

/** Switching to Full access always goes through a confirmation dialog. */
export function chatAccessLevelRequiresConfirm(mode: CodexMode): boolean {
  return mode === 'full-access';
}

// ---------------------------------------------------------------------------
// H9 — provider-truthful access options
// ---------------------------------------------------------------------------

/**
 * One selectable access mode in the composer chip. For Codex-family providers
 * the four CodexMode levels are distinct and `level` is the transport value.
 * ACP providers collapse the four levels into their own mode ids — `appliedMode`
 * carries the provider-side id so the chip can label what actually applies.
 * `plan` modes are reached through the collaboration-mode transport, not a
 * CodexMode, so they carry `level: null` plus `collaborationMode: 'plan'`.
 */
export interface ChatAccessOption {
  level: CodexMode | null;
  /** Provider-side mode id this option activates ('ask' | 'agent' | ...). */
  appliedMode?: string;
  label: string;
  description: string;
  elevated: boolean;
  collaborationMode?: 'plan';
}

/**
 * Fallback when no live session exposes `capabilities.accessModes` yet —
 * mirrors `ACP_ACCESS_MODES` in codex-session.service.ts.
 */
const ACP_ACCESS_MODES: Record<AcpAgentProvider, readonly string[]> = {
  cursor: ['ask', 'agent', 'plan'],
  devin: ['ask', 'accept-edits', 'smart', 'bypass', 'plan'],
};

function acpAccessOption(provider: AcpAgentProvider, modeId: string): ChatAccessOption | null {
  const name = agentProviderLabel(provider) ?? 'The agent';
  switch (modeId) {
    case 'ask':
      return {
        level: 'read-only',
        appliedMode: 'ask',
        label: 'Read only',
        description: `${name} answers questions without changing files or running commands.`,
        elevated: false,
      };
    case 'agent':
      // Cursor collapses every non-read-only level into 'agent'; 'on-request'
      // is the neutral transport value that still reads sanely if the thread
      // later runs on a Codex-family provider.
      return {
        level: 'on-request',
        appliedMode: 'agent',
        label: 'Agent',
        description: `${name} works autonomously and asks for approval under its own rules.`,
        elevated: false,
      };
    case 'accept-edits':
      return {
        level: 'on-request',
        appliedMode: 'accept-edits',
        label: 'Approve for me',
        description: `${name} applies file edits without asking and still asks before other actions.`,
        elevated: false,
      };
    case 'smart':
      return {
        level: 'workspace-auto',
        appliedMode: 'smart',
        label: 'Auto approve',
        description: `${name} auto-approves safe operations and asks before risky ones.`,
        elevated: true,
      };
    case 'bypass':
      return {
        level: 'full-access',
        appliedMode: 'bypass',
        label: 'Full access',
        description: `${name} never asks for approval. Use with care.`,
        elevated: true,
      };
    case 'plan':
      return {
        level: null,
        appliedMode: 'plan',
        collaborationMode: 'plan',
        label: 'Plan',
        description: `${name} plans the work without changing files or running commands.`,
        elevated: false,
      };
    default:
      return null;
  }
}

/**
 * The options the access chip should offer for a provider. Pass the session's
 * `capabilities.accessModes` when available; ACP providers fall back to their
 * advertised mode list so a new thread is honest before the session starts.
 * Codex-family providers expose all four CodexMode levels.
 */
export function chatAccessOptionsForProvider(
  provider: AgentProvider | undefined,
  accessModes?: readonly string[],
): ChatAccessOption[] {
  const acpProvider = isAcpAgentProvider(provider) ? provider : null;
  if (!acpProvider) {
    return CHAT_ACCESS_LEVELS.map((level) => ({
      level,
      label: chatAccessLevelLabel(level),
      description: chatAccessLevelDescription(level),
      elevated: chatAccessLevelIsElevated(level),
    }));
  }
  const modes = accessModes?.length ? accessModes : ACP_ACCESS_MODES[acpProvider];
  return modes.flatMap((modeId) => {
    const option = acpAccessOption(acpProvider, modeId);
    return option ? [option] : [];
  });
}

/**
 * The provider-side mode id the next send will apply — mirrors
 * `resolveAcpSessionMode` plus the read-only persona/plan clamps in
 * codex-session.service.ts. Returns undefined for Codex-family providers.
 */
export function expectedAcpAppliedMode(
  provider: AgentProvider | undefined,
  level: CodexMode,
  collaborationMode?: 'default' | 'plan',
  canWriteFiles?: boolean,
): string | undefined {
  if (!isAcpAgentProvider(provider)) return undefined;
  if (collaborationMode === 'plan') return 'plan';
  const effectiveLevel = canWriteFiles === false ? 'read-only' : level;
  if (provider === 'devin') {
    switch (effectiveLevel) {
      case 'read-only':
        return 'ask';
      case 'workspace-auto':
        return 'smart';
      case 'full-access':
        return 'bypass';
      default:
        return 'accept-edits';
    }
  }
  return effectiveLevel === 'read-only' ? 'ask' : 'agent';
}

/** Label for a provider-side mode id that is not a CodexMode. */
export function chatAppliedModeLabel(modeId: string): string | null {
  switch (modeId) {
    case 'ask':
      return 'Read only';
    case 'agent':
      return 'Agent';
    case 'accept-edits':
      return 'Approve for me';
    case 'smart':
      return 'Auto approve';
    case 'bypass':
    case 'danger-full-access':
      return 'Full access';
    case 'plan':
      return 'Plan';
    default:
      return null;
  }
}

/**
 * Whether the option is the currently applied one. When `appliedMode` is known
 * (ACP mode id, or the persona-clamped CodexMode for Codex sessions) it wins
 * over the stored level so the check mark lands on what actually runs.
 */
export function chatAccessOptionSelected(
  option: ChatAccessOption,
  level: CodexMode,
  appliedMode?: string,
): boolean {
  if (appliedMode) {
    if (option.appliedMode) return option.appliedMode === appliedMode;
    return option.level === appliedMode;
  }
  return option.level === level;
}

/** The label the collapsed chip should show for the applied/stored mode. */
export function resolveChatAccessChipLabel(
  options: ChatAccessOption[],
  level: CodexMode,
  appliedMode?: string,
): string {
  if (appliedMode) {
    const match = options.find((option) => option.appliedMode === appliedMode);
    if (match) return match.label;
    const modeLabel =
      chatAppliedModeLabel(appliedMode) ??
      (isChatAccessLevel(appliedMode) ? chatAccessLevelLabel(appliedMode) : null);
    if (modeLabel) return modeLabel;
  }
  return chatAccessLevelLabel(level);
}

// ---------------------------------------------------------------------------
// Renderer-local persistence (interim transport — see note above)
// ---------------------------------------------------------------------------

export interface ThreadAccessStore {
  /** Level applied to threads with no explicit override. Mirrors the default. */
  defaultLevel: CodexMode;
  /** Last level pushed into `settings.codexMode`, for external-change checks. */
  appliedLevel: CodexMode | null;
  /** Explicit per-thread overrides. */
  threads: Record<string, CodexMode>;
}

export const THREAD_ACCESS_STORAGE_PREFIX = 'anvil:chat-thread-access:v1:';

export function threadAccessStorageKey(workspaceId: string): string {
  return `${THREAD_ACCESS_STORAGE_PREFIX}${workspaceId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readThreadAccessStore(workspaceId: string): ThreadAccessStore {
  const fallback: ThreadAccessStore = {
    defaultLevel: 'on-request',
    appliedLevel: null,
    threads: {},
  };
  const local = storage();
  if (!workspaceId || !local) return fallback;
  try {
    const raw = local.getItem(threadAccessStorageKey(workspaceId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ThreadAccessStore> | null;
    if (!parsed || typeof parsed !== 'object') return fallback;
    const threads: Record<string, CodexMode> = {};
    if (parsed.threads && typeof parsed.threads === 'object') {
      for (const [threadId, level] of Object.entries(parsed.threads)) {
        if (isChatAccessLevel(level)) threads[threadId] = level;
      }
    }
    return {
      defaultLevel: isChatAccessLevel(parsed.defaultLevel)
        ? parsed.defaultLevel
        : fallback.defaultLevel,
      appliedLevel: isChatAccessLevel(parsed.appliedLevel) ? parsed.appliedLevel : null,
      threads,
    };
  } catch {
    return fallback;
  }
}

export function writeThreadAccessStore(workspaceId: string, store: ThreadAccessStore): void {
  const local = storage();
  if (!workspaceId || !local) return;
  try {
    local.setItem(threadAccessStorageKey(workspaceId), JSON.stringify(store));
  } catch {
    // Storage full/unavailable — the chip still works for the session.
  }
}

/**
 * The level a thread should run with: explicit per-thread override, then the
 * per-workspace default from Settings → Workspace (ST9/J10), then the store's
 * own default, then the app default.
 */
export function resolveThreadAccessLevel(
  store: ThreadAccessStore | null,
  threadId: string | null | undefined,
  workspaceDefault?: CodexMode | null,
): CodexMode {
  if (threadId && store?.threads[threadId]) return store.threads[threadId];
  if (workspaceDefault && isChatAccessLevel(workspaceDefault)) return workspaceDefault;
  if (!store) return DEFAULT_CHAT_ACCESS_LEVEL;
  return store.defaultLevel;
}

/**
 * Reconcile the store against the live settings value. When the persisted
 * `appliedLevel` differs from `settings.codexMode`, the setting was changed
 * outside this flow (e.g. Settings → Workspace), so it becomes the new
 * default for threads without overrides.
 */
export function reconcileThreadAccessStore(
  store: ThreadAccessStore,
  settingsLevel: CodexMode | undefined,
): ThreadAccessStore {
  const live = isChatAccessLevel(settingsLevel) ? settingsLevel : store.defaultLevel;
  if (store.appliedLevel === live) return store;
  return { ...store, defaultLevel: live };
}

/** Record a new effective level after applying it to the transport. */
export function markAccessLevelApplied(
  store: ThreadAccessStore,
  level: CodexMode,
): ThreadAccessStore {
  return store.appliedLevel === level ? store : { ...store, appliedLevel: level };
}

/** Record a per-thread override (or a new default when `threadId` is null). */
export function setThreadAccessLevel(
  store: ThreadAccessStore,
  threadId: string | null | undefined,
  level: CodexMode,
): ThreadAccessStore {
  if (!threadId) return { ...store, defaultLevel: level };
  return { ...store, threads: { ...store.threads, [threadId]: level } };
}
