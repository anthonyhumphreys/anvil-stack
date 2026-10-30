import type { Metadata } from "next";
import Link from "next/link";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { BetaCodeForm, BillingActions } from "@/components/account/billing-actions";
import { EntitlementStateBadge, entitlementSummary } from "@/components/account/entitlement";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, hostedFailureMessage, loadAccountContext, tryHosted } from "@/lib/account";
import { getBilling } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata: Metadata = { title: "Hosted Sync & Mesh billing | Mezair" };

export default async function BillingPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;
  if (ctx.status === "backend-unconfigured") return <BackendNotConfigured />;
  return <BillingData identity={ctx.identity} />;
}

async function BillingData({ identity }: { identity: HostedIdentity }) {
  const billing = await tryHosted(() => getBilling(identity));

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Hosted Sync &amp; Mesh</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          A subscription pays for Mezair-hosted Sync &amp; Mesh, not the desktop app.
          Invited beta testers can redeem a code below without a payment method.
          Desktop and self-hosting stay free. View <Link href="/pricing" className="underline underline-offset-4">pricing</Link>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1.5">
              <CardTitle>Sync &amp; Mesh access</CardTitle>
              <CardDescription>Current access state reported by the backend.</CardDescription>
            </div>
            {billing.ok ? <EntitlementStateBadge state={billing.data.entitlement.state} /> : null}
          </div>
        </CardHeader>
        <CardContent>
          {billing.ok ? (
            <p className="text-sm text-muted-foreground">
              {entitlementSummary(billing.data.entitlement)}
            </p>
          ) : billing.code === "not-found" ? (
            <p className="text-sm text-muted-foreground">
              No hosted account exists yet. Redeem your beta invitation or connect a device after waitlist approval.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {hostedFailureMessage(billing.code, billing.status)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Have a beta invitation?</CardTitle></CardHeader>
        <CardContent><BetaCodeForm /></CardContent>
      </Card>

      {billing.ok && billing.data.teamSponsorship !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Organisation subscription</CardTitle>
            <CardDescription>
              Hosted access funded by {billing.data.teamSponsorship.organizationName}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Status</dt>
                <dd className="mt-0.5">{billing.data.teamSponsorship.status}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Billing interval</dt>
                <dd className="mt-0.5">
                  {billing.data.teamSponsorship.interval === "year" ? "Annual" : "Monthly"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Period ends</dt>
                <dd className="mt-0.5">
                  {formatDate(billing.data.teamSponsorship.currentPeriodEnd) ?? "—"}
                </dd>
              </div>
              {billing.data.teamSponsorship.cancelAtPeriodEnd ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Cancellation</dt>
                  <dd className="mt-0.5">Scheduled at the end of this period.</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs leading-5 text-muted-foreground">
              Organisation owners can manage billing on the{" "}
              <Link href="/account/organizations" className="underline underline-offset-4">
                organisation account page
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      ) : null}

      {billing.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>Personal subscription</CardTitle>
            <CardDescription>
              {billing.data.subscription === null
                ? "No personal subscription record is on file."
                : "Manage your Mezair-hosted Sync & Mesh subscription."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {billing.data.subscription !== null ? (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Plan record</dt>
                  <dd className="mt-0.5 font-mono text-xs">{billing.data.subscription.planKey}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Billing interval</dt>
                  <dd className="mt-0.5">{billing.data.subscription.interval}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Status</dt>
                  <dd className="mt-0.5 font-mono text-xs">{billing.data.subscription.status}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Period ends</dt>
                  <dd className="mt-0.5">
                    {formatDate(billing.data.subscription.currentPeriodEnd) ?? "—"}
                  </dd>
                </div>
                {billing.data.subscription.cancelAtPeriodEnd ? (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium text-muted-foreground">Cancellation</dt>
                    <dd className="mt-0.5">Scheduled at the end of this period.</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                You don&apos;t have a personal subscription. A beta code or an assigned paid team seat can also grant hosted access.
              </p>
            )}
            {billing.data.pendingCheckout !== null ? (
              <p className="text-sm text-muted-foreground">
                A checkout is unfinished. Access starts only after payment is confirmed.
              </p>
            ) : null}
            <BillingActions
              checkoutAvailable={billing.data.checkoutAvailable}
              hasSubscription={billing.data.subscription !== null &&
                (!["canceled", "incomplete_expired"].includes(billing.data.subscription.status) ||
                  billing.data.entitlement.fundedBy === "personal")}
              hasStripeCustomer={
                billing.data.subscription !== null || billing.data.pendingCheckout !== null
              }
            />
            {!billing.data.checkoutAvailable ? <p className="text-sm text-muted-foreground">Paid signup is not open yet. <Link href="/waitlist" className="underline underline-offset-4">Join the waitlist</Link>; invited testers receive a beta code.</p> : null}
            {billing.data.lastReconcileAt !== null || billing.data.lastWebhookAt !== null ? (
              <p className="text-xs text-muted-foreground">
                Billing history refreshed: {formatDate(billing.data.lastReconcileAt) ?? "never"} ·
                Last provider event: {formatDate(billing.data.lastWebhookAt) ?? "never"}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
