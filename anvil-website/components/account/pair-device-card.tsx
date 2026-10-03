"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pairDeviceAction, type ActionResult } from "@/app/account/actions";
import type { HostedPairDeviceResult } from "@/lib/hosted/types";

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
 * "Connect a device" — mints a one-time enrollment code through the hosted
 * channel and shows it once. The code is never stored by the site.
 */
export function PairDeviceCard() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult<HostedPairDeviceResult> | null>(null);
  const [displayName, setDisplayName] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      setResult(await pairDeviceAction(displayName.trim() === "" ? undefined : displayName.trim()));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect a device</CardTitle>
        <CardDescription>
          Mints a single-use pairing code for a fresh Anvil install on this account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {result?.ok ? (
          <div
            role="status"
            className="grid gap-3 rounded-md border border-accent/50 bg-[oklch(var(--accent)/0.08)] px-4 py-3"
          >
            <p className="text-sm font-medium">Pairing code — shown once</p>
            <p className="font-mono text-lg tracking-wide">{result.data.code}</p>
            <p className="text-sm text-muted-foreground">
              Expires {formatExpiry(result.data.expiresAt)}. In Anvil → Settings → Sync &amp; Mesh →
              Pair this device, choose the hosted backend and enter the code.
            </p>
          </div>
        ) : null}
        {result && !result.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {result.message}
          </p>
        ) : null}
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid flex-1 gap-1.5">
            <label htmlFor="pair-display-name" className="text-sm font-medium">
              Device name <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              id="pair-display-name"
              name="displayName"
              type="text"
              maxLength={80}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="e.g. Work laptop"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Minting…" : "Mint pairing code"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
