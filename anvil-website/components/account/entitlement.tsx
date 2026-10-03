import { Badge } from "@/components/ui/badge";
import type { HostedAccessState, HostedEntitlement } from "@/lib/hosted/types";
import { formatDate } from "@/lib/format";

const STATE_LABELS: Record<HostedAccessState, string> = {
  preview: "Preview",
  active: "Active",
  grace: "Grace",
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
    <Badge variant={variant} className={state === "preview" ? "border-accent/60" : undefined}>
      {STATE_LABELS[state]}
    </Badge>
  );
}

/** Honest one-line summary of what the entitlement currently grants. */
export function entitlementSummary(entitlement: HostedEntitlement): string {
  switch (entitlement.state) {
    case "preview": {
      const ends = formatDate(entitlement.previewEndsAt);
      return ends
        ? `Hosted sync is free during the preview — access runs through ${ends}.`
        : "Hosted sync is free during the preview.";
    }
    case "active": {
      const until = formatDate(entitlement.accessUntil);
      return until
        ? `Paid sync access — current period ends ${until}.`
        : "Paid sync access is active.";
    }
    case "grace": {
      const until = formatDate(entitlement.graceUntil);
      return until
        ? `A renewal failed or billing is unreachable — access continues in grace until ${until}.`
        : "Access continues in a bounded grace period.";
    }
    case "restricted":
      return "Hosted sync is restricted for this account — see Billing for the reason.";
    case "unknown":
      return "The backend could not determine the entitlement state.";
  }
}
