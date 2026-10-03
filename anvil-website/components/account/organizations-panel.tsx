"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import type { ActionResult } from "@/app/account/actions";
import type {
  HostedOrganization,
  HostedOrganizationRole,
  HostedSeatIncreaseQuote
} from "@/lib/hosted/types";
import {
  createOrganizationAction,
  closeOrganizationAction,
  createOrganizationPortalAction,
  createTeamCheckoutAction,
  quoteOrganizationSeatIncreaseAction,
  confirmOrganizationSeatIncreaseAction,
  inviteOrganizationMemberAction,
  leaveOrganizationAction,
  removeOrganizationMemberAction,
  revokeOrganizationInvitationAction,
  updateOrganizationRoleAction,
  updateOrganizationMemberSeatAction,
  updateOrganizationSeatsAction
} from "@/app/account/organizations/actions";

type OrganizationMutation =
  | { ok: true; message: string }
  | { ok: false; message: string };

function fromAction<T>(result: ActionResult<T>, success: string): OrganizationMutation {
  return result.ok ? { ok: true, message: success } : { ok: false, message: result.message };
}

function teamPrice(seats: number, interval: "month" | "year"): number {
  return interval === "month" ? 35 + Math.max(0, seats - 5) * 7 : 350 + Math.max(0, seats - 5) * 70;
}

function money(price: number, interval: "month" | "year"): string {
  return `£${price} / ${interval === "month" ? "month" : "year"}`;
}

function moneyMinor(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency.toUpperCase()
  }).format(amount / 100);
}

function quoteDate(timestamp: number): string {
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  if (Number.isNaN(date.getTime())) return "time unavailable";
  return `${date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
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
  const [notice, setNotice] = useState<OrganizationMutation | null>(null);

  function run(mutation: () => Promise<OrganizationMutation>, refreshOnSuccess = true) {
    setNotice(null);
    startTransition(async () => {
      const result = await mutation();
      setNotice(result);
      if (result.ok && refreshOnSuccess) router.refresh();
    });
  }

  return (
    <div className="grid gap-6">
      {notice ? (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`rounded-md border px-4 py-3 text-sm ${notice.ok ? "bg-muted/30" : "border-destructive/50"}`}
        >
          {notice.message}
        </p>
      ) : null}

      {organizations.map((organization) => (
        organization.billingRecoveryOnly ? (
          <ClosedOrganizationRecoverySection
            key={organization.id}
            organization={organization}
            pending={pending}
            run={run}
          />
        ) : (
          <OrganizationSection
            key={`${organization.id}:${organization.billing.seatCapacity}:${organization.billing.scheduledSeatCapacity ?? "unscheduled"}:${organization.billing.interval ?? "preview"}`}
            organization={organization}
            currentUserId={currentUserId}
            pending={pending}
            run={run}
          />
        )
      ))}

      <section className="grid gap-4 border-t pt-6" aria-labelledby="create-organization-title">
        <div>
          <h2 id="create-organization-title" className="text-lg font-semibold">
            Create an organisation
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Organisations start with shared billing and seat administration. Members keep their own
            Anvil data and devices.
          </p>
        </div>
        <form
          className="grid max-w-xl gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = String(new FormData(form).get("name") ?? "");
            const ownerSeatAssigned = new FormData(form).get("ownerSeatAssigned") === "on";
            run(async () =>
              fromAction(
                await createOrganizationAction(name, ownerSeatAssigned),
                "Organisation created."
              )
            );
            form.reset();
          }}
        >
          <div className="grid gap-1.5">
            <label htmlFor="new-organization-name" className="text-sm font-medium">
              Organisation name
            </label>
            <input
              id="new-organization-name"
              name="name"
              required
              minLength={2}
              maxLength={80}
              autoComplete="organization"
              className="min-h-11 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="Example Studio"
            />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input
              name="ownerSeatAssigned"
              type="checkbox"
              defaultChecked
              className="size-4 accent-[oklch(var(--accent))]"
            />
            Include me as a developer on the team plan
          </label>
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            Clear this if you only need to manage billing. You can assign yourself a seat later.
          </p>
          <Button type="submit" disabled={pending} className="min-h-11 sm:col-span-2 sm:w-fit">
            {pending ? "Creating…" : "Create organisation"}
          </Button>
        </form>
      </section>
    </div>
  );
}

function ClosedOrganizationRecoverySection({
  organization,
  pending,
  run
}: {
  organization: HostedOrganization;
  pending: boolean;
  run: (mutation: () => Promise<OrganizationMutation>, refreshOnSuccess?: boolean) => void;
}) {
  const billing = organization.billing;
  const owner = organization.membership.role === "owner";
  const hasProviderBilling = billing.status !== null;

  return (
    <section className="grid gap-4 border-y py-6" aria-labelledby={`recovery-${organization.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`recovery-${organization.id}`} className="text-xl font-semibold">
            {organization.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Closed organisation · billing recovery</p>
        </div>
        <span className="rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground">closed</span>
      </header>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
        The WorkOS organisation was deleted. Team seats and pending invitations are closed; personal
        accounts and data remain private. Stripe billing is kept available to the owner for review or cancellation.
      </p>
      {hasProviderBilling ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Team plan</dt>
            <dd className="mt-0.5">{billing.interval === "year" ? "Annual" : "Monthly"} · {billing.status}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Period ends</dt>
            <dd className="mt-0.5">{formatDate(billing.currentPeriodEnd) ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cancellation</dt>
            <dd className="mt-0.5">{billing.cancelAtPeriodEnd ? "Scheduled at period end" : "Not scheduled"}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">No current team subscription is reported.</p>
      )}
      {owner && hasProviderBilling ? (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const result = await createOrganizationPortalAction(organization.id);
              if (!result.ok) return result;
              window.location.assign(result.data.portalUrl);
              return { ok: true, message: "Opening billing portal…" };
            }, false)
          }
        >
          {pending ? "Opening…" : "Review or cancel team billing"}
        </Button>
      ) : null}
    </section>
  );
}

