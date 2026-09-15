"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { deleteAccountAction, type ActionResult } from "@/app/account/actions";
import type { HostedDeleteAccountResult } from "@/lib/hosted/types";

const CONFIRM_TEXT = "delete my hosted data";

/**
 * Destructive, type-to-confirm delete of the hosted billing account and its
 * synced data. The backend purges in bounded passes; the returned state is
 * shown verbatim rather than dressed up as instant deletion.
 */
export function DeleteDataCard() {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult<HostedDeleteAccountResult> | null>(null);

  const armed = draft.trim().toLowerCase() === CONFIRM_TEXT;

  async function onDelete() {
    setPending(true);
    try {
      setResult(await deleteAccountAction());
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle>Delete hosted data</CardTitle>
        <CardDescription>
          Schedules deletion of the hosted account and its synced state. Devices are signed out;
          purge runs in bounded passes on the backend. Local data on your machines is not touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {result?.ok ? (
          <p role="status" className="rounded-md border bg-muted/50 px-4 py-3 text-sm">
            Deletion {result.data.state === "deleted" ? "complete" : "scheduled"} — state reported by
            the backend: <span className="font-mono">{result.data.state}</span>
            {result.data.startedAt ? `, started ${new Date(result.data.startedAt).toLocaleString("en-GB", { timeZoneName: "short" })}` : ""}.
          </p>
        ) : (
          <>
            <div className="grid gap-1.5">
              <label htmlFor="delete-confirm" className="text-sm font-medium">
                Type <span className="font-mono">{CONFIRM_TEXT}</span> to confirm
              </label>
              <input
                id="delete-confirm"
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoComplete="off"
                className="h-10 max-w-sm rounded-md border border-input bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            {result && !result.ok ? (
              <p role="alert" className="text-sm text-destructive">
                {result.message}
              </p>
            ) : null}
            <div>
              <Button
                type="button"
                variant="destructive"
                disabled={!armed || pending}
                onClick={onDelete}
              >
                {pending ? "Scheduling…" : "Delete hosted data"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
