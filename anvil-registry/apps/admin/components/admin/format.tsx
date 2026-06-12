import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PolicyDecisionRecord } from "@anvilstack/persistence";

export function packageHref(packageName: string, version: string) {
  return `/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

export function formatDate(value?: string) {
  return value ? new Date(value).toISOString() : "";
}

export function shortMiddle(value: string | undefined, maxLength = 34) {
  if (!value) return "none";
  if (value.length <= maxLength) return value;
  const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, edge)}...${value.slice(-edge)}`;
}

export function actionTone(action: string) {
  if (action === "block") return "destructive";
  if (action === "quarantine" || action === "warn") return "secondary";
  return "outline";
}

export function Score({ value }: { value: number }) {
  const tone = value >= 95 ? "border-destructive/40 bg-destructive/10 text-destructive" : value >= 35 ? "border-accent/40 bg-accent/10 text-foreground" : "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex min-w-11 items-center justify-center rounded-md border px-2 py-1 text-sm font-semibold", tone)}>{value}</span>;
}

export function PackageLink({ packageName, version }: { packageName: string; version: string }) {
  return (
    <Link className="font-mono text-[13px] font-medium underline-offset-4 hover:underline" href={packageHref(packageName, version)}>
      {packageName}@{version}
    </Link>
  );
}

export function IdentityStack({ integrity, shasum, analyser }: { integrity?: string; shasum?: string; analyser?: string }) {
  const rows = [
    ["integrity", integrity],
    ["shasum", shasum],
    ["analyser", analyser]
  ].filter((row): row is [string, string] => Boolean(row[1]));

  if (rows.length === 0) return <span className="text-muted-foreground">legacy</span>;

  return (
    <span className="grid min-w-56 gap-1">
      {rows.map(([label, value]) => (
        <span key={label} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]" title={value}>
            {shortMiddle(value, 34)}
          </code>
        </span>
      ))}
    </span>
  );
}

export function ReasonSummary({ decision }: { decision: PolicyDecisionRecord["decision"] }) {
  const [primary, ...rest] = decision.reasons;
  if (!primary) return <span>{decision.explanation}</span>;

  return (
    <div className="flex max-w-[58ch] flex-col gap-2">
      <div className="flex items-start gap-2">
        <Badge variant="secondary">{primary.severity}</Badge>
        <span>{primary.message}</span>
      </div>
      {rest.length > 0 ? (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">{rest.length} more {rest.length === 1 ? "reason" : "reasons"}</summary>
          <div className="mt-2 flex flex-col gap-2">
            {rest.map((reason) => (
              <div key={`${reason.code}:${reason.message}`} className="flex items-start gap-2 rounded-md border bg-muted/35 p-2">
                <Badge variant={reason.severity === "high" || reason.severity === "critical" ? "destructive" : "secondary"}>{reason.severity}</Badge>
                <span>
                  <strong className="font-mono text-[12px]">{reason.code}</strong> {reason.message}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
