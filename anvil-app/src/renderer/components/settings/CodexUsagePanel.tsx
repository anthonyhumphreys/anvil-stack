import { AlertTriangle, BarChart3, Clock3, Gauge, Loader2, RefreshCcw } from 'lucide-react';
import type { CodexUsageSnapshot } from '../../../shared/types';
import { MetricTile, ProgressBar, SummaryChip } from './settings-ui';

function formatTokenCount(value: number | null): string {
  if (value === null) return 'Unknown';
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatDays(value: number | null): string {
  if (value === null) return 'Unknown';
  return `${value}d`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return 'Unknown';
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDurationMins(value: number | null): string {
  if (value === null) return 'Unknown';
  if (value < 60) return `${value} min`;
  const hours = value / 60;
  if (Number.isInteger(hours)) return `${hours} hr`;
  return `${hours.toFixed(1)} hr`;
}

function formatResetTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function CodexQuotaRow({
  label,
  window,
}: {
  label: string;
  window: NonNullable<CodexUsageSnapshot['defaultLimit']>['primary'];
}) {
  if (!window) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-text-secondary">
          {window.remainingPercent}% left
          {window.resetsAt ? ` - resets ${formatResetTime(window.resetsAt)}` : ''}
        </span>
      </div>
      <ProgressBar percent={window.usedPercent} />
      <p className="text-xs text-text-tertiary">
        {formatDurationMins(window.windowDurationMins)} window, {window.usedPercent}% used
      </p>
    </div>
  );
}

export function CodexUsagePanel({
  snapshot,
  loading,
  onRefresh,
}: {
  snapshot: CodexUsageSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const defaultLimit = snapshot?.defaultLimit;
  const additionalLimits =
    snapshot?.limits.filter((limit) => limit.id !== defaultLimit?.id).slice(0, 3) ?? [];
  const recentBuckets = snapshot?.tokenUsage?.recentDailyBuckets ?? [];
  const peakRecentTokens = Math.max(1, ...recentBuckets.map((bucket) => bucket.tokens));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <SummaryChip
            label="CLI"
            value={
              snapshot?.cliInstalled
                ? snapshot.cliVersion || 'Installed'
                : loading
                  ? 'Checking'
                  : 'Missing'
            }
          />
          {defaultLimit?.planType && <SummaryChip label="Plan" value={defaultLimit.planType} />}
          {snapshot?.resetCreditsAvailable !== null &&
            snapshot?.resetCreditsAvailable !== undefined && (
              <SummaryChip label="Resets" value={String(snapshot.resetCreditsAvailable)} />
            )}
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
          Refresh
        </button>
      </div>

      {snapshot?.status === 'unavailable' && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            {snapshot.error ||
              'Codex usage is not available from the local CLI. Run codex login, then refresh.'}
          </span>
        </div>
      )}

      {!snapshot && loading && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin" />
          Reading Codex account usage
        </div>
      )}

      {defaultLimit && (
        <div className="rounded-md border border-border bg-bg-primary p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Gauge size={16} className="shrink-0 text-accent" />
              <h5 className="truncate text-sm font-semibold text-text-primary">
                {defaultLimit.label} quota
              </h5>
            </div>
            {defaultLimit.rateLimitReachedType && (
              <span className="rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-xs text-error">
                Limited
              </span>
            )}
          </div>
          <div className="space-y-3">
            {defaultLimit.primary && (
              <CodexQuotaRow label="Session" window={defaultLimit.primary} />
            )}
            {defaultLimit.secondary && (
              <CodexQuotaRow label="Weekly" window={defaultLimit.secondary} />
            )}
          </div>
          {defaultLimit.credits && (
            <p className="mt-3 text-xs text-text-tertiary">
              Credits:{' '}
              {defaultLimit.credits.unlimited
                ? 'unlimited'
                : defaultLimit.credits.hasCredits
                  ? defaultLimit.credits.balance || 'available'
                  : 'none available'}
            </p>
          )}
        </div>
      )}

      {snapshot?.tokenUsage && (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="rounded-md border border-border bg-bg-primary p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <BarChart3 size={16} className="text-accent" />
              Token usage
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricTile
                label="Lifetime"
                value={formatTokenCount(snapshot.tokenUsage.lifetimeTokens)}
              />
              <MetricTile
                label="Peak day"
                value={formatTokenCount(snapshot.tokenUsage.peakDailyTokens)}
              />
              <MetricTile
                label="Current streak"
                value={formatDays(snapshot.tokenUsage.currentStreakDays)}
              />
              <MetricTile
                label="Longest turn"
                value={formatSeconds(snapshot.tokenUsage.longestRunningTurnSec)}
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-bg-primary p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Clock3 size={16} className="text-accent" />
              Recent daily tokens
            </div>
            {recentBuckets.length === 0 ? (
              <p className="text-sm text-text-tertiary">No recent token buckets reported.</p>
            ) : (
              <div className="flex h-28 items-end gap-1">
                {recentBuckets.map((bucket) => (
                  <div
                    key={bucket.startDate}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1"
                    title={`${bucket.startDate}: ${formatTokenCount(bucket.tokens)}`}
                  >
                    <div className="flex h-20 w-full items-end rounded-sm bg-bg-tertiary">
                      <div
                        className="w-full rounded-sm bg-accent/80"
                        style={{
                          height: `${Math.max(4, (bucket.tokens / peakRecentTokens) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="text-eyebrow max-w-full truncate text-text-tertiary">
                      {formatShortDate(bucket.startDate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {additionalLimits.length > 0 && (
        <div className="rounded-md border border-border bg-bg-primary p-4">
          <h5 className="mb-3 text-sm font-semibold text-text-primary">Model-specific limits</h5>
          <div className="space-y-3">
            {additionalLimits.map((limit) => (
              <div key={limit.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {limit.label}
                  </span>
                  {limit.primary && (
                    <span className="shrink-0 text-xs text-text-tertiary">
                      {limit.primary.remainingPercent}% left
                    </span>
                  )}
                </div>
                {limit.primary && <ProgressBar percent={limit.primary.usedPercent} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshot?.refreshedAt && (
        <p className="text-xs text-text-tertiary">
          Last checked {new Date(snapshot.refreshedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
