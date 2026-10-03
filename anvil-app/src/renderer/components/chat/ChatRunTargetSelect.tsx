import { Cloud, Monitor } from 'lucide-react';
import { HOSTED_CHAT_TARGET, type useChatRunTarget } from './useChatRunTarget';

export function ChatRunTargetSelect({
  run,
  disabled,
}: {
  run: ReturnType<typeof useChatRunTarget>;
  disabled: boolean;
}) {
  const Icon = run.hosted ? Cloud : Monitor;
  return (
    <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-within:ring-2 focus-within:ring-accent/70">
      <Icon size={14} aria-hidden="true" className="shrink-0" />
      <span className="shrink-0">Run on</span>
      <select
        aria-label="Run on"
        className="min-w-0 max-w-48 cursor-pointer bg-transparent text-text-primary focus:outline-none disabled:cursor-default"
        value={run.target}
        disabled={disabled || run.busy || run.record !== undefined}
        onChange={(event) => run.setTarget(event.target.value)}
        title={
          run.record
            ? 'This chat stays on its destination. Start a new chat to change where it runs.'
            : undefined
        }
      >
        <option value="local">This device</option>
        <option value={HOSTED_CHAT_TARGET}>Anvil hosted cloud</option>
        {run.devices.map((device) => (
          <option key={device.enrollmentId} value={device.enrollmentId}>
            {device.displayName ?? 'Remote device'}
          </option>
        ))}
        {run.record &&
          !run.hosted &&
          !run.devices.some((device) => device.enrollmentId === run.target) && (
            <option value={run.target}>Remote device</option>
          )}
      </select>
    </label>
  );
}
