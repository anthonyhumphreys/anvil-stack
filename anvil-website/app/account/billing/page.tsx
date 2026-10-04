import type { Metadata } from "next";
import Link from "next/link";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { BillingActions } from "@/components/account/billing-actions";
import { EntitlementStateBadge, entitlementSummary } from "@/components/account/entitlement";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, hostedFailureMessage, loadAccountContext, tryHosted } from "@/lib/account";
import { getBilling } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata: Metadata = { title: "Billing history | Anvil" };

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
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Billing history</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          Sync &amp; Mesh are free. Old subscriptions do not unlock additional Sync or
          Mesh features. If a legacy subscription still renews, use its payment portal to review or
          cancel it.
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
              No hosted account exists yet. Pair a device to create one. Sync &amp; Mesh do not
              require a billing account.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {hostedFailureMessage(billing.code, billing.status)}
            </p>
          )}
        </CardContent>
      </Card>

      {billing.ok && billing.data.teamSponsorship !== null ? (
        <Card>
          <CardHeader>
            <CardTitle>Legacy organisation subscription</CardTitle>
            <CardDescription>
              Historical billing record for {billing.data.teamSponsorship.organizationName}.
              Sync &amp; Mesh access does not depend on it.
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
              Organisation owners can review or cancel legacy billing on the{" "}
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
            <CardTitle>Legacy personal subscription</CardTitle>
            <CardDescription>
              {billing.data.subscription === null
                ? "No personal subscription record is on file."
                : "Existing payment-provider record. It does not change Sync & Mesh access."}
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
                No subscription is needed to use Sync &amp; Mesh.
              </p>
            )}
            {billing.data.pendingCheckout !== null ? (
              <p className="text-sm text-muted-foreground">
                An unfinished legacy checkout is still on file. It does not affect your Sync &amp;
                Mesh access.
              </p>
            ) : null}
            <BillingActions
              hasStripeCustomer={
                billing.data.subscription !== null || billing.data.pendingCheckout !== null
              }
            />
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
