import { Badge } from "@/components/ui/badge";
import type { HostedAccessState, HostedEntitlement } from "@/lib/hosted/types";
import { formatDate } from "@/lib/format";

const STATE_LABELS: Record<HostedAccessState, string> = {
  preview: "Legacy preview",
  active: "Active",
  grace: "Legacy billing grace",
  restricted: "Restricted",
  unknown: "Unknown"
};

export function EntitlementStateBadge({ state }: { state: HostedAccessState }) {
  const variant =
    state === "active" || state === "preview"
      ? "secondary"
      : state === "grace"
        ? "outline"
        : state === "restricted"
          ? "destructive"
          : "outline";
  return (
    <Badge variant={variant} className={state === "preview" || state === "grace" ? "border-accent/60" : undefined}>
      {STATE_LABELS[state]}
    </Badge>
  );
}

/** Honest one-line summary of what the entitlement currently grants. */
export function entitlementSummary(entitlement: HostedEntitlement): string {
  switch (entitlement.state) {
    case "preview": {
      return "Sync & Mesh are free. This account still reports a legacy preview state.";
    }
    case "active": {
      return entitlement.reason === "free"
        ? "Sync & Mesh access is active and does not require a subscription."
        : "Sync & Mesh access is active.";
    }
    case "grace": {
      const until = formatDate(entitlement.graceUntil);
      return until
        ? `A legacy billing record is in grace until ${until}. Sync & Mesh access does not depend on billing.`
        : "A legacy billing record is in grace. Sync & Mesh access does not depend on billing.";
    }
    case "restricted":
      return "The backend reports this account as restricted. This can reflect an account, security, or policy decision.";
    case "unknown":
      return "The backend could not determine the entitlement state.";
  }
}
