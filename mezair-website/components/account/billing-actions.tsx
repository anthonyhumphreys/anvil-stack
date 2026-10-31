"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  createPortalAction,
  createCheckoutAction,
  redeemBetaCodeAction,
  reconcileAction,
  type ActionResult
} from "@/app/account/actions";
import type { HostedReconcileResult } from "@/lib/hosted/types";

type Pending = "portal" | "reconcile" | "checkout" | null;

export function BillingActions({ hasStripeCustomer, checkoutAvailable = false, hasSubscription = false }: {
  hasStripeCustomer: boolean; checkoutAvailable?: boolean; hasSubscription?: boolean;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<"month" | "year">("month");
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
    } catch {
      setError("Could not reach the account service. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {checkoutAvailable && !hasSubscription ? (
          <>
            <label className="grid gap-1 text-sm">
              <span className="sr-only">Billing interval</span>
              <select aria-label="Billing interval" className="min-h-11 rounded-md border bg-background px-3" value={interval}
                onChange={(event) => setInterval(event.target.value as "month" | "year")} disabled={pending !== null}>
                <option value="month">£8.99 monthly</option>
                <option value="year">£89.90 annually</option>
              </select>
            </label>
            <Button disabled={pending !== null} onClick={() => void run("checkout", () => createCheckoutAction(interval),
              (data) => window.location.assign(data.checkoutUrl))}>
              {pending === "checkout" ? "Opening checkout…" : "Subscribe to hosted Sync & Mesh"}
            </Button>
          </>
        ) : null}
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
            {pending === "portal" ? "Opening…" : "Manage subscription"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={pending !== null}
          onClick={() =>
            void run("reconcile", reconcileAction, (data) => {
              setReconciled(data);
              router.refresh();
            })
          }
        >
          {pending === "reconcile" ? "Refreshing…" : "Refresh billing"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {reconciled ? (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshed {reconciled.subscriptions} subscription record
          {reconciled.subscriptions === 1 ? "" : "s"}.
        </p>
      ) : null}
    </div>
  );
}

export function BetaCodeForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  return (
    <form className="grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const code = String(new FormData(form).get("code") ?? "");
      setPending(true); setError(null); setSuccess(null);
      try {
        const result = await redeemBetaCodeAction(code);
        if (!result.ok) setError(result.message);
        else {
          form.reset();
          setSuccess(`Beta access is active until ${new Date(result.data.accessUntil).toLocaleDateString()}. No payment method required.`);
          router.refresh();
        }
      } catch { setError("Could not redeem the code. Try again."); }
      finally { setPending(false); }
    }}>
      <label htmlFor="beta-code" className="text-sm font-medium">Beta invitation code</label>
      <div className="flex flex-wrap gap-2">
        <input id="beta-code" name="code" type="text" required maxLength={43} autoComplete="off" autoCapitalize="none"
          spellCheck={false} disabled={pending} aria-describedby="beta-code-help" aria-invalid={error !== null}
          className="min-h-11 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="submit" disabled={pending}>{pending ? "Redeeming…" : "Redeem beta code"}</Button>
      </div>
      <p id="beta-code-help" className="text-sm text-muted-foreground">Invited testers receive a code after waitlist approval. Each code belongs to one account once redeemed.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {success ? <p role="status" className="text-sm text-muted-foreground">{success}</p> : null}
    </form>
  );
}
