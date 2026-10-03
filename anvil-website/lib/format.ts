// Small display helpers shared by server and client components — keep this
// module free of `server-only` so client components can import it.

/** "31 October 2026" style dates for entitlement timestamps. */
export function formatDate(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 10 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

/** Shortened id for display: first `head` chars + ellipsis. */
export function shortId(id: string, head = 10): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`;
}
