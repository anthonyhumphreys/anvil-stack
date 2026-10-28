import { Badge } from "@/components/ui/badge";
import type { HostedAccessState, HostedEntitlement } from "@/lib/hosted/types";
import { formatDate } from "@/lib/format";

const STATE_LABELS: Record<HostedAccessState, string> = {
  preview: "Beta access",
  active: "Active",
  grace: "Billing grace",
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
      const until = formatDate(entitlement.accessUntil);
      return until ? `Invited beta access is active until ${until}. No subscription is needed during this period.` : "Invited beta access is active.";
    }
    case "active": {
      return entitlement.reason === "free"
        ? "Self-hosted Sync & Mesh access is active. No Mezair subscription is required."
        : "Your subscription includes hosted Sync & Mesh.";
    }
    case "grace": {
      const until = formatDate(entitlement.graceUntil);
      return until
        ? `Hosted access continues until ${until}. Check billing before the grace period ends.`
        : "Hosted access is in a billing grace period. Check your subscription.";
    }
    case "restricted":
      return entitlement.reason === "subscription-required" || entitlement.reason === "preview-ended"
        ? "Hosted Sync & Mesh needs a subscription or a valid beta code. Local work, reads, exports and account recovery remain available."
        : entitlement.reason === "device-limit-exceeded"
          ? "Hosted writes are paused because this account exceeds its device limit. Revoke a device to resume."
          : "Hosted writes are restricted by account or service policy. Local work remains available.";
    case "unknown":
      return "The backend could not determine the entitlement state.";
  }
}
