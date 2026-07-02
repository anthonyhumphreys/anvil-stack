import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  FileSearch,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  Play,
  RefreshCw,
  ScrollText,
  TerminalSquare,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  ArgentCommandDefinition,
  ArgentCommandId,
  ArgentCommandResult,
  ArgentPromptTemplate,
  ArgentReadinessCheck,
  ArgentWorkbenchSnapshot,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

const COMMAND_CATEGORY_LABELS: Record<ArgentCommandDefinition['category'], string> = {
  setup: 'Setup',
  maintenance: 'Maintenance',
};

export function ArgentView() {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ArgentWorkbenchSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [runningCommand, setRunningCommand] = useState<ArgentCommandId | null>(null);
  const [startingPreview, setStartingPreview] = useState(false);
  const [lastResult, setLastResult] = useState<ArgentCommandResult | null>(null);
  const [history, setHistory] = useState<ArgentCommandResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setupComplete = useMemo(() => {
    if (!snapshot) return false;
    return (
      snapshot.node.supported &&
      snapshot.mobileProjectExists &&
      snapshot.cli.installed &&
      snapshot.mcp.registered
    );
  }, [snapshot]);

  const groupedCommands = useMemo(() => {
    const groups = new Map<
      ArgentCommandDefinition['category'],
      ArgentCommandDefinition[]
    >();
    for (const command of snapshot?.commands ?? []) {
      if (!groups.has(command.category)) groups.set(command.category, []);
      groups.get(command.category)!.push(command);
    }
    return groups;
  }, [snapshot?.commands]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await window.anvil.argent.getSnapshot());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect Argent');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function runCommand(command: ArgentCommandDefinition) {
    setRunningCommand(command.id);
    setError(null);
    try {
      const result = await window.anvil.argent.runCommand(command.id);
      setLastResult(result);
      setHistory((prev) => [result, ...prev].slice(0, 8));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningCommand(null);
    }
  }

  async function startPreview() {
    setStartingPreview(true);
    setError(null);
    try {
      const nextStatus = await window.anvil.argent.startSimulatorPreview();
      setSnapshot((current) =>
        current
          ? {
              ...current,
              simulatorPreview: nextStatus,
              checks: current.checks.map((check) =>
                check.id === 'serve-sim'
                  ? {
                      ...check,
                      level: nextStatus.running ? 'pass' : 'unknown',
                      detail: nextStatus.running
                        ? 'serve-sim is running for the embedded preview.'
                        : check.detail,
                    }
                  : check,
              ),
            }
          : current,
      );
      navigate('/browser?mode=simulator');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingPreview(false);
    }
  }

  function sendPrompt(template: ArgentPromptTemplate) {
    const status = snapshot
      ? [
          `Workspace: ${activeWorkspace?.name ?? 'Active Anvil workspace'}`,
          `Expo companion path: ${snapshot.mobileProjectPath}`,
          `Argent CLI: ${snapshot.cli.installed ? snapshot.cli.version ?? 'installed' : 'missing'}`,
          `Codex MCP: ${snapshot.mcp.registered ? 'registered' : 'not registered'}`,
          `iOS: ${snapshot.ios.detail}`,
          `Android: ${snapshot.android.detail}`,
          `Metro: ${snapshot.metro.detail}`,
          `serve-sim: ${snapshot.simulatorPreview.running ? snapshot.simulatorPreview.url : 'not running'}`,
        ]
      : [`Workspace: ${activeWorkspace?.name ?? 'Active Anvil workspace'}`];

    const prompt = [
      template.prompt,
      '',
      'Anvil Argent context:',
      ...status.map((line) => `- ${line}`),
      '',
      `Expected evidence: ${template.evidence.join(', ')}.`,
      'If Argent is not connected, diagnose setup first and name the missing command or device state.',
    ].join('\n');

    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  }

  async function copyResult() {
    if (!lastResult) return;
    const text = [lastResult.stdout, lastResult.stderr, lastResult.error].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text.trim());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy command output');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <header className="shrink-0 border-b border-border bg-bg-secondary/70 px-7 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
              <MonitorSmartphone size={22} />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-text-tertiary">
                <Bot size={14} />
                {activeWorkspace?.name ?? 'Workspace'} / Expo Argent
              </div>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight">Argent Workbench</h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
                Set up Argent for the Expo companion, check live-device readiness, and send
                evidence-focused mobile prompts into Chat.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill ok={setupComplete} label={setupComplete ? 'Ready' : 'Needs setup'} />
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm font-medium text-text-primary hover:border-info/50 disabled:opacity-60"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void startPreview()}
              disabled={startingPreview || !snapshot?.mobileProjectExists}
              className="inline-flex items-center gap-2 rounded-lg bg-info px-3 py-2 text-sm font-semibold text-white hover:bg-info/90 disabled:opacity-60"
            >
              {startingPreview ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Play size={16} />
              )}
              Start Preview
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}
      </header>

      <main className="grid min-h-0 flex-1 overflow-hidden xl:grid-cols-[22rem_minmax(0,1fr)_23rem]">
        <aside className="min-h-0 overflow-y-auto border-r border-border bg-bg-secondary/45 p-4">
          <SectionTitle icon={<FileSearch size={15} />} title="Readiness" />
          <div className="mt-3 space-y-2">
            {(snapshot?.checks ?? []).map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
            {!snapshot && (
              <div className="rounded-lg border border-border bg-bg-primary p-4 text-sm text-text-secondary">
                Inspecting local Argent setup.
              </div>
            )}
          </div>

          <div className="mt-5 space-y-4">
            {[...groupedCommands.entries()].map(([category, commands]) => (
              <section key={category} className="space-y-2">
                <SectionTitle
                  icon={category === 'setup' ? <Wrench size={15} /> : <ScrollText size={15} />}
                  title={COMMAND_CATEGORY_LABELS[category]}
                />
                {commands.map((command) => (
                  <CommandButton
                    key={command.id}
                    command={command}
                    running={runningCommand === command.id}
                    disabled={
                      runningCommand !== null ||
                      (command.id === 'init-mcp' && !snapshot?.mobileProjectExists)
                    }
                    onRun={() => void runCommand(command)}
                  />
                ))}
              </section>
            ))}
          </div>
        </aside>

        <section className="min-h-0 overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold text-text-primary">Command Output</h3>
              <p className="text-sm text-text-secondary">
                {lastResult
                  ? `${lastResult.command} completed ${lastResult.ok ? 'successfully' : 'with errors'}`
                  : 'Run setup or maintenance commands from the left panel.'}
              </p>
            </div>
            <button
              type="button"
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
            <div className="rounded-lg border border-border bg-bg-secondary p-8 text-sm leading-relaxed text-text-secondary">
              Start with Install CLI if `argent` is missing, then Init MCP from the Expo companion
              root. If this feels like yak shaving, that is because it is, but at least the yak has
              buttons now.
            </div>
          )}

          {history.length > 0 && (
            <section className="mt-6">
              <SectionTitle icon={<TerminalSquare size={15} />} title="Recent Runs" />
              <div className="mt-3 overflow-hidden rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-bg-secondary text-xs uppercase text-text-tertiary">
                    <tr>
                      <th className="px-4 py-3 font-medium">Command</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {history.map((result) => (
                      <tr key={`${result.commandId}-${result.completedAt}`}>
                        <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                          {result.command}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              result.ok
                                ? 'bg-success/10 text-success'
                                : 'bg-error/10 text-error'
                            }`}
                          >
                            {result.ok ? 'ok' : 'failed'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-text-tertiary">
                          {formatDuration(result.durationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </section>

        <aside className="min-h-0 overflow-y-auto border-l border-border bg-bg-secondary/45 p-4">
          <SectionTitle icon={<MessageSquare size={15} />} title="Argent Prompts" />
          <div className="mt-3 space-y-3">
            {(snapshot?.prompts ?? []).map((template) => (
              <PromptCard
                key={template.id}
                template={template}
                disabled={!snapshot}
                onSend={() => sendPrompt(template)}
              />
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase text-text-tertiary">
      {icon}
      {title}
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
        ok ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
      }`}
    >
      {ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      {label}
    </span>
  );
}

function CheckRow({ check }: { check: ArgentReadinessCheck }) {
  const classes =
    check.level === 'pass'
      ? 'border-success/25 bg-success/5 text-success'
      : check.level === 'fail'
        ? 'border-error/25 bg-error/5 text-error'
        : check.level === 'warn'
          ? 'border-warning/25 bg-warning/5 text-warning'
          : 'border-border bg-bg-primary text-text-tertiary';

  return (
    <div className={`rounded-lg border p-3 ${classes}`}>
      <div className="flex items-center gap-2">
        {check.level === 'pass' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
        <span className="text-sm font-semibold text-text-primary">{check.label}</span>
      </div>
      <p className="mt-1 break-words text-xs leading-relaxed text-text-secondary">
        {check.detail}
      </p>
    </div>
  );
}

function CommandButton({
  command,
  running,
  disabled,
  onRun,
}: {
  command: ArgentCommandDefinition;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled}
      className="flex w-full items-start gap-3 rounded-lg border border-border bg-bg-primary px-3 py-3 text-left transition-colors hover:border-info/40 hover:bg-info/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="mt-0.5 text-info">
        {running ? <Loader2 size={16} className="animate-spin" /> : <TerminalSquare size={16} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text-primary">{command.label}</span>
        <span className="mt-1 block text-xs leading-relaxed text-text-secondary">
          {command.description}
        </span>
        <span className="mt-2 block truncate font-mono text-[11px] text-text-tertiary">
          {command.command}
        </span>
      </span>
    </button>
  );
}

function ResultPanel({ result }: { result: ArgentCommandResult }) {
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join('\n').trim();

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-secondary">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="font-mono text-xs text-text-tertiary">{result.command}</div>
          <div className="mt-1 text-sm text-text-secondary">{result.cwd}</div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
            result.ok ? 'bg-success/10 text-success' : 'bg-error/10 text-error'
          }`}
        >
          {result.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
          {result.ok ? 'Success' : 'Failed'}
        </span>
      </div>
      <pre className="max-h-[48vh] overflow-auto bg-bg-primary p-4 text-xs leading-relaxed text-text-secondary">
        {output || '(no output)'}
      </pre>
    </div>
  );
}

function PromptCard({
  template,
  disabled,
  onSend,
}: {
  template: ArgentPromptTemplate;
  disabled: boolean;
  onSend: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={disabled}
      className="w-full rounded-lg border border-border bg-bg-primary p-3 text-left transition-colors hover:border-info/40 hover:bg-info/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">{template.label}</div>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {template.description}
          </p>
        </div>
        <MessageSquare size={15} className="mt-0.5 shrink-0 text-info" />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {template.evidence.map((item) => (
          <span
            key={item}
            className="rounded-full border border-border-subtle bg-bg-secondary px-2 py-0.5 text-[11px] text-text-tertiary"
          >
            {item}
          </span>
        ))}
      </div>
    </button>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
