import { app } from 'electron';
import type {
  DiagnosticFeatureMetric,
  DiagnosticMemoryUsage,
  DiagnosticProcessMetric,
  DiagnosticsSnapshot,
} from '../../shared/types.js';
import { getAgentMcpStatus } from './agent-mcp/index.js';
import { listTargets } from './browser.service.js';
import { getCodexSessionDiagnostics } from './codex-session.service.js';
import { getRunProcessDiagnostics } from './run-process.service.js';
import { getTerminalDiagnostics } from './terminal.service.js';

function mapMemoryUsage(memory: NodeJS.MemoryUsage): DiagnosticMemoryUsage {
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

/** Endpoint status for Diagnostics; copies counters field by field so no token can leak. */
export function buildAgentMcpDiagnostics(
  status: ReturnType<typeof getAgentMcpStatus>,
): NonNullable<DiagnosticsSnapshot['agentMcp']> {
  return {
    listening: status.running,
    ...(status.port !== undefined ? { port: status.port } : {}),
    ...(status.error ? { error: status.error } : {}),
    activeSessions: status.sessions.length,
    sessions: status.sessions.map(({ sessionId, createdAt, toolCalls, toolErrors }) => ({
      sessionId,
      createdAt,
      toolCalls,
      toolErrors,
    })),
  };
}

function mapProcessMetric(metric: Electron.ProcessMetric): DiagnosticProcessMetric {
  return {
    pid: metric.pid,
    type: metric.type,
    memoryWorkingSetSize: metric.memory.workingSetSize,
    memoryPrivateBytes: metric.memory.privateBytes ?? 0,
    memorySharedBytes: 0,
    cpuPercentCPUUsage: metric.cpu.percentCPUUsage,
    cpuIdleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
  };
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  const codex = getCodexSessionDiagnostics();
  const terminals = getTerminalDiagnostics();
  const runProcesses = getRunProcessDiagnostics();
  const browserTargets = listTargets();

  const featureMetrics: DiagnosticFeatureMetric[] = [
    {
      id: 'codex-sessions',
      label: 'Codex sessions',
      count: codex.activeSessions,
      bytes: codex.bufferedBytes,
      detail: `${codex.pendingApprovals} pending approval${codex.pendingApprovals === 1 ? '' : 's'}`,
    },
    {
      id: 'terminal-sessions',
      label: 'Terminal sessions',
      count: terminals.activeTerminals,
      bytes: terminals.replayBytes,
      detail: `${terminals.trackedTerminals} tracked sessions; ${terminals.replayChunks} replay chunks; estimated UTF-16 payload bytes`,
    },
    {
      id: 'run-processes',
      label: 'Run processes',
      count: runProcesses.runningProcesses,
      detail: `${runProcesses.trackedProcesses} tracked process${runProcesses.trackedProcesses === 1 ? '' : 'es'}`,
    },
    {
      id: 'browser-targets',
      label: 'Browser targets',
      count: browserTargets.length,
    },
  ];

  return {
    capturedAt: new Date().toISOString(),
    mainProcess: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: process.uptime(),
      memory: mapMemoryUsage(process.memoryUsage()),
    },
    processes: app.getAppMetrics().map(mapProcessMetric),
    featureMetrics,
    agentMcp: buildAgentMcpDiagnostics(getAgentMcpStatus()),
  };
}
