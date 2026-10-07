const visibleFields = [
  ["entity id", "wrk_01J4…"],
  ["type", "workspace.definition"],
  ["revision", "47"],
  ["size", "2.1 KB"],
  ["sealed", "aes-256-gcm · adk v3"]
] as const;

const entityFields = [
  ["name", "anvil-stack · api"],
  ["repos", "2 checkouts pinned"],
  ["template", "delivery-review"],
  ["settings", "model prefs, theme"]
] as const;

export function EnvelopeBoundary({ className }: { className?: string }) {
  return (
    <figure className={className} role="group" aria-labelledby="envelope-boundary-title">
      <figcaption id="envelope-boundary-title" className="sr-only">
        Diagram: on your device an entity reads as plain fields. On the wire it becomes a sealed
        envelope — the server can see the id, type, revision, size and seal metadata, but the
        content stays ciphertext until a paired device unseals it.
      </figcaption>
      <div className="forge-panel">
        <div className="forge-window-bar" aria-hidden="true">
          <span className="dot dot--ember" />
          <span className="dot" />
          <span className="dot" />
          <span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
            the crypto boundary
          </span>
        </div>
        <div className="grid gap-0 sm:grid-cols-[1fr_auto_1fr]" aria-hidden="true">
          {/* device view */}
          <div className="border-b border-[oklch(var(--forge-line))] p-5 sm:border-b-0 sm:border-r">
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[oklch(var(--forge-dim))]">
              on your device
            </p>
            <div className="mt-4 rounded-md border border-[oklch(var(--forge-line))] bg-[oklch(var(--forge-raised))]">
              <div className="border-b border-[oklch(var(--forge-line))] px-4 py-2.5">
                <p className="font-mono text-xs text-[oklch(var(--forge-text))]">entity · plaintext</p>
              </div>
              <dl className="grid gap-0 px-4 py-3">
                {entityFields.map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 py-1">
                    <dt className="font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">{key}</dt>
                    <dd className="font-mono text-xs text-[oklch(var(--forge-text))]">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <p className="mt-3 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
              readable — SQLite, safeStorage-wrapped keys
            </p>
          </div>

          {/* seal arrow */}
          <div className="flex items-center justify-center gap-2 px-4 py-5 sm:flex-col sm:px-3">
            <span className="font-mono text-[0.6875rem] text-[oklch(var(--forge-ember))]">seal</span>
            <svg width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">
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

          {/* wire view */}
          <div className="p-5">
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-[oklch(var(--forge-dim))]">
              on the wire — what the server sees
            </p>
            <div className="mt-4 rounded-md border border-[oklch(var(--forge-ember))]/40 bg-[oklch(var(--forge-raised))]">
              <div className="border-b border-[oklch(var(--forge-line))] px-4 py-2.5">
                <p className="font-mono text-xs text-[oklch(var(--forge-ember))]">envelope · ciphertext</p>
              </div>
              <dl className="grid gap-0 px-4 py-3">
                {visibleFields.map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-4 py-1">
                    <dt className="font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">{key}</dt>
                    <dd className="font-mono text-xs text-[oklch(var(--forge-text))]">{value}</dd>
                  </div>
                ))}
                <div className="mt-2 rounded border border-dashed border-[oklch(var(--forge-faint))] px-3 py-2">
                  <p className="font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
                    payload · ████████████████
                  </p>
                </div>
              </dl>
            </div>
            <p className="mt-3 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">
              shape, not content — journaled opaquely
            </p>
          </div>
        </div>
      </div>
    </figure>
  );
}
