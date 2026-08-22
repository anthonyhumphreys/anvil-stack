import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react';
import type {
  DiagnosticFeatureMetric,
  DiagnosticProcessMetric,
  DiagnosticsSnapshot,
} from '../../../shared/types';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { InlineNotice, ViewHeader } from '../layout/ViewScaffold';

interface RendererMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

type PerformanceWithMemory = Performance & {
  memory?: RendererMemoryInfo;
};

export function DiagnosticsView() {
  const { entries, threads, activeThread, busy } = useChatContext();
  const { activeWorkspace, workspaces, featureAvailability } = useWorkspace();
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [rendererMemory, setRendererMemory] = useState<RendererMemoryInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rendererMetrics = useMemo(
    () =>
      buildRendererFeatureMetrics({
        entries,
        threads,
        repoCount: activeWorkspace?.repos.length ?? 0,
        workspaceCount: workspaces.length,
        domNodes: document.querySelectorAll('*').length,
        chatBusy: busy,
        featureStatus: featureAvailability.statusLabel,
      }),
    [
      activeWorkspace?.repos.length,
      busy,
      entries,
      featureAvailability.statusLabel,
      threads,
      workspaces.length,
    ],
  );

  const featureMetrics = useMemo(
    () => [...rendererMetrics, ...(snapshot?.featureMetrics ?? [])],
    [rendererMetrics, snapshot?.featureMetrics],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextSnapshot] = await Promise.all([window.anvil.diagnostics.getSnapshot()]);
      const memory = (performance as PerformanceWithMemory).memory ?? null;
      setSnapshot(nextSnapshot);
      setRendererMemory(memory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  const rendererHeapPercent = rendererMemory
    ? (rendererMemory.usedJSHeapSize / rendererMemory.jsHeapSizeLimit) * 100
    : null;
  const processTotals = useMemo(
    () => buildProcessTotals(snapshot?.processes ?? []),
    [snapshot?.processes],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Activity}
        title="Runtime Diagnostics"
        description={
          snapshot
            ? `Memory, process, and feature counters captured ${new Date(snapshot.capturedAt).toLocaleTimeString()}.`
            : 'Memory, process, and feature counters for this Anvil session.'
        }
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
                className="h-4 w-4 accent-accent"
              />
              Auto
            </label>
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-60"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </>
        }
      />
      {error && (
        <InlineNotice icon={AlertTriangle} tone="error" className="m-4 mb-0">
          {error}
        </InlineNotice>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <section className="grid gap-4 lg:grid-cols-4">
          <MetricPanel
            label="Renderer heap"
            value={rendererMemory ? formatBytes(rendererMemory.usedJSHeapSize) : 'Unavailable'}
            detail={
              rendererMemory
                ? `${formatBytes(rendererMemory.totalJSHeapSize)} allocated`
                : 'Chromium did not expose performance.memory'
            }
            percent={rendererHeapPercent}
          />
          <MetricPanel
            label="Main RSS"
            value={snapshot ? formatBytes(snapshot.mainProcess.memory.rss) : '...'}
            detail={snapshot ? `heap ${formatBytes(snapshot.mainProcess.memory.heapUsed)}` : ''}
          />
          <MetricPanel
            label="Electron processes"
            value={String(snapshot?.processes.length ?? 0)}
            detail={formatBytes(processTotals.workingSetBytes)}
          />
          <MetricPanel
            label="Active chat"
            value={activeThread ? activeThread.title : 'No active thread'}
            detail={`${entries.length} entries`}
          />
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0">
            <SectionHeader title="Processes" subtitle="Working set by Electron process" />
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-bg-secondary text-xs uppercase text-text-tertiary">
                  <tr>
                    <th className="px-4 py-3 font-medium">Process</th>
                    <th className="px-4 py-3 font-medium">PID</th>
                    <th className="px-4 py-3 font-medium">Working Set</th>
                    <th className="px-4 py-3 font-medium">Private</th>
                    <th className="px-4 py-3 font-medium">CPU</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {(snapshot?.processes ?? []).map((processMetric) => (
                    <ProcessRow key={processMetric.pid} metric={processMetric} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="min-w-0">
            <SectionHeader
              title="Feature Counters"
              subtitle="Payloads and active runtime objects"
            />
            <div className="mt-3 space-y-3">
              {featureMetrics.map((metric) => (
                <FeatureMetricRow key={metric.id} metric={metric} />
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function buildRendererFeatureMetrics(input: {
  entries: ReturnType<typeof useChatContext>['entries'];
  threads: ReturnType<typeof useChatContext>['threads'];
  repoCount: number;
  workspaceCount: number;
  domNodes: number;
  chatBusy: boolean;
  featureStatus: string;
}): DiagnosticFeatureMetric[] {
  let chatTextBytes = 0;
  let commandOutputBytes = 0;
  let diffBytes = 0;
  let eventCount = 0;

  for (const entry of input.entries) {
    if (entry.kind === 'event') {
      eventCount += 1;
      commandOutputBytes += byteLength(entry.event.output ?? '');
      diffBytes += byteLength(entry.event.diff ?? '');
      continue;
    }
    chatTextBytes += byteLength(entry.content);
  }

  return [
    {
      id: 'renderer-chat-entries',
      label: 'Chat entries',
      count: input.entries.length,
      bytes: chatTextBytes + commandOutputBytes + diffBytes,
      detail: `${eventCount} event entries${input.chatBusy ? ', busy' : ''}`,
    },
    {
      id: 'renderer-command-output',
      label: 'Command output in chat',
      count: commandOutputBytes > 0 ? 1 : 0,
      bytes: commandOutputBytes,
    },
    {
      id: 'renderer-diffs',
      label: 'Diff payloads in chat',
      count: diffBytes > 0 ? 1 : 0,
      bytes: diffBytes,
    },
    {
      id: 'renderer-threads',
      label: 'Loaded chat threads',
      count: input.threads.length,
    },
    {
      id: 'renderer-dom',
      label: 'DOM nodes',
      count: input.domNodes,
      detail: input.featureStatus,
    },
    {
      id: 'renderer-workspaces',
      label: 'Workspace state',
      count: input.workspaceCount,
      detail: `${input.repoCount} active repos`,
    },
  ];
}

function buildProcessTotals(processes: DiagnosticProcessMetric[]): { workingSetBytes: number } {
  return {
    workingSetBytes: processes.reduce(
      (total, metric) => total + metric.memoryWorkingSetSize * 1024,
      0,
    ),
  };
}

function ProcessRow({ metric }: { metric: DiagnosticProcessMetric }) {
  return (
    <tr className="bg-bg-primary text-text-secondary">
      <td className="px-4 py-3 font-medium text-text-primary">{formatProcessType(metric.type)}</td>
      <td className="px-4 py-3 font-mono text-xs">{metric.pid}</td>
      <td className="px-4 py-3">{formatBytes(metric.memoryWorkingSetSize * 1024)}</td>
      <td className="px-4 py-3">{formatBytes(metric.memoryPrivateBytes * 1024)}</td>
      <td className="px-4 py-3">{metric.cpuPercentCPUUsage.toFixed(1)}%</td>
    </tr>
  );
}

function FeatureMetricRow({ metric }: { metric: DiagnosticFeatureMetric }) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{metric.label}</div>
          <div className="mt-1 text-xs text-text-tertiary">{metric.detail ?? 'Tracked'}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-text-primary">{metric.count}</div>
          {metric.bytes !== undefined && (
            <div className="mt-1 text-xs text-text-tertiary">{formatBytes(metric.bytes)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricPanel({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-4">
      <div className="text-xs uppercase text-text-tertiary">{label}</div>
      <div className="mt-2 truncate text-xl font-semibold text-text-primary">{value}</div>
      <div className="mt-1 text-sm text-text-secondary">{detail}</div>
      {percent !== undefined && percent !== null && (
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-tertiary">
          <div
            className="h-full bg-accent"
            style={{ width: `${Math.max(2, Math.min(percent, 100))}%` }}
          />
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
    </div>
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatProcessType(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
