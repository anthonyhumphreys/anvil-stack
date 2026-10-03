import { pollWhileVisible } from '../../utils/visible-polling';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, CircleDashed, GitBranch, TerminalSquare, XCircle } from 'lucide-react';
import { useBrand } from '../../contexts/BrandContext';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildSettingsPath } from '../settings/settings-route';
import type { GitStatusResult, RepoInfo } from '../../../shared/types';

interface ConnectionStatus {
  foundry: boolean | null;
  ado: boolean | null;
  confluence: boolean | null;
}

interface StatusBarProps {
  connectionStatus: ConnectionStatus;
  onToggleTerminal: () => void;
  terminalOpen: boolean;
}

type ServiceId = keyof ConnectionStatus;

/** Minimum gap between window-focus connection re-tests (NV4 backoff). */
const FOCUS_RETEST_INTERVAL_MS = 30_000;
/** Cap per-repo git polling so large workspaces don't stampede git. */
const MAX_POLLED_REPOS = 10;

const SERVICES: Array<{
  id: ServiceId;
  label: string;
  /** SettingsLink-style `category#panel` the Fix link deep-links to (ST4). */
  settingsTarget: string;
}> = [
  { id: 'foundry', label: 'AI provider', settingsTarget: 'providers#agent-providers' },
  { id: 'ado', label: 'Azure DevOps (work items)', settingsTarget: 'delivery#work-items' },
  { id: 'confluence', label: 'Confluence (docs)', settingsTarget: 'delivery#docs' },
];

