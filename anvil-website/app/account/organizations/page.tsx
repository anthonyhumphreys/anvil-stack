import type { Metadata } from "next";
import Link from "next/link";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { OrganizationsPanel } from "@/components/account/organizations-panel";
import { loadAccountContext, tryHosted } from "@/lib/account";
import { listOrganizations } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Organisation membership | Anvil", robots: { index: false } };

export default async function OrganizationsPage({
  searchParams
}: {
  searchParams: Promise<{ invite?: string }>;
}) {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;
  if (ctx.status === "backend-unconfigured") return <BackendNotConfigured />;
  const params = await searchParams;
  return <OrganizationData identity={ctx.identity} inviteState={params.invite} />;
}

async function OrganizationData({
  identity,
  inviteState
}: {
  identity: HostedIdentity;
  inviteState?: string;
}) {
  const organizations = await tryHosted(() => listOrganizations(identity));

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Organisation membership</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Manage membership, invitations, roles, and legacy billing records. Membership does not
          share workspaces, devices, or Sync &amp; Mesh data; each person&apos;s Sync &amp; Mesh
          access stays independent.
        </p>
      </header>

      {inviteState === "accepted" ? (
        <p role="status" className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
          Your organisation invitation was accepted.
        </p>
      ) : inviteState === "invalid" ? (
        <p role="alert" className="rounded-md border border-destructive/50 px-4 py-3 text-sm">
          This invitation is invalid, expired, or was issued to another account. Ask the owner to
          send a new invitation to your admitted Anvil account.
        </p>
      ) : inviteState === "unavailable" ? (
        <p role="alert" className="rounded-md border border-destructive/50 px-4 py-3 text-sm">
          Anvil could not finish accepting this invitation. Your WorkOS sign-in is intact; try
          opening the invitation link again or ask the owner to check its status.
        </p>
      ) : inviteState === "waitlist" ? (
        <p role="alert" className="rounded-md border px-4 py-3 text-sm">
          WorkOS account approval is required for hosted Sync &amp; Mesh.{" "}
          <Link href="/waitlist" className="font-medium underline underline-offset-4">
            Request access
          </Link>{" "}
          then ask the organisation owner to send a new invitation after your account is admitted.
        </p>
      ) : inviteState === "member-limit" ? (
        <p role="alert" className="rounded-md border px-4 py-3 text-sm">
          This organisation has reached its limit of five allocated member seats. Ask the service
          operator whether a higher fair-use limit is available.
        </p>
      ) : null}

      {organizations.ok || organizations.code === "not-found" ? (
        <OrganizationsPanel
          organizations={organizations.ok ? organizations.data.organizations : []}
          currentUserId={identity.workosUserId}
        />
      ) : (
        <p role="alert" className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
          {organizations.code === "unconfigured"
            ? "Organisation records are not configured on this deployment."
            : `Could not load organisations (${organizations.status || "network"}). Try again shortly.`}
        </p>
      )}

      <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
        Invitations are limited to people with an admitted Anvil account. New members must pass the
        WorkOS account approval flow first. Removing someone from an organisation changes only that
        membership; their account, devices, and Sync &amp; Mesh access stay with them. Owners can
        review or cancel old subscription records from the payment portal.
      </p>
    </div>
  );
}
