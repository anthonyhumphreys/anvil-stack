import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { BillingActions } from "@/components/account/billing-actions";
import { EntitlementStateBadge, entitlementSummary } from "@/components/account/entitlement";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDate,
  hostedFailureMessage,
  loadAccountContext,
  tryHosted
} from "@/lib/account";
import { getBilling } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata = { title: "Billing | Anvil" };

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
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Entitlement, subscription, and payment state reported by the sync backend.
        </p>
      </header>

      {billing.ok && billing.data.entitlement.state === "grace" ? (
        <p role="alert" className="rounded-md border border-accent/60 bg-[oklch(var(--accent)/0.08)] px-4 py-3 text-sm">
          Access is in a grace period
          {billing.data.entitlement.graceUntil
            ? ` until ${formatDate(billing.data.entitlement.graceUntil)}`
            : ""}
          . A renewal failed or billing could not be refreshed — reconcile or update payment before
          the grace window ends.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1.5">
              <CardTitle>Entitlement</CardTitle>
              <CardDescription>Current access state for hosted sync.</CardDescription>
            </div>
            {billing.ok ? (
              <EntitlementStateBadge state={billing.data.entitlement.state} />
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {billing.ok ? (
            <p className="text-sm text-muted-foreground">
              {entitlementSummary(billing.data.entitlement)}
            </p>
          ) : billing.code === "not-found" ? (
            <p className="text-sm text-muted-foreground">
              No hosted billing account exists yet — it is created the first time you pair a device
              or start checkout.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {hostedFailureMessage(billing.code, billing.status)}
            </p>
          )}
        </CardContent>
      </Card>

      {billing.ok ? (
        <Card>
          <CardHeader>
            <CardTitle>Subscription</CardTitle>
            <CardDescription>
              {billing.data.subscription === null
                ? "No paid subscription on file."
                : "Latest provider-verified subscription."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {billing.data.subscription !== null ? (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Plan</dt>
                  <dd className="mt-0.5 font-mono text-xs">{billing.data.subscription.planKey}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Interval</dt>
                  <dd className="mt-0.5">{billing.data.subscription.interval}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Status</dt>
                  <dd className="mt-0.5 font-mono text-xs">{billing.data.subscription.status}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Current period ends</dt>
                  <dd className="mt-0.5">
                    {formatDate(billing.data.subscription.currentPeriodEnd) ?? "—"}
                  </dd>
                </div>
                {billing.data.subscription.cancelAtPeriodEnd ? (
                  <div className="sm:col-span-2">
                    <dt className="text-xs font-medium text-muted-foreground">Cancellation</dt>
                    <dd className="mt-0.5">Cancels at the end of the current period.</dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Hosted sync is free through 31 October 2026. Paid plans start 1 Nov 2026 — until
                then there is nothing to subscribe to.
              </p>
            )}
            {billing.data.pendingCheckout !== null ? (
              <p className="text-sm text-muted-foreground">
                A checkout session opened {formatDate(billing.data.pendingCheckout.createdAt) ?? "recently"}{" "}
                is still pending — finishing it updates this view.
              </p>
            ) : null}
            {/* The portal needs a Stripe customer, which checkout creates —
                the billing payload does not expose one directly, so any
                subscription or pending checkout is the visible signal. */}
            <BillingActions
              hasStripeCustomer={
                billing.data.subscription !== null || billing.data.pendingCheckout !== null
              }
            />
            {billing.data.lastReconcileAt !== null || billing.data.lastWebhookAt !== null ? (
              <p className="text-xs text-muted-foreground">
                Last reconcile: {formatDate(billing.data.lastReconcileAt) ?? "never"} · Last webhook:{" "}
                {formatDate(billing.data.lastWebhookAt) ?? "never"}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
