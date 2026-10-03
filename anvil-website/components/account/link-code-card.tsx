"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createLinkCodeAction, type ActionResult } from "@/app/account/actions";
import type { HostedLinkCodeResult } from "@/lib/hosted/types";

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

/**
 * "Link an existing install" — the device is already enrolled on a sync
 * account; this code binds that account to this WorkOS identity. Entered
 * on the device, consumed once.
 */
export function LinkCodeCard() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult<HostedLinkCodeResult> | null>(null);

  async function onClick() {
    setPending(true);
    try {
      setResult(await createLinkCodeAction());
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Link an existing Anvil install</CardTitle>
        <CardDescription>
          Already syncing on a device? This code binds that sync account to your sign-in so billing
          and device management work here.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {result?.ok ? (
          <div
            role="status"
            className="grid gap-3 rounded-md border border-accent/50 bg-[oklch(var(--accent)/0.08)] px-4 py-3"
          >
            <p className="text-sm font-medium">Link code — shown once</p>
            <p className="font-mono text-lg tracking-wide">{result.data.linkCode}</p>
            <p className="text-sm text-muted-foreground">
              Expires {formatExpiry(result.data.expiresAt)}. On the device, open Anvil → Settings →
              Sync &amp; Mesh and enter it under “Link to account”.
            </p>
          </div>
        ) : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {result.message}
          </p>
        ) : null}
        <div>
          <Button type="button" variant="outline" onClick={onClick} disabled={pending}>
            {pending ? "Minting…" : "Mint link code"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
