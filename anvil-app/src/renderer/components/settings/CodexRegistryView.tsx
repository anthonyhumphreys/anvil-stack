import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Download,
  ExternalLink,
  Loader2,
  Plug,
  Puzzle,
  RefreshCcw,
  Search,
  Server,
  Terminal,
} from 'lucide-react';
import type {
  CodexMcpRegisterInput,
  CodexMcpServer,
  CodexRegisteredSkill,
  CodexRegistryActionResult,
  CodexRegistrySnapshot,
  CodexSkillSearchResult,
} from '../../../shared/types';

type RegistryTab = 'installed' | 'discover' | 'mcp';

const MCP_PRESETS: Array<{
  label: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string;
  url?: string;
  bearerTokenEnvVar?: string;
}> = [
  {
    label: 'Linear',
    name: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
  },
  {
    label: 'Chrome DevTools',
    name: 'chrome-devtools',
    transport: 'stdio',
    command: 'npx',
    args: 'chrome-devtools-mcp@latest',
  },
  {
    label: 'PostHog',
    name: 'posthog',
    transport: 'stdio',
    command: 'npx',
    args: '-y mcp-remote@latest https://mcp-eu.posthog.com/sse',
  },
  {
    label: 'Notion',
    name: 'notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    bearerTokenEnvVar: 'NOTION_TOKEN',
  },
];

const QUERY_CHIPS = ['mcp', 'react', 'testing', 'security', 'docs', 'github', 'azure'];

