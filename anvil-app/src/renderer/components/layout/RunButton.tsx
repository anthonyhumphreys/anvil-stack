// src/renderer/components/layout/RunButton.tsx

import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, Loader2, ChevronDown } from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import type { RunCommand, RunStatus } from '../../../shared/run-types';
import { RunDropdown } from './RunDropdown';
import { RunFallback } from './RunFallback';
import { copyTextToClipboard } from '../../utils/clipboard';

interface RunButtonProps {
  compact?: boolean;
}

export function RunButton({ compact = false }: RunButtonProps) {
  const { repos, featureAvailability } = useWorkspace();
  const [scripts, setScripts] = useState<Record<string, RunCommand[]>>({});
  const [statuses, setStatuses] = useState<Record<string, RunStatus | null>>({});
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [lastUsed, setLastUsed] = useState<{
    repoId: string;
    command: string;
    label: string;
  } | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  // Detect scripts for all repos
  useEffect(() => {
    const repoIds = repos.map((r) => r.id);
    if (repoIds.length === 0) return;

    window.anvil.run.detectAllScripts(repoIds).then((result) => {
      setScripts(result);
    });
  }, [repos]);

  // Listen for started/stopped events
  useEffect(() => {
    const unsubStarted = window.anvil.run.onStarted((data) => {
      setStatuses((prev) => ({
        ...prev,
        [data.repoId]: {
          repoId: data.repoId,
          command: data.command,
          running: true,
          startedAt: new Date().toISOString(),
        },
      }));
    });
    const unsubStopped = window.anvil.run.onStopped((data) => {
      setStatuses((prev) => ({
        ...prev,
        [data.repoId]: prev[data.repoId]
          ? {
              ...prev[data.repoId]!,
              running: false,
              exitCode: data.exitCode ?? undefined,
              signal: data.signal,
            }
          : null,
      }));
    });
    return () => {
      unsubStarted();
      unsubStopped();
    };
  }, []);

  // Close dropdown/fallback on outside click
  useEffect(() => {
    if (!dropdownOpen && !showFallback) return;
    const handler = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setShowFallback(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setDropdownOpen(false);
      setShowFallback(false);
      buttonRef.current?.querySelector<HTMLButtonElement>('[data-run-trigger]')?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [dropdownOpen, showFallback]);

  const runningEntry = Object.values(statuses).find((s) => s?.running);

  const handleRun = useCallback((repoId: string, command: string, label: string) => {
    window.anvil.run.start(repoId, command);
    setLastUsed({ repoId, command, label });
    setDropdownOpen(false);
  }, []);

  const handleStop = useCallback(() => {
    if (runningEntry) {
      window.anvil.run.stop(runningEntry.repoId);
    }
  }, [runningEntry]);

  const handleMainClick = useCallback(() => {
    if (runningEntry) {
      handleStop();
      return;
    }
    if (lastUsed) {
      handleRun(lastUsed.repoId, lastUsed.command, lastUsed.label);
      return;
    }
    // No last-used — open dropdown or fallback
    const totalScripts = Object.values(scripts).reduce((sum, cmds) => sum + cmds.length, 0);
    if (totalScripts > 0) {
      setDropdownOpen((prev) => !prev);
    } else {
      setShowFallback(true);
    }
  }, [runningEntry, lastUsed, scripts, handleRun, handleStop]);

  // Status dot color
  const completedStatus = Object.values(statuses).find(
    (s) => s && !s.running && s.exitCode !== undefined,
  );
  const dotColor = completedStatus
    ? completedStatus.signal
      ? 'bg-text-tertiary'
      : completedStatus.exitCode === 0
        ? 'bg-success'
        : 'bg-error'
    : null;

  const handleDotClick = useCallback(async () => {
    if (!completedStatus) return;
    const output = await window.anvil.run.getOutput(completedStatus.repoId);
    // Copy to clipboard as a simple output viewer for now
    // Terminal panel integration can be added later
    if (output) {
      await copyTextToClipboard(output);
    }
  }, [completedStatus]);

  const totalScripts = Object.values(scripts).reduce((sum, cmds) => sum + cmds.length, 0);
  const buttonLabel = runningEntry
    ? runningEntry.command.length > 20
      ? runningEntry.command.slice(0, 20) + '...'
      : runningEntry.command
    : lastUsed
      ? lastUsed.label
      : totalScripts > 0
        ? 'Run'
        : 'Run...';

  if (repos.length === 0) return null;

  if (!featureAvailability.repoFeaturesEnabled) {
    return (
      <div className={`border-b border-border-subtle ${compact ? 'px-3 py-3' : 'px-5 py-3'}`}>
        <button
          disabled
          title={featureAvailability.repoFeatureReason ?? 'Repository setup is still in progress.'}
          className={`flex w-full items-center rounded-md bg-bg-tertiary py-2 text-sm font-medium text-text-tertiary opacity-70 ${
            compact ? 'justify-center px-2' : 'gap-2 px-3'
          }`}
        >
          <Play size={14} />
          {!compact && <span className="truncate">Run</span>}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={buttonRef}
      className={`relative border-b border-border-subtle ${compact ? 'px-1 py-3' : 'px-5 py-3'}`}
    >
      <div className="flex w-full min-w-0 items-center gap-1">
        {/* Status dot */}
        {dotColor && !runningEntry && (
          <button
            onClick={handleDotClick}
            className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`}
            title="Click to copy output"
          />
        )}

        {/* Main button */}
        <button
          data-run-trigger
          onClick={handleMainClick}
          title={runningEntry ? `Stop ${runningEntry.command}` : buttonLabel}
          aria-label={runningEntry ? `Stop ${runningEntry.command}` : buttonLabel}
          className={`flex min-w-0 flex-1 items-center rounded-md text-sm font-medium transition-colors ${
            runningEntry
              ? 'bg-error/15 text-error hover:bg-error/25'
              : 'bg-success/15 text-success hover:bg-success/25'
          } ${compact ? 'justify-center px-1 py-2' : 'gap-2 px-3 py-2'}`}
        >
          {runningEntry ? (
            <Loader2 size={14} className="shrink-0 animate-spin" />
          ) : (
            <Play size={14} className="shrink-0" />
          )}
          {!compact && <span className="min-w-0 truncate">{buttonLabel}</span>}
        </button>

        {/* Chevron — only if there are scripts to show */}
        {totalScripts > 0 && !runningEntry && (
          <button
            onClick={() => setDropdownOpen((prev) => !prev)}
            title="Choose run command"
            aria-label="Choose run command"
            aria-expanded={dropdownOpen}
            className={`shrink-0 rounded-md text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${compact ? 'p-1' : 'p-2'}`}
          >
            <ChevronDown size={14} className="shrink-0" />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {dropdownOpen && (
        <RunDropdown
          scripts={scripts}
          repos={repos}
          onRun={handleRun}
          onClose={() => setDropdownOpen(false)}
          compact={compact}
        />
      )}

      {/* Fallback panel */}
      {showFallback && !dropdownOpen && totalScripts === 0 && (
        <RunFallback
          repos={repos}
          onCommandSaved={(repoId, cmd) => {
            setScripts((prev) => ({
              ...prev,
              [repoId]: [...(prev[repoId] || []), cmd],
            }));
            setShowFallback(false);
          }}
          onAiDetected={(repoId, cmds) => {
            setScripts((prev) => ({
              ...prev,
              [repoId]: [...(prev[repoId] || []), ...cmds],
            }));
            setShowFallback(false);
          }}
          onClose={() => setShowFallback(false)}
        />
      )}
    </div>
  );
}
