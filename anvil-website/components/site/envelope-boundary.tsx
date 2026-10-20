const wireFields = [
  ["id", "wrk_01J4…"],
  ["type", "workspace.definition"],
  ["revision", "47"],
  ["size", "2.1 KB"],
  ["encryption", "AES-256-GCM, key v3"]
] as const;

const entityFields = [
  ["name", "anvil-stack api"],
  ["repositories", "2 connected"],
  ["template", "delivery-review"],
  ["settings", "model, theme"]
] as const;

/** What a synced workspace looks like on your machine, and what the server gets instead. */
export function EnvelopeBoundary({ className }: { className?: string }) {
  return (
    <figure className={className} role="group" aria-labelledby="envelope-boundary-title">
      <figcaption id="envelope-boundary-title" className="sr-only">
        On your machine a synced workspace reads as plain fields. Before it leaves, your device encrypts it. The server can see its id, type, revision, size and encryption format, but the
        contents stay encrypted until another of your devices opens it.
      </figcaption>
      <div className="forge-panel">
        <div className="forge-window-bar" aria-hidden="true">
          <span className="dot dot--ember" />
          <span className="dot" />
          <span className="dot" />
          <span className="ml-2 text-[0.75rem] text-[oklch(var(--forge-dim))]">One workspace, two views</span>
        </div>
        <div className="grid sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" aria-hidden="true">
          <div className="border-b border-[oklch(var(--forge-line))] p-5 sm:border-b-0 sm:border-r">
            <p className="text-[0.8125rem] font-semibold text-[oklch(var(--forge-text))]">On your machine</p>
            <div className="mt-4 rounded-lg border border-[oklch(var(--forge-line))] bg-[oklch(var(--forge-raised))]">
              <dl className="grid grid-cols-1 px-4 py-3">
                {entityFields.map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 py-1">
                    <dt className="text-[0.75rem] text-[oklch(var(--forge-dim))]">{key}</dt>
                    <dd className="min-w-0 break-words text-right font-mono text-xs text-[oklch(var(--forge-text))]">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <p className="mt-3 text-[0.75rem] text-[oklch(var(--forge-dim))]">Readable, stored locally</p>
          </div>

          <div className="flex items-center justify-center gap-2 px-4 py-5 sm:flex-col sm:px-3">
            <span className="text-[0.75rem] font-semibold text-[oklch(var(--forge-ember))]">encrypted</span>
            <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden="true" className="sm:rotate-0">
              <path
                d="M0 6 H24 M20 1.5 L26 6 L20 10.5"
                fill="none"
                stroke="oklch(var(--forge-ember))"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div className="p-5">
            <p className="text-[0.8125rem] font-semibold text-[oklch(var(--forge-text))]">What the server gets</p>
            <div className="mt-4 rounded-lg border border-[oklch(var(--forge-ember)/0.45)] bg-[oklch(var(--forge-raised))]">
              <dl className="grid grid-cols-1 px-4 py-3">
                {wireFields.map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 py-1">
                    <dt className="text-[0.75rem] text-[oklch(var(--forge-dim))]">{key}</dt>
                    <dd className="min-w-0 break-words text-right font-mono text-xs text-[oklch(var(--forge-text))]">{value}</dd>
                  </div>
                ))}
                <div className="mt-2 rounded border border-dashed border-[oklch(var(--forge-faint))] px-3 py-2">
                  <p className="truncate font-mono text-[0.6875rem] tracking-[0.12em] text-[oklch(var(--forge-dim))]">
                    ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
                  </p>
                </div>
              </dl>
            </div>
            <p className="mt-3 text-[0.75rem] text-[oklch(var(--forge-dim))]">Metadata is visible. Workspace contents stay encrypted.</p>
          </div>
        </div>
      </div>
    </figure>
  );
}
