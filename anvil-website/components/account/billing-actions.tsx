"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createPortalAction,
  reconcileAction,
  type ActionResult
} from "@/app/account/actions";
import type { HostedReconcileResult } from "@/lib/hosted/types";

type Pending = "portal" | "reconcile" | null;

/** Manage or refresh payment records left by the previous Sync & Mesh plans. */
export function BillingActions({ hasStripeCustomer }: { hasStripeCustomer: boolean }) {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<HostedReconcileResult | null>(null);

  async function run<T>(
    key: Exclude<Pending, null>,
    call: () => Promise<ActionResult<T>>,
    onOk: (data: T) => void
  ) {
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

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
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
            {pending === "portal" ? "Opening…" : "Review or cancel legacy billing"}
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
          {pending === "reconcile" ? "Refreshing…" : "Refresh billing history"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {reconciled ? (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshed {reconciled.subscriptions} legacy subscription record
          {reconciled.subscriptions === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}
