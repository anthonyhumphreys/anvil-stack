// BILL-06 observability: structured metric lines on stdout. Workers
// observability / Workers Logs pick these up; dashboards and alert
// routing live outside the worker (docs/runbooks/hosted-sync/metrics.md).
//
// Log hygiene is load-bearing: fields may carry states, counts, paths,
// and opaque ids — never secrets, enrollment/link codes, synced content,
// card or payment details, or signature values.

/** Emits one JSON metric line; failures must never break the request path. */
export function emitMetric(name: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(JSON.stringify({ metric: name, ts: Date.now(), ...fields }));
  } catch {
    // Metric emission is best-effort observability, not business logic.
  }
}
