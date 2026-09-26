import type { Metadata } from "next";
import Link from "next/link";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { OrganizationsPanel } from "@/components/account/organizations-panel";
import { loadAccountContext, tryHosted } from "@/lib/account";
import { listOrganizations } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Organisation billing | Anvil", robots: { index: false } };

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
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Organisation billing</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          A team account pays for hosted access for named developers. It does not share their
          workspaces, repositories, artifacts, devices, or workers.
        </p>
      </header>

      {inviteState === "accepted" ? (
        <p role="status" className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
          Your organisation invitation was accepted and its seat is active.
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
          Hosted access requires WorkOS waitlist approval.{" "}
          <Link href="/waitlist" className="font-medium underline underline-offset-4">
            Request access
          </Link>{" "}
          then ask the organisation owner to send a new invitation after your account is admitted.
        </p>
      ) : null}

      {organizations.ok ? (
        <OrganizationsPanel
          organizations={organizations.data.organizations}
          currentUserId={identity.workosUserId}
        />
      ) : (
        <p role="alert" className="rounded-md border px-4 py-3 text-sm text-muted-foreground">
          {organizations.code === "not-found"
            ? "No organisation billing is available for this account yet."
            : organizations.code === "unconfigured"
              ? "Organisation billing is not configured on this deployment."
              : `Could not load organisations (${organizations.status || "network"}). Try again shortly.`}
        </p>
      )}

      <p className="max-w-3xl text-xs leading-5 text-muted-foreground">
        Team invitations are limited to people who already have an Anvil account. New teammates
        must be admitted through the WorkOS waitlist first. Removing a seat ends hosted access paid
        by that organisation but does not delete the person&apos;s account or private data.
      </p>
    </div>
  );
}
