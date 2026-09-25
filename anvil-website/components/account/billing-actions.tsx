"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createCheckoutAction,
  createPortalAction,
  reconcileAction,
  type ActionResult
} from "@/app/account/actions";
import type { HostedBillingInterval, HostedReconcileResult } from "@/lib/hosted/types";

type Pending = "portal" | "month" | "year" | "reconcile" | null;

/**
 * Billing mutations — portal and checkout return a URL we navigate to;
 * reconcile refreshes the stored subscription view. Errors surface inline
 * so a disabled checkout reads as a fact, not a dead button.
 */
export function BillingActions({ hasStripeCustomer }: { hasStripeCustomer: boolean }) {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<HostedReconcileResult | null>(null);

  async function run<T>(key: Exclude<Pending, null>, call: () => Promise<ActionResult<T>>, onOk: (data: T) => void) {
    setPending(key);
    setError(null);
    try {
      const result = await call();
      if (result.ok) onOk(result.data);
      else setError(result.message);
    } finally {
      setPending(null);
    }
  }

  function startCheckout(interval: HostedBillingInterval) {
    void run(interval, () => createCheckoutAction(interval), (data) => {
      window.location.assign(data.checkoutUrl);
    });
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => startCheckout("month")}
          disabled={pending !== null}
        >
          {pending === "month" ? "Starting…" : "Upgrade — monthly"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => startCheckout("year")}
          disabled={pending !== null}
        >
          {pending === "year" ? "Starting…" : "Upgrade — annual"}
        </Button>
        {hasStripeCustomer ? (
          <Button
            type="button"
            variant="outline"
            disabled={pending !== null}
            onClick={() =>
              void run("portal", createPortalAction, (data) => {
                window.location.assign(data.portalUrl);
              })
            }
          >
            {pending === "portal" ? "Opening…" : "Manage billing"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={pending !== null}
          onClick={() =>
            void run("reconcile", reconcileAction, (data) => {
              setReconciled(data);
            })
          }
        >
          {pending === "reconcile" ? "Reconciling…" : "Reconcile now"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {reconciled ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconciled — {reconciled.subscriptions} subscription
          {reconciled.subscriptions === 1 ? "" : "s"} checked against the provider.
        </p>
      ) : null}
    </div>
  );
}
