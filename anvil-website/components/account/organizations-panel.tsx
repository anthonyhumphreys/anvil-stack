"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import type { ActionResult } from "@/app/account/actions";
import type { HostedOrganization, HostedOrganizationRole } from "@/lib/hosted/types";
import {
  createOrganizationAction,
  createOrganizationPortalAction,
  inviteOrganizationMemberAction,
  leaveOrganizationAction,
  removeOrganizationMemberAction,
  revokeOrganizationInvitationAction,
  updateOrganizationRoleAction
} from "@/app/account/organizations/actions";

type Notice = { ok: boolean; message: string };

function actionNotice<T>(result: ActionResult<T>, message: string): Notice {
  return result.ok ? { ok: true, message } : { ok: false, message: result.message };
}

function invitationExpiry(value: string | number): string {
  const timestamp = typeof value === "number" && value < 1_000_000_000_000 ? value * 1000 : value;
  return formatDate(timestamp) ?? "date unavailable";
}

export function OrganizationsPanel({
  organizations,
  currentUserId
}: {
  organizations: HostedOrganization[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice | null>(null);

  function run(mutation: () => Promise<Notice>, refreshOnSuccess = true) {
    setNotice(null);
    startTransition(async () => {
      const result = await mutation();
      setNotice(result);
      if (result.ok && refreshOnSuccess) router.refresh();
    });
  }

  return (
    <div className="grid gap-6">
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        Organisations provide membership, role, invitation, and legacy billing administration.
        They do not share workspaces, devices, or Sync &amp; Mesh data; each person&apos;s Sync &amp;
        Mesh access is independent.
      </p>
      {notice ? (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`rounded-md border px-4 py-3 text-sm ${notice.ok ? "bg-muted/30" : "border-destructive/50"}`}
        >
          {notice.message}
        </p>
      ) : null}
      <CreateOrganizationForm pending={pending} run={run} />
      {organizations.length === 0 ? (
        <p className="border-y py-6 text-sm leading-6 text-muted-foreground">
          No organisation records are linked to this account yet.
        </p>
      ) : null}
      {organizations.map((organization) => (
        <OrganizationRecord
          key={organization.id}
          organization={organization}
          currentUserId={currentUserId}
          pending={pending}
          run={run}
        />
      ))}
    </div>
  );
}

function CreateOrganizationForm({
  pending,
  run
}: {
  pending: boolean;
  run: (mutation: () => Promise<Notice>, refreshOnSuccess?: boolean) => void;
}) {
  const [name, setName] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(async () => {
      const result = await createOrganizationAction(name);
      if (!result.ok) return { ok: false, message: result.message };
      setName("");
      return { ok: true, message: `${result.data.organization.name} created.` };
    });
  }

  return (
    <section className="grid gap-3 border-y py-5" aria-labelledby="create-organization-title">
      <div>
        <h2 id="create-organization-title" className="font-semibold">Create an organisation</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          New organisations have five allocated member seats, including the owner. Existing owner
          seat opt-outs are preserved, so total membership can differ from allocated seats.
        </p>
      </div>
      <form className="grid max-w-xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submit}>
        <label className="sr-only" htmlFor="new-organization-name">Organisation name</label>
        <input
          id="new-organization-name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          required
          minLength={2}
          maxLength={80}
          autoComplete="organization"
          className="h-10 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder="Organisation name"
        />
        <Button type="submit" variant="outline" disabled={pending || name.trim().length < 2}>
          {pending ? "Creating…" : "Create organisation"}
        </Button>
      </form>
    </section>
  );
}