function OrganizationSection({
  organization,
  currentUserId,
  pending,
  run
}: {
  organization: HostedOrganization;
  currentUserId: string;
  pending: boolean;
  run: (mutation: () => Promise<OrganizationMutation>, refreshOnSuccess?: boolean) => void;
}) {
  const billing = organization.billing;
  const [interval, setInterval] = useState<"month" | "year">(organization.billing.interval ?? "month");
  const minimum = Math.max(5, organization.seats.assigned + organization.seats.reserved);
  const [seatValue, setSeatValue] = useState(
    String(Math.min(50, Math.max(minimum, billing.scheduledSeatCapacity ?? billing.seatCapacity)))
  );
  const parsedSeatValue = Number(seatValue);
  const seats = Number.isFinite(parsedSeatValue)
    ? Math.min(50, Math.max(minimum, parsedSeatValue))
    : minimum;
  const seatsValid =
    Number.isInteger(parsedSeatValue) && parsedSeatValue >= minimum && parsedSeatValue <= 50;
  const owner = organization.membership.role === "owner";
  const ownerCount = organization.members.filter((member) => member.role === "owner").length;
  const currentUserHasSeat = organization.members.find((member) => member.workosUserId === currentUserId);
  const checkoutAllowed = billing.checkoutAvailable === true;
  const planPrice = useMemo(() => teamPrice(seats, interval), [seats, interval]);
  const [seatQuote, setSeatQuote] = useState<HostedSeatIncreaseQuote | null>(null);

  useEffect(() => {
    if (seatQuote === null) return;
    const timeout = window.setTimeout(
      () => setSeatQuote(null),
      Math.max(0, seatQuote.expiresAt - Date.now())
    );
    return () => window.clearTimeout(timeout);
  }, [seatQuote]);

  function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    run(async () =>
      fromAction(
        await inviteOrganizationMemberAction(organization.id, email),
        `Invitation sent to ${email.trim()}.`
      )
    );
    form.reset();
  }

  function confirmAndRun(message: string, mutation: () => Promise<OrganizationMutation>) {
    if (window.confirm(message)) run(mutation);
  }

  return (
    <section className="grid gap-5 border-y py-6" aria-labelledby={`organization-${organization.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={`organization-${organization.id}`} className="text-xl font-semibold">
            {organization.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {owner ? "Owner" : "Member"} · billing membership only
          </p>
        </div>
        <span className="rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground">
          {billing.source === "preview" ? "preview" : billing.source === "team" ? "paid team" : "no team plan"}
        </span>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
        <div className="grid content-start gap-5">
          <section className="grid gap-2" aria-labelledby={`seats-${organization.id}`}>
            <h3 id={`seats-${organization.id}`} className="font-medium">
              Seats
            </h3>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm sm:grid-cols-4">
              <SeatCount label="Capacity" value={organization.billing.seatCapacity} />
              <SeatCount label="Assigned" value={organization.seats.assigned} />
              <SeatCount label="Invited" value={organization.seats.reserved} />
              <SeatCount label="Available" value={organization.seats.available} />
            </dl>
            <p className="text-xs leading-5 text-muted-foreground">
              A seat funds one person&apos;s hosted account. Each person can use up to five devices.
              A billing-only owner can manage members without a developer seat.
            </p>
            {billing.scheduledSeatCapacity !== null ? (
              <p className="text-xs text-muted-foreground">
                Capacity will change to {billing.scheduledSeatCapacity} seats
                {billing.scheduledEffectiveAt
                  ? ` on ${formatDate(billing.scheduledEffectiveAt) ?? "the next renewal"}`
                  : " at the next renewal"}
                .
              </p>
            ) : null}
          </section>

          <section className="grid gap-2" aria-labelledby={`members-${organization.id}`}>
            <h3 id={`members-${organization.id}`} className="font-medium">
              Developers and owners
            </h3>
            <ul className="divide-y rounded-md border">
              {organization.members.map((member) => {
                const isLastOwner = member.role === "owner" && ownerCount === 1;
                const seatLabel = member.seatAssigned
                  ? "uses a team seat"
                  : member.fundedBy === "team"
                    ? "team funded"
                    : "billing access only";
                return (
                  <li key={member.workosUserId} className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{member.email}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {member.role} · {seatLabel}
                      </p>
                    </div>
                    {owner ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            const assigned = !member.seatAssigned;
                            confirmAndRun(
                              assigned
                                ? `Assign a team seat to ${member.email}? This gives them team-funded hosted access.`
                                : `Remove the team seat from ${member.email}? Their team-funded hosted access will end. Their personal Anvil account and data stay with them.`,
                              async () =>
                                fromAction(
                                  await updateOrganizationMemberSeatAction(organization.id, member.workosUserId, assigned),
                                  assigned ? `A team seat was assigned to ${member.email}.` : `The team seat was removed from ${member.email}.`
                                )
                            );
                          }}
                        >
                          {member.seatAssigned ? "Remove seat" : "Assign seat"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || (isLastOwner && member.role === "owner")}
                          onClick={() => {
                            const role: HostedOrganizationRole = member.role === "owner" ? "member" : "owner";
                            run(async () =>
                              fromAction(
                                await updateOrganizationRoleAction(organization.id, member.workosUserId, role),
                                `${member.email} is now ${role}.`
                              )
                            );
                          }}
                        >
                          {member.role === "owner" ? "Make member" : "Make owner"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || isLastOwner}
                          onClick={() =>
                            confirmAndRun(
                              `Remove ${member.email} from ${organization.name}? Their team-funded hosted access will end. Their Anvil account and private data stay with them.`,
                              async () =>
                                fromAction(
                                  await removeOrganizationMemberAction(organization.id, member.workosUserId),
                                  `${member.email} was removed.`
                                )
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {!owner || ownerCount > 1 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={pending}
                onClick={() =>
                  confirmAndRun(
                    `Leave ${organization.name}? Your team-funded hosted access will end; your personal Anvil account and data stay with you.`,
                    async () => fromAction(await leaveOrganizationAction(organization.id), `You left ${organization.name}.`)
                  )
                }
              >
                Leave organisation
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Transfer ownership before leaving this organisation.</p>
            )}
          </section>
        </div>

        <div className="grid content-start gap-5">
          <TeamBillingControls
            organization={organization}
            pending={pending}
            run={run}
            seats={seats}
            seatsValid={seatsValid}
            seatValue={seatValue}
            setSeatValue={(value) => {
              setSeatValue(value);
              setSeatQuote(null);
            }}
            seatQuote={seatQuote}
            setSeatQuote={setSeatQuote}
            interval={interval}
            setInterval={setInterval}
            planPrice={planPrice}
            checkoutAllowed={checkoutAllowed}
          />

          {owner ? (
            <section className="grid gap-3" aria-labelledby={`invite-${organization.id}`}>
              <div>
                <h3 id={`invite-${organization.id}`} className="font-medium">
                  Invite an existing account
                </h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  New teammates need WorkOS waitlist approval and an Anvil account before you invite them.
                  The invitation reserves one seat until accepted or revoked.
                </p>
              </div>
              <form className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={submitInvite}>
                <label className="sr-only" htmlFor={`invite-email-${organization.id}`}>
                  Existing Anvil account email
                </label>
                <input
                  id={`invite-email-${organization.id}`}
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="developer@example.com"
                  className="min-h-11 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button type="submit" variant="outline" disabled={pending} className="min-h-11">
                  Send invite
                </Button>
              </form>
              {organization.invitations.length > 0 ? (
                <ul className="divide-y border-y">
                  {organization.invitations.map((invitation) => (
                    <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span className="min-w-0 text-sm">
                        {invitation.email} <span className="text-xs text-muted-foreground">· pending · expires {formatDate(invitation.expiresAt) ?? "soon"}</span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          confirmAndRun(
                            `Revoke the invitation for ${invitation.email}? The reserved team seat will be released.`,
                            async () =>
                              fromAction(
                                await revokeOrganizationInvitationAction(organization.id, invitation.id),
                                `Invitation for ${invitation.email} was revoked.`
                              )
                          )
                        }
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      {!owner && currentUserHasSeat?.seatAssigned !== true ? (
        <p className="text-xs leading-5 text-muted-foreground">
          You are a member without a team seat. Ask an owner to assign one; membership alone does not provide hosted access.
        </p>
      ) : null}
    </section>
  );
}

function SeatCount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function TeamBillingControls({
  organization,
  pending,
  run,
  seats,
  seatsValid,
  seatValue,
  setSeatValue,
  seatQuote,
  setSeatQuote,
  interval,
  setInterval,
  planPrice,
  checkoutAllowed
}: {
  organization: HostedOrganization;
  pending: boolean;
  run: (mutation: () => Promise<OrganizationMutation>, refreshOnSuccess?: boolean) => void;
  seats: number;
  seatsValid: boolean;
  seatValue: string;
  setSeatValue: (value: string) => void;
  seatQuote: HostedSeatIncreaseQuote | null;
  setSeatQuote: (quote: HostedSeatIncreaseQuote | null) => void;
  interval: "month" | "year";
  setInterval: (value: "month" | "year") => void;
  planPrice: number;
  checkoutAllowed: boolean;
}) {
  const owner = organization.membership.role === "owner";
  const billing = organization.billing;
  const needsCheckout = billing.source !== "team";
  const minimumSeats = Math.max(5, organization.seats.assigned + organization.seats.reserved);
  const targetAlreadyScheduled = seats === billing.scheduledSeatCapacity;
  const targetAlreadyEffective = seats === billing.seatCapacity && billing.scheduledSeatCapacity === null;
  const checkoutLabel = billing.source === "preview" ? "Start paid team plan" : "Continue to team checkout";

  if (!owner) {
    return (
      <section className="grid gap-1 border-t pt-4">
        <h3 className="font-medium">Team billing</h3>
        <p className="text-sm text-muted-foreground">An organisation owner manages the subscription and seat capacity.</p>
      </section>
    );
  }

  return (
    <section className="grid gap-3 border-t pt-4" aria-labelledby={`billing-${organization.id}`}>
      <div>
        <h3 id={`billing-${organization.id}`} className="font-medium">
          Team billing
        </h3>
        {billing.source === "team" ? (
          <dl className="mt-2 grid grid-cols-2 gap-x-5 gap-y-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">Plan</dt><dd>{billing.interval === "year" ? "Annual" : "Monthly"} · {billing.status ?? "status unavailable"}</dd></div>
            {billing.currentPeriodEnd !== null ? <div><dt className="text-xs text-muted-foreground">Period ends</dt><dd>{formatDate(billing.currentPeriodEnd) ?? "—"}</dd></div> : null}
            {billing.cancelAtPeriodEnd ? <div className="col-span-2 text-xs text-muted-foreground">Cancellation is scheduled for the end of this period.</div> : null}
          </dl>
        ) : (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {billing.source === "preview"
              ? "Preview capacity is free through 31 October 2026. No card is needed and access will not convert automatically."
              : "Create a team plan to pay for hosted access for named developers."}
          </p>
        )}
      </div>

      <div className="grid gap-3 rounded-md border p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <fieldset className="grid gap-1.5">
            <legend className="text-xs font-medium text-muted-foreground">Billing interval</legend>
            <div className="flex gap-2">
          {(["month", "year"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={interval === value}
                  disabled={billing.source === "team"}
                  onClick={() => setInterval(value)}
                  className="min-h-10 rounded-md border px-3 text-sm aria-pressed:border-accent aria-pressed:bg-[oklch(var(--accent)/0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {value === "month" ? "Monthly" : "Annual"}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-1.5">
            <label htmlFor={`seat-target-${organization.id}`} className="text-xs font-medium text-muted-foreground">
              Purchased seats
            </label>
            <input
              id={`seat-target-${organization.id}`}
              type="number"
              min={minimumSeats}
              max={50}
              step={1}
              required
              value={seatValue}
              onChange={(event) => setSeatValue(event.target.value)}
              className="min-h-10 rounded-md border bg-background px-3 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
        <p className="text-sm">
          {seatsValid ? (
            <>
              <span className="font-semibold tabular-nums">{money(planPrice, interval)}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {seats <= 5 ? "5-seat minimum" : `${seats - 5} additional ${seats - 5 === 1 ? "seat" : "seats"}`}
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Enter a whole seat count from {minimumSeats} to 50.
            </span>
          )}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          Team seats fund hosted access while assigned. They do not cancel a member&apos;s separate
          personal subscription; personal and team billing are managed independently.
        </p>

        {needsCheckout ? (
          <>
            {checkoutAllowed ? (
              <Button
                type="button"
                disabled={pending || !seatsValid}
                onClick={() =>
                  run(async () => {
                    const result = await createTeamCheckoutAction(organization.id, interval, seats);
                    if (!result.ok) return result;
                    window.location.assign(result.data.checkoutUrl);
                    return { ok: true, message: "Opening secure checkout…" };
                  }, false)
                }
              >
                {pending ? "Opening checkout…" : checkoutLabel}
              </Button>
            ) : (
              <Button type="button" disabled>
                Checkout unavailable
              </Button>
            )}
            {!checkoutAllowed ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Team checkout is currently disabled on this deployment. Production paid access begins
                1 November 2026; staging rehearsal requires the staging backend to enable its test-mode flag.
              </p>
            ) : null}
          </>
        ) : (
          <div className="grid gap-3">
            {seats > billing.seatCapacity ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !seatsValid}
                  onClick={() =>
                    run(async () => {
                      const result = await quoteOrganizationSeatIncreaseAction(organization.id, seats);
                      if (!result.ok) return result;
                      setSeatQuote(result.data);
                      return {
                        ok: true,
                        message: "Price preview ready. No charge is made until you confirm the increase."
                      };
                    }, false)
                  }
                >
                  {pending ? "Preparing price preview…" : "Preview seat increase"}
                </Button>
                <p className="text-xs leading-5 text-muted-foreground">
                  An increase never charges immediately. Review its prorated amount and tax, then
                  confirm before the quote expires.
                </p>
                {seatQuote?.requestedSeats === seats ? (
                  <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
                    <div>
                      <h4 className="text-sm font-semibold">Review seat increase</h4>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Capacity changes from {seatQuote.seatCapacity} to {seatQuote.requestedSeats} seats.
                      </p>
                    </div>
                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs text-muted-foreground">Due now, including tax</dt>
                        <dd className="mt-0.5 font-semibold tabular-nums">
                          {moneyMinor(seatQuote.amountDue, seatQuote.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Tax included</dt>
                        <dd className="mt-0.5 tabular-nums">
                          {moneyMinor(seatQuote.taxAmount, seatQuote.currency)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Proration date</dt>
                        <dd className="mt-0.5">{quoteDate(seatQuote.prorationDate)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Quote expires</dt>
                        <dd className="mt-0.5">{quoteDate(seatQuote.expiresAt)}</dd>
                      </div>
                    </dl>
                    <p className="text-xs text-muted-foreground">
                      New team plan rate: {money(planPrice, interval)} before any tax on future invoices.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            const result = await confirmOrganizationSeatIncreaseAction(
                              organization.id,
                              seatQuote.quoteId,
                              seats
                            );
                            if (!result.ok) {
                              setSeatQuote(result.replacementQuote ?? null);
                              return { ok: false, message: result.message };
                            }
                            setSeatQuote(null);
                            return {
                              ok: true,
                              message: `Team capacity increased to ${result.data.seatCapacity} seats.`
                            };
                          })
                        }
                      >
                        Confirm increase to {seatQuote.requestedSeats} seats
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={() => setSeatQuote(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={pending || !seatsValid || targetAlreadyScheduled || targetAlreadyEffective}
                onClick={() =>
                  run(async () => {
                    const result = await updateOrganizationSeatsAction(organization.id, seats);
                    return result.ok
                      ? {
                          ok: true,
                          message:
                            result.data.scheduledSeatCapacity === null
                              ? `Team capacity updated to ${result.data.seatCapacity} seats.`
                              : `Capacity change to ${result.data.scheduledSeatCapacity} seats is scheduled.`
                        }
                      : result;
                  })
                }
              >
                {targetAlreadyScheduled ? "Capacity change scheduled" : "Update capacity"}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await createOrganizationPortalAction(organization.id);
                  if (!result.ok) return result;
                  window.location.assign(result.data.portalUrl);
                  return { ok: true, message: "Opening billing portal…" };
                }, false)
              }
            >
              Manage payment
            </Button>
          </div>
        )}
        {billing.source === "team" ? (
          <p className="text-xs leading-5 text-muted-foreground">
            {billing.cancelAtPeriodEnd
              ? "The team subscription is already scheduled to end. The organisation can close after its paid period ends on "
              : "Cancel the subscription in the billing portal first. The organisation can close after its paid period ends on "}
            {formatDate(billing.currentPeriodEnd) ?? "the displayed renewal date"}.
          </p>
        ) : (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() =>
              window.confirm(
                `Close ${organization.name}? This ends team-funded hosted access for every member, revokes pending invitations, and removes the organisation. Their personal accounts and private data remain.`
              ) &&
              run(async () => {
                  const result = await closeOrganizationAction(organization.id);
                  if (!result.ok) return result;
                  return {
                    ok: true,
                    message: result.data.providerSyncPending
                      ? `${organization.name} was closed. WorkOS membership cleanup will retry in the background.`
                      : `${organization.name} was closed.`
                  };
                })
            }
          >
            Close organisation
          </Button>
        )}
      </div>
    </section>
  );
}