export function StatusBar({ connectionStatus, onToggleTerminal, terminalOpen }: StatusBarProps) {
  const brand = useBrand();
  const navigate = useNavigate();
  const { repos } = useWorkspace();
  const { activeThread } = useChatContext();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // Local copy of connection status so the status bar can re-test on window
  // focus without the parent (App.tsx owns the startup check) re-rendering.
  const [services, setServices] = useState<ConnectionStatus>(connectionStatus);
  const [testing, setTesting] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [reposOpen, setReposOpen] = useState(false);
  const [repoStatuses, setRepoStatuses] = useState<Record<string, GitStatusResult | null>>({});
  const lastFocusTestRef = useRef(0);

  useEffect(() => {
    setServices(connectionStatus);
  }, [connectionStatus]);

  useEffect(() => {
    let cancelled = false;

    window.anvil.appWindow
      .getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const retestConnections = useCallback(async () => {
    setTesting(true);
    try {
      const results = await Promise.all(
        SERVICES.map(async (service) => {
          const test =
            service.id === 'foundry'
              ? window.anvil.settings.testFoundryConnection
              : service.id === 'ado'
                ? window.anvil.settings.testWorkItemProviderConnection
                : window.anvil.settings.testConfluenceConnection;
          try {
            const result = await test();
            return [service.id, result.ok] as const;
          } catch {
            return [service.id, false] as const;
          }
        }),
      );
      setServices((current) => {
        const next = { ...current };
        for (const [id, ok] of results) {
          // Only overwrite services that were configured (non-null).
          if (current[id] !== null) next[id] = ok;
        }
        return next;
      });
    } finally {
      setTesting(false);
    }
  }, []);

  // Re-test on window focus with a fixed-interval backoff (NV4).
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusTestRef.current < FOCUS_RETEST_INTERVAL_MS) return;
      lastFocusTestRef.current = now;
      void retestConnections();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [retestConnections]);

  // Poll git status for each workspace repo (RM6-lite).
  useEffect(() => {
    const polled = repos.filter((repo) => repo.status !== 'error').slice(0, MAX_POLLED_REPOS);
    if (polled.length === 0) {
      setRepoStatuses({});
      return;
    }

    let cancelled = false;
    const fetchStatuses = () => {
      return Promise.all(
        polled.map((repo) =>
          window.anvil.git
            .status(repo.id)
            .then((status) => [repo.id, status] as const)
            .catch(() => [repo.id, null] as const),
        ),
      ).then((entries) => {
        if (cancelled) return;
        setRepoStatuses(Object.fromEntries(entries));
      });
    };
    const stop = pollWhileVisible(fetchStatuses, 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [repos]);

  const configuredServices = SERVICES.filter((service) => services[service.id] !== null);
  const connectedCount = configuredServices.filter((s) => services[s.id] === true).length;

  // Prefer the repo the active chat thread is scoped to; fall back to the only
  // repo, then to a generic "N repos" summary (RM6-lite).
  const threadRepoId = activeThread?.activeRepoId ?? activeThread?.repoIds[0];
  const displayRepo =
    repos.find((repo) => repo.id === threadRepoId) ?? (repos.length === 1 ? repos[0] : null);
  const displayBranch = displayRepo ? repoStatuses[displayRepo.id]?.branch : null;
  const repoButtonLabel =
    repos.length === 0
      ? null
      : displayRepo
        ? displayBranch || displayRepo.name
        : `${repos.length} repos`;

  return (
    <footer className="flex h-8 items-center justify-between border-t border-border-subtle bg-bg-secondary px-4 text-sm text-text-secondary">
      <div className="flex items-center gap-3">
        <span>
          <BrandName name={brand.appName} />
          {appVersion && ` v${appVersion}`}
        </span>
        {repoButtonLabel && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setReposOpen((open) => !open)}
              aria-haspopup="dialog"
              aria-expanded={reposOpen}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-accent transition-colors hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Repository branches"
            >
              <GitBranch size={12} />
              <span className="max-w-[140px] truncate">{repoButtonLabel}</span>
            </button>
            {reposOpen && (
              <StatusPopover
                label="Repository branches"
                align="start"
                onClose={() => setReposOpen(false)}
              >
                {repos.map((repo) => (
                  <RepoStatusRow
                    key={repo.id}
                    repo={repo}
                    status={repoStatuses[repo.id]}
                    onOpen={() => {
                      setReposOpen(false);
                      navigate(`/git?repo=${encodeURIComponent(repo.id)}`);
                    }}
                  />
                ))}
              </StatusPopover>
            )}
          </div>
        )}
        <button
          onClick={onToggleTerminal}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-elevated hover:text-text-primary ${
            terminalOpen ? 'text-text-primary' : ''
          }`}
          title={`Toggle Terminal (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+\`)`}
        >
          <TerminalSquare size={14} />
          <span>Terminal</span>
        </button>
      </div>
      <div className="relative flex items-center gap-3">
        {configuredServices.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setServicesOpen((open) => !open)}
              aria-haspopup="dialog"
              aria-expanded={servicesOpen}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Service connections"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  connectedCount === configuredServices.length ? 'bg-success' : 'bg-warning'
                }`}
                aria-hidden="true"
              />
              {connectedCount}/{configuredServices.length} services connected
            </button>
            {servicesOpen && (
              <StatusPopover
                label="Service connections"
                align="end"
                onClose={() => setServicesOpen(false)}
              >
                {configuredServices.map((service) => (
                  <div key={service.id} className="flex items-center gap-2 px-3 py-1.5">
                    {services[service.id] === true ? (
                      <CheckCircle2 size={13} className="shrink-0 text-success" />
                    ) : services[service.id] === false ? (
                      <XCircle size={13} className="shrink-0 text-error" />
                    ) : (
                      <CircleDashed size={13} className="shrink-0 text-text-tertiary" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-text-primary">
                      {service.label}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {services[service.id] === true
                        ? 'Connected'
                        : services[service.id] === false
                          ? 'Failed'
                          : 'Checking…'}
                    </span>
                    {services[service.id] === false && (
                      <button
                        type="button"
                        onClick={() => {
                          setServicesOpen(false);
                          // ST4: deep link into the owning settings panel.
                          const [category, panel] = service.settingsTarget.split('#');
                          navigate(buildSettingsPath(category, panel));
                        }}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                      >
                        Fix
                      </button>
                    )}
                  </div>
                ))}
                <div className="mt-1 border-t border-border-subtle px-3 py-2">
                  <button
                    type="button"
                    disabled={testing}
                    onClick={() => void retestConnections()}
                    className="text-xs font-medium text-accent transition-colors hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
                  >
                    {testing ? 'Re-testing…' : 'Re-test connections'}
                  </button>
                </div>
              </StatusPopover>
            )}
          </div>
        )}
      </div>
    </footer>
  );
}

function StatusPopover({
  label,
  align,
  onClose,
  children,
}: {
  label: string;
  align: 'start' | 'end';
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: globalThis.MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`absolute bottom-full z-50 mb-1.5 w-64 overflow-hidden rounded-xl border border-border bg-bg-elevated py-1 text-xs text-text-secondary shadow-[0_16px_40px_rgba(0,0,0,0.32)] ${
        align === 'end' ? 'right-0' : 'left-0'
      }`}
    >
      <div className="px-3 pb-1 pt-2 text-eyebrow uppercase text-text-tertiary">{label}</div>
      {children}
    </div>
  );
}

function RepoStatusRow({
  repo,
  status,
  onOpen,
}: {
  repo: RepoInfo;
  status: GitStatusResult | null | undefined;
  onOpen: () => void;
}) {
  const changeCount = status?.files.length ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-tertiary focus-visible:bg-bg-tertiary focus-visible:outline-none"
    >
      <GitBranch size={12} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate text-text-primary">{repo.name}</span>
      <span className="max-w-[90px] truncate text-text-tertiary">
        {repo.status === 'error' ? 'error' : (status?.branch ?? '…')}
      </span>
      {changeCount > 0 && (
        <span
          className="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-eyebrow text-warning"
          title={`${changeCount} uncommitted change${changeCount === 1 ? '' : 's'}`}
        >
          {changeCount}
        </span>
      )}
    </button>
  );
}

function BrandName({ name }: { name: string }) {
  return <>{name}</>;
}