function OrganizationRecord({
  organization,
  currentUserId,
  pending,
  run
}: {
  organization: HostedOrganization;
  currentUserId: string;
  pending: boolean;
  run: (mutation: () => Promise<Notice>, refreshOnSuccess?: boolean) => void;
}) {
  const owner = organization.membership.role === "owner";
  const closed = organization.status === "closed" || organization.billingRecoveryOnly === true;
  const hasLegacyBilling = organization.billing.status !== null;

  function openBillingPortal() {
    run(async () => {
      const result = await createOrganizationPortalAction(organization.id);
      if (!result.ok) return { ok: false, message: result.message };
      window.location.assign(result.data.portalUrl);
      return { ok: true, message: "Opening the payment portal…" };
    }, false);
  }

  return (
    <article className="grid gap-5 border-y py-6" aria-labelledby={`organization-${organization.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h2 id={`organization-${organization.id}`} className="text-xl font-semibold">
            {organization.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            {closed ? "Closed organisation record" : `${owner ? "Owner" : "Member"} · membership only`}
          </p>
        </div>
        {owner && hasLegacyBilling ? (
          <Button type="button" variant="outline" onClick={openBillingPortal} disabled={pending}>
            {pending ? "Opening…" : "Review or cancel legacy billing"}
          </Button>
        ) : null}
      </header>

      {hasLegacyBilling ? (
        <section className="grid gap-3 rounded-md border bg-muted/20 p-4" aria-labelledby={`billing-${organization.id}`}>
          <div>
            <h3 id={`billing-${organization.id}`} className="font-medium">
              Legacy subscription record
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Sync &amp; Mesh are free. This record does not change anyone&apos;s access.
            </p>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Status</dt>
              <dd className="mt-0.5">{organization.billing.status}</dd>
            </div>
            {organization.billing.interval ? (
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Billing interval</dt>
                <dd className="mt-0.5">{organization.billing.interval === "year" ? "Annual" : "Monthly"}</dd>
              </div>
            ) : null}
            {organization.billing.currentPeriodEnd !== null ? (
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Period ends</dt>
                <dd className="mt-0.5">{formatDate(organization.billing.currentPeriodEnd) ?? "—"}</dd>
              </div>
            ) : null}
            {organization.billing.cancelAtPeriodEnd ? (
              <div className="sm:col-span-3 text-xs text-muted-foreground">
                Cancellation is scheduled for the end of this period.
              </div>
            ) : null}
          </dl>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">No legacy subscription record is on file.</p>
      )}

      {!closed ? (
        <section className="grid gap-3" aria-labelledby={`members-${organization.id}`}>
          <div>
            <h3 id={`members-${organization.id}`} className="font-medium">Members</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Organisation membership does not grant access to another person&apos;s workspaces or data.
            </p>
          </div>
          <ul className="divide-y rounded-md border">
            {organization.members.map((member) => {
              const isCurrentUser = member.workosUserId === currentUserId;
              return (
                <li key={member.workosUserId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="grid gap-0.5">
                    <span className="text-sm">{member.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {member.role === "owner" ? "Owner" : "Member"}{isCurrentUser ? " · You" : ""}
                    </span>
                  </div>
                  {owner && !isCurrentUser ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                          const role: HostedOrganizationRole = member.role === "owner" ? "member" : "owner";
                          run(async () => actionNotice(
                            await updateOrganizationRoleAction(organization.id, member.workosUserId, role),
                            `${member.email} is now ${role === "owner" ? "an owner" : "a member"}.`
                          ));
                        }}
                      >
                        Make {member.role === "owner" ? "member" : "owner"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                          if (!window.confirm(`Remove ${member.email} from ${organization.name}? Their account, devices, and Sync & Mesh access stay with them.`)) return;
                          run(async () => actionNotice(
                            await removeOrganizationMemberAction(organization.id, member.workosUserId),
                            `${member.email} was removed from the organisation.`
                          ));
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {owner ? (
            <InviteForm organization={organization} pending={pending} run={run} />
          ) : (
            <Button
              type="button"
              className="w-fit"
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Leave ${organization.name}? Your organisation membership ends; your account, devices, and Sync & Mesh access stay with you.`)) return;
                run(async () => actionNotice(
                  await leaveOrganizationAction(organization.id),
                  `You left ${organization.name}.`
                ));
              }}
            >
              Leave organisation
            </Button>
          )}

          {organization.invitations.length > 0 ? (
            <div className="grid gap-2">
              <h4 className="text-sm font-medium">Pending invitations</h4>
              <ul className="divide-y rounded-md border">
                {organization.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="grid gap-0.5">
                      <span className="text-sm">{invitation.email}</span>
                      <span className="text-xs text-muted-foreground">
                        {invitation.state} · expires {invitationExpiry(invitation.expiresAt)}
                      </span>
                    </div>
                    {owner ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => run(async () => actionNotice(
                          await revokeOrganizationInvitationAction(organization.id, invitation.id),
                          `Invitation for ${invitation.email} was revoked.`
                        ))}
                      >
                        Revoke invitation
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

function InviteForm({
  organization,
  pending,
  run
}: {
  organization: HostedOrganization;
  pending: boolean;
  run: (mutation: () => Promise<Notice>, refreshOnSuccess?: boolean) => void;
}) {
  const [email, setEmail] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.length === 0) return;
    run(async () => {
      const result = await inviteOrganizationMemberAction(organization.id, normalizedEmail);
      const message = result.ok
        ? `Invitation sent to ${normalizedEmail}.`
        : result.message;
      if (result.ok) setEmail("");
      return { ok: result.ok, message };
    });
  }

  return (
    <form className="grid max-w-xl gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submit}>
      <label className="sr-only" htmlFor={`invite-email-${organization.id}`}>Invitee email</label>
      <input
        id={`invite-email-${organization.id}`}
        type="email"
        autoComplete="email"
        required
        maxLength={254}
        value={email}
        onChange={(event) => setEmail(event.currentTarget.value)}
        placeholder="name@example.com"
        className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <Button type="submit" variant="outline" disabled={pending || email.trim().length === 0}>
        {pending ? "Sending…" : "Invite member"}
      </Button>
    </form>
  );
}
