import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  Loader2,
  Play,
  RefreshCw,
  ScrollText,
  ServerCog,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import type {
  AnvilCloudCommandDefinition,
  AnvilCloudCommandId,
  AnvilCloudCommandResult,
  AnvilCloudWorkbenchSnapshot,
  RepoInfo,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { EmptyState, InlineNotice, ViewHeader } from '../layout/ViewScaffold';

const CATEGORY_LABELS: Record<AnvilCloudCommandDefinition['category'], string> = {
  health: 'Health',
  build: 'Build',
  runtime: 'Runtime',
  agents: 'Agents',
};

const CATEGORY_ICONS: Record<AnvilCloudCommandDefinition['category'], React.ReactNode> = {
  health: <TerminalSquare size={15} />,
  build: <FileCode2 size={15} />,
  runtime: <ServerCog size={15} />,
  agents: <Bot size={15} />,
};

export function AnvilCloudView() {
  const { repos, activeWorkspace } = useWorkspace();
  const [snapshot, setSnapshot] = useState<AnvilCloudWorkbenchSnapshot | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState(repos[0]?.id ?? '');
  const [runningCommand, setRunningCommand] = useState<AnvilCloudCommandId | null>(null);
  const [lastResult, setLastResult] = useState<AnvilCloudCommandResult | null>(null);
  const [history, setHistory] = useState<AnvilCloudCommandResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [openingLens, setOpeningLens] = useState(false);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? repos[0],
    [repos, selectedRepoId],
  );

  const groupedCommands = useMemo(() => {
    const groups = new Map<
      AnvilCloudCommandDefinition['category'],
      AnvilCloudCommandDefinition[]
    >();
    for (const command of snapshot?.commands ?? []) {
      if (!groups.has(command.category)) groups.set(command.category, []);
      groups.get(command.category)!.push(command);
    }
    return groups;
  }, [snapshot?.commands]);

  const refreshSnapshot = useCallback(async () => {
    setError(null);
    try {
      setSnapshot(await window.anvil.anvilCloud.snapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect Anvil Cloud CLI');
    }
  }, []);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!selectedRepoId && repos[0]?.id) setSelectedRepoId(repos[0].id);
  }, [repos, selectedRepoId]);

  async function runCommand(command: AnvilCloudCommandDefinition) {
    if (!selectedRepo) return;
    setRunningCommand(command.id);
    setError(null);
    try {
      const result = await window.anvil.anvilCloud.run(command.id, selectedRepo.path);
      setLastResult(result);
      setHistory((prev) => [result, ...prev].slice(0, 8));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningCommand(null);
    }
  }

  async function openLens() {
    if (!selectedRepo) return;
    setOpeningLens(true);
    setError(null);
    try {
      const result = await window.anvil.anvilCloud.openLens(selectedRepo.path);
      setLastResult(result.result);
      setHistory((prev) => [result.result, ...prev].slice(0, 8));
      if (!result.success) {
        setError(result.error ?? 'Anvil Lens is not available.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpeningLens(false);
    }
  }

  async function copyResult() {
    if (!lastResult) return;
    const text =
      lastResult.parsed === undefined
        ? (lastResult.stdout || lastResult.stderr || lastResult.error || '').trim()
        : JSON.stringify(lastResult.parsed, null, 2);

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy result');
    }
  }

  if (repos.length === 0) {
    return (
      <EmptyState
        icon={Cloud}
        title="Connect a repository for Anvil Cloud"
        description="Cloud commands need a workspace repository as their source and working directory."
        className="h-full"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <ViewHeader
        icon={Cloud}
        title="Cloud Workbench"
        description="Run Cloud checks against a workspace repository, inspect local Cell state, and open Lens."
        meta={
          <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-tertiary">
            {activeWorkspace?.name ?? 'Workspace'}
          </span>
        }
        actions={
          <>
            <select
              aria-label="Cloud repository"
              value={selectedRepo?.id ?? ''}
              onChange={(event) => setSelectedRepoId(event.target.value)}
              className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => void refreshSnapshot()}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-medium text-text-primary hover:border-accent/50"
            >
              <RefreshCw size={16} />
              Refresh CLI
            </button>
            <button
              onClick={() => void openLens()}
              disabled={openingLens || !snapshot?.status.available || runningCommand !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
            >
              {openingLens ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ExternalLink size={16} />
              )}
              Open Lens
            </button>
          </>
        }
      />
      {error && (
        <InlineNotice icon={AlertTriangle} tone="error" className="m-4 mb-0">
          {error}
        </InlineNotice>
      )}

      <main className="grid min-h-0 flex-1 gap-0 overflow-hidden xl:grid-cols-[20rem_minmax(0,1fr)_22rem]">
        <aside className="min-h-0 overflow-y-auto border-r border-border bg-bg-secondary/45 p-4">
          <CliStatus snapshot={snapshot} />
          <div className="mt-4 space-y-4">
            {[...groupedCommands.entries()].map(([category, commands]) => (
              <section key={category} className="space-y-2">
                <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase text-text-tertiary">
                  {CATEGORY_ICONS[category]}
                  {CATEGORY_LABELS[category]}
                </div>
                <div className="space-y-2">
                  {commands.map((command) => (
                    <CommandButton
                      key={command.id}
                      command={command}
                      running={runningCommand === command.id}
                      disabled={!snapshot?.status.available || runningCommand !== null}
                      onRun={() => void runCommand(command)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Result</h3>
              <p className="text-sm text-text-secondary">
                {lastResult
                  ? `${lastResult.command} in ${selectedRepo?.name ?? 'repo'}`
                  : 'Run a command to inspect JSON output.'}
              </p>
            </div>
            <button
              onClick={() => void copyResult()}
              disabled={!lastResult}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
            >
              <Copy size={14} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          {lastResult ? (
            <ResultPanel result={lastResult} />
          ) : (
            <div className="rounded-lg border border-border bg-bg-secondary p-8 text-sm text-text-secondary">
              Start with Doctor, then run Guard Check or Build Cell. If Anvil Local is already
              running, Lens URL and Inspect Local become useful fast.
            </div>
          )}
        </section>

        <aside className="min-h-0 overflow-y-auto border-l border-border bg-bg-secondary/45 p-4">
          <RepoPanel repo={selectedRepo} />
          <HistoryPanel history={history} commands={snapshot?.commands ?? []} />
        </aside>
      </main>
    </div>
  );
}

function CliStatus({ snapshot }: { snapshot: AnvilCloudWorkbenchSnapshot | null }) {
  const status = snapshot?.status;
  return (
    <section className="rounded-lg border border-border bg-bg-primary p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-text-primary">CLI</div>
        {status?.available ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs text-success">
            <CheckCircle2 size={12} />
            Ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs text-warning">
            <XCircle size={12} />
            Missing
          </span>
        )}
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div>
          <dt className="text-text-tertiary">Command</dt>
          <dd className="mt-0.5 break-all font-mono text-text-secondary">
            {status?.command ?? 'Checking'}
          </dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Source</dt>
          <dd className="mt-0.5 text-text-secondary">{status?.source ?? 'Unknown'}</dd>
        </div>
        {status?.error && (
          <div>
            <dt className="text-text-tertiary">Error</dt>
            <dd className="mt-0.5 text-error">{status.error}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function CommandButton({
  command,
  running,
  disabled,
  onRun,
}: {
  command: AnvilCloudCommandDefinition;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <button
      onClick={onRun}
      disabled={disabled}
      className="group w-full rounded-lg border border-border bg-bg-primary p-3 text-left transition-colors hover:border-accent/40 hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{command.label}</div>
          <div className="mt-1 text-xs leading-relaxed text-text-tertiary">
            {command.description}
          </div>
        </div>
        <span className="mt-0.5 text-accent">
          {running ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
        </span>
      </div>
    </button>
  );
}

function ResultPanel({ result }: { result: AnvilCloudCommandResult }) {
  const parsedText =
    result.parsed === undefined ? result.stdout.trim() : JSON.stringify(result.parsed, null, 2);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          {result.ok ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : (
            <XCircle size={16} className="text-error" />
          )}
          <span className="text-sm font-medium text-text-primary">
            {result.ok ? 'Command completed' : 'Command failed'}
          </span>
        </div>
        <div className="text-xs text-text-tertiary">
          {result.durationMs}ms, {new Date(result.completedAt).toLocaleTimeString()}
        </div>
      </div>
      <pre className="max-h-[calc(100vh-20rem)] overflow-auto p-4 text-xs leading-relaxed text-text-secondary">
        {parsedText || result.stderr || result.error || 'No output'}
      </pre>
      {(result.stderr || result.error) && (
        <div className="border-t border-border bg-bg-primary px-4 py-3 text-xs text-warning">
          {result.error ?? result.stderr}
        </div>
      )}
    </div>
  );
}

function RepoPanel({ repo }: { repo: RepoInfo | undefined }) {
  return (
    <section className="rounded-lg border border-border bg-bg-primary p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Database size={15} className="text-accent" />
        Target Repo
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        <div>
          <dt className="text-text-tertiary">Name</dt>
          <dd className="mt-0.5 text-text-secondary">{repo?.name ?? 'None'}</dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Path</dt>
          <dd className="mt-0.5 break-all font-mono text-text-secondary">{repo?.path ?? ''}</dd>
        </div>
        <div>
          <dt className="text-text-tertiary">Status</dt>
          <dd className="mt-0.5 text-text-secondary">{repo?.status ?? 'Unknown'}</dd>
        </div>
      </dl>
    </section>
  );
}

function HistoryPanel({
  history,
  commands,
}: {
  history: AnvilCloudCommandResult[];
  commands: AnvilCloudCommandDefinition[];
}) {
  const commandLabels = new Map(commands.map((command) => [command.id, command.label]));
  return (
    <section className="mt-4 rounded-lg border border-border bg-bg-primary p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ScrollText size={15} className="text-accent" />
        Recent Runs
      </div>
      <div className="mt-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-sm text-text-tertiary">No commands yet.</p>
        ) : (
          history.map((result) => (
            <div
              key={`${result.commandId}:${result.completedAt}`}
              className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-text-primary">
                  {commandLabels.get(result.commandId) ?? result.commandId}
                </span>
                {result.ok ? (
                  <CheckCircle2 size={13} className="text-success" />
                ) : (
                  <XCircle size={13} className="text-error" />
                )}
              </div>
              <div className="mt-1 text-xs text-text-tertiary">
                {new Date(result.completedAt).toLocaleTimeString()}, {result.durationMs}ms
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