export function CodexRegistryView() {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<CodexRegistrySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RegistryTab>('installed');
  const [installedQuery, setInstalledQuery] = useState('');
  const [skillQuery, setSkillQuery] = useState('mcp');
  const [skillResults, setSkillResults] = useState<CodexSkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [registeringMcp, setRegisteringMcp] = useState(false);
  const [lastAction, setLastAction] = useState<CodexRegistryActionResult | null>(null);
  const [mcpForm, setMcpForm] = useState<{
    name: string;
    transport: 'stdio' | 'http';
    command: string;
    args: string;
    url: string;
    bearerTokenEnvVar: string;
  }>({
    name: '',
    transport: 'stdio',
    command: 'npx',
    args: '',
    url: '',
    bearerTokenEnvVar: '',
  });

  const loadSnapshot = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.anvil.codexRegistry.snapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Codex registry');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await window.anvil.codexRegistry.searchSkills(skillQuery);
        if (!cancelled) setSkillResults(results);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [skillQuery]);

  const filteredSkills = useMemo(() => {
    return (snapshot?.skills ?? []).filter((skill) => matchesInstalledQuery(skill, installedQuery));
  }, [snapshot?.skills, installedQuery]);

  const filteredMcps = useMemo(() => {
    return (snapshot?.mcpServers ?? []).filter((server) => matchesMcpQuery(server, installedQuery));
  }, [snapshot?.mcpServers, installedQuery]);

  const registeredMcpNames = useMemo(
    () => new Set((snapshot?.mcpServers ?? []).map((server) => server.name.toLowerCase())),
    [snapshot?.mcpServers],
  );

  const installSkill = async (result: CodexSkillSearchResult) => {
    setInstallingSkill(result.id);
    setLastAction(null);
    try {
      const action = await window.anvil.codexRegistry.installSkill({
        source: result.source,
        skillName: result.skillName,
        global: true,
      });
      setLastAction(action);
      if (action.success) await loadSnapshot();
    } finally {
      setInstallingSkill(null);
    }
  };

  const registerMcp = async () => {
    setRegisteringMcp(true);
    setLastAction(null);

    const input: CodexMcpRegisterInput =
      mcpForm.transport === 'http'
        ? {
            name: mcpForm.name,
            transport: 'http',
            url: mcpForm.url,
            bearerTokenEnvVar: mcpForm.bearerTokenEnvVar || undefined,
          }
        : {
            name: mcpForm.name,
            transport: 'stdio',
            command: mcpForm.command,
            args: splitArgsInput(mcpForm.args),
          };

    try {
      const action = await window.anvil.codexRegistry.registerMcp(input);
      setLastAction(action);
      if (action.success) await loadSnapshot();
    } finally {
      setRegisteringMcp(false);
    }
  };

  const applyPreset = (preset: (typeof MCP_PRESETS)[number]) => {
    setMcpForm({
      name: preset.name,
      transport: preset.transport,
      command: preset.command ?? 'npx',
      args: preset.args ?? '',
      url: preset.url ?? '',
      bearerTokenEnvVar: preset.bearerTokenEnvVar ?? '',
    });
    setTab('mcp');
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/settings')}
              className="rounded-md border border-border-subtle p-2 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label="Back to settings"
              title="Back to settings"
            >
              <ArrowLeft size={16} />
            </button>
            <div>
              <h2 className="text-xl font-semibold text-text-primary">Codex Skills & MCPs</h2>
              <p className="text-sm text-text-secondary">
                Registered Codex skills, MCP servers, and skills.sh installs.
              </p>
            </div>
          </div>
          <button
            onClick={loadSnapshot}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
            Refresh
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4">
          <StatCard
            icon={<Terminal size={18} />}
            label="Codex CLI"
            value={snapshot?.cli.installed ? 'Installed' : 'Missing'}
            detail={snapshot?.cli.version || snapshot?.cli.path || snapshot?.cli.codexHome}
            tone={snapshot?.cli.installed ? 'ok' : 'warn'}
          />
          <StatCard
            icon={<Puzzle size={18} />}
            label="Skills"
            value={String(snapshot?.skills.length ?? 0)}
            detail={`${snapshot?.scannedSkillRoots.length ?? 0} scan roots`}
          />
          <StatCard
            icon={<Server size={18} />}
            label="MCP Servers"
            value={String(snapshot?.mcpServers.length ?? 0)}
            detail="From codex mcp list"
          />
          <StatCard
            icon={<CheckCircle size={18} />}
            label="Auth"
            value={snapshot?.cli.authConfigured ? 'Signed in' : 'Check login'}
            detail={snapshot?.cli.codexHome}
            tone={snapshot?.cli.authConfigured ? 'ok' : 'warn'}
          />
        </div>

        {snapshot?.warnings.length ? (
          <div className="space-y-2 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm text-warning">
            {snapshot.warnings.map((warning) => (
              <div key={warning} className="flex gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 border-b border-border-subtle pb-3">
          <TabButton
            label="Installed"
            icon={<Puzzle size={14} />}
            active={tab === 'installed'}
            onClick={() => setTab('installed')}
          />
          <TabButton
            label="Discover Skills"
            icon={<Search size={14} />}
            active={tab === 'discover'}
            onClick={() => setTab('discover')}
          />
          <TabButton
            label="Add MCP"
            icon={<Plug size={14} />}
            active={tab === 'mcp'}
            onClick={() => setTab('mcp')}
          />
        </div>

        {tab === 'installed' && (
          <div className="space-y-4">
            <SearchField
              value={installedQuery}
              onChange={setInstalledQuery}
              placeholder="Filter installed skills and MCPs..."
            />

            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <section className="space-y-3">
                <SectionHeader title="Skills" count={filteredSkills.length} />
                <div className="grid gap-2">
                  {filteredSkills.map((skill) => (
                    <SkillCard key={`${skill.scope}:${skill.path}`} skill={skill} />
                  ))}
                  {!filteredSkills.length && (
                    <EmptyState
                      text={loading ? 'Loading registered skills...' : 'No skills found.'}
                    />
                  )}
                </div>
              </section>

              <section className="space-y-3">
                <SectionHeader title="MCP Servers" count={filteredMcps.length} />
                <div className="grid gap-2">
                  {filteredMcps.map((server) => (
                    <McpCard key={`${server.name}:${server.raw}`} server={server} />
                  ))}
                  {!filteredMcps.length && (
                    <EmptyState
                      text={loading ? 'Loading MCP servers...' : 'No MCP servers registered.'}
                    />
                  )}
                </div>
              </section>
            </div>
          </div>
        )}

        {tab === 'discover' && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 rounded-md border border-border bg-bg-secondary p-4">
              <SearchField
                value={skillQuery}
                onChange={setSkillQuery}
                placeholder="Search skills.sh..."
                loading={searching}
              />
              <div className="flex flex-wrap gap-2">
                {QUERY_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    onClick={() => setSkillQuery(chip)}
                    className="rounded-full border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {skillResults.map((result) => {
                const installing = installingSkill === result.id;
                return (
                  <div
                    key={result.id}
                    className="rounded-md border border-border bg-bg-secondary p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-text-primary">
                          {result.name}
                        </h3>
                        <p className="mt-1 truncate font-mono text-xs text-text-tertiary">
                          {result.source}
                        </p>
                      </div>
                      {result.url && (
                        <a
                          href={result.url}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                          aria-label={`Open ${result.name}`}
                          title="Open source"
                        >
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </div>
                    {result.description && (
                      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-text-secondary">
                        {result.description}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-1">
                      {result.tags?.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-tertiary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                      <code className="min-w-0 flex-1 truncate rounded bg-bg-primary px-2 py-1 font-mono text-[11px] text-text-tertiary">
                        {result.installCommand}
                      </code>
                      <button
                        onClick={() => installSkill(result)}
                        disabled={installing}
                        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                      >
                        {installing ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Download size={13} />
                        )}
                        Install
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {!skillResults.length && (
              <EmptyState
                text={
                  searching ? 'Searching skills.sh...' : 'No matching skills returned by skills.sh.'
                }
              />
            )}
          </div>
        )}

        {tab === 'mcp' && (
          <div className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <section className="space-y-3">
              <SectionHeader title="Presets" count={MCP_PRESETS.length} />
              <div className="grid gap-2">
                {MCP_PRESETS.map((preset) => {
                  const registered = registeredMcpNames.has(preset.name.toLowerCase());
                  return (
                    <button
                      key={preset.name}
                      onClick={() => applyPreset(preset)}
                      className="rounded-md border border-border bg-bg-secondary p-4 text-left transition-colors hover:bg-bg-tertiary"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-text-primary">{preset.label}</span>
                        {registered ? (
                          <span className="inline-flex items-center gap-1 text-xs text-success">
                            <CheckCircle size={12} />
                            Registered
                          </span>
                        ) : (
                          <span className="text-xs uppercase tracking-wide text-text-tertiary">
                            {preset.transport}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-text-tertiary">
                        {preset.transport === 'http'
                          ? preset.url
                          : `${preset.command} ${preset.args}`}
                      </p>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-4 rounded-md border border-border bg-bg-secondary p-5">
              <div>
                <h3 className="text-base font-semibold text-text-primary">Register MCP Server</h3>
                <p className="mt-1 text-sm text-text-secondary">
                  Adds a server to the local Codex CLI configuration.
                </p>
              </div>

              <Field
                label="Name"
                value={mcpForm.name}
                onChange={(value) => setMcpForm((prev) => ({ ...prev, name: value }))}
                placeholder="linear"
              />

              <div className="grid grid-cols-2 gap-2">
                <ProviderButton
                  label="Command"
                  description="stdio server"
                  active={mcpForm.transport === 'stdio'}
                  onClick={() => setMcpForm((prev) => ({ ...prev, transport: 'stdio' }))}
                />
                <ProviderButton
                  label="HTTP"
                  description="remote URL"
                  active={mcpForm.transport === 'http'}
                  onClick={() => setMcpForm((prev) => ({ ...prev, transport: 'http' }))}
                />
              </div>

              {mcpForm.transport === 'stdio' ? (
                <>
                  <Field
                    label="Command"
                    value={mcpForm.command}
                    onChange={(value) => setMcpForm((prev) => ({ ...prev, command: value }))}
                    placeholder="npx"
                  />
                  <Field
                    label="Args"
                    value={mcpForm.args}
                    onChange={(value) => setMcpForm((prev) => ({ ...prev, args: value }))}
                    placeholder="-y my-mcp-server@latest"
                  />
                </>
              ) : (
                <>
                  <Field
                    label="URL"
                    value={mcpForm.url}
                    onChange={(value) => setMcpForm((prev) => ({ ...prev, url: value }))}
                    placeholder="https://example.com/mcp"
                  />
                  <Field
                    label="Bearer Token Env Var"
                    value={mcpForm.bearerTokenEnvVar}
                    onChange={(value) =>
                      setMcpForm((prev) => ({ ...prev, bearerTokenEnvVar: value }))
                    }
                    placeholder="OPTIONAL_TOKEN_ENV"
                  />
                </>
              )}

              <button
                onClick={registerMcp}
                disabled={registeringMcp || !mcpForm.name}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
              >
                {registeringMcp ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plug size={14} />
                )}
                Register MCP
              </button>
            </section>
          </div>
        )}

        {lastAction && (
          <div
            className={`rounded-md border p-4 text-sm ${
              lastAction.success
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-error/30 bg-error/10 text-error'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {lastAction.success ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
              {lastAction.success ? 'Command completed' : 'Command failed'}
            </div>
            <code className="mt-2 block overflow-x-auto rounded bg-bg-primary px-2 py-1 font-mono text-xs text-text-secondary">
              {lastAction.command}
            </code>
            {(lastAction.output || lastAction.error) && (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg-primary p-3 font-mono text-xs text-text-tertiary">
                {lastAction.output || lastAction.error}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  const iconColor =
    tone === 'ok' ? 'text-success' : tone === 'warn' ? 'text-warning' : 'text-accent';

  return (
    <div className="min-w-0 rounded-md border border-border bg-bg-secondary p-4">
      <div className={`mb-3 ${iconColor}`}>{icon}</div>
      <div className="text-xs uppercase tracking-wide text-text-tertiary">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold text-text-primary">{value}</div>
      {detail && <div className="mt-1 truncate text-xs text-text-tertiary">{detail}</div>}
    </div>
  );
}

function TabButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
        active
          ? 'border-accent/40 bg-accent/10 text-text-primary'
          : 'border-border-subtle text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
  loading = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  loading?: boolean;
}) {
  return (
    <div className="relative">
      <Search
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
      />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-bg-primary py-2 pl-9 pr-9 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
      />
      {loading && (
        <Loader2
          size={15}
          className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
        />
      )}
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
        {count}
      </span>
    </div>
  );
}

function SkillCard({ skill }: { skill: CodexRegisteredSkill }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-text-primary">{skill.name}</h4>
          {skill.description && (
            <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-text-secondary">
              {skill.description}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-tertiary">
          {scopeLabel(skill.scope)}
        </span>
      </div>
      <div className="mt-3 truncate font-mono text-xs text-text-tertiary">{skill.directory}</div>
    </div>
  );
}

function McpCard({ server }: { server: CodexMcpServer }) {
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-text-primary">{server.name}</h4>
          <p className="mt-1 truncate font-mono text-xs text-text-tertiary">
            {formatMcpCommand(server)}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${
            server.status === 'enabled'
              ? 'bg-success/10 text-success'
              : 'bg-bg-tertiary text-text-tertiary'
          }`}
        >
          {server.status ?? server.transport}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-tertiary">
        <span>{server.transport}</span>
        {server.auth && <span>Auth: {server.auth}</span>}
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-bg-secondary px-4 py-8 text-center text-sm text-text-tertiary">
      {text}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm text-text-secondary">{label}</label>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function ProviderButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border p-3 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary'
      }`}
    >
      <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
        {label}
      </div>
      <div className="mt-0.5 text-xs text-text-tertiary">{description}</div>
    </button>
  );
}

function matchesInstalledQuery(skill: CodexRegisteredSkill, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [skill.name, skill.description, skill.scope, skill.directory, skill.source]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return fuzzyIncludes(haystack, query);
}

function matchesMcpQuery(server: CodexMcpServer, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = [
    server.name,
    server.transport,
    server.command,
    server.args?.join(' '),
    server.url,
    server.status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return fuzzyIncludes(haystack, query);
}

function fuzzyIncludes(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token) || isSubsequence(token, haystack));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

function splitArgsInput(input: string): string[] {
  return input
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function formatMcpCommand(server: CodexMcpServer): string {
  if (server.transport === 'http') return server.url ?? server.raw;
  return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || server.raw;
}

function scopeLabel(scope: CodexRegisteredSkill['scope']): string {
  switch (scope) {
    case 'codex-global':
      return 'Codex';
    case 'codex-system':
      return 'System';
    case 'user-agents':
      return 'User';
    case 'project':
      return 'Project';
    case 'plugin':
      return 'Plugin';
    default:
      return 'Unknown';
  }
}
