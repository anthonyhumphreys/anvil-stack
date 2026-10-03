"use client";

import Link from "next/link";
import { AlertCircle, Laptop, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WorkspaceMachineOption } from "@/components/workspace/types";

export interface WorkspaceStartProps {
  machines: WorkspaceMachineOption[];
  selectedEnrollmentId?: string;
  requestPending?: boolean;
  renewing?: boolean;
  requestId?: string | null;
  verificationCode?: string;
  error?: string | null;
  discoveryDetail?: string;
  onSelectMachine?: (enrollmentId: string) => void;
  onRequestMachine?: (enrollmentId: string) => void | Promise<void>;
}

export function WorkspaceStart({
  machines,
  selectedEnrollmentId,
  requestPending = false,
  renewing = false,
  verificationCode,
  error,
  discoveryDetail,
  onSelectMachine,
  onRequestMachine,
}: WorkspaceStartProps) {
  const selectedMachine = machines.find((machine) => machine.enrollmentId === selectedEnrollmentId);

  return (
    <div className="grid min-h-full content-center justify-items-center gap-6 px-4 py-8 text-center">
      <div className="grid justify-items-center gap-2">
        <h1 className="text-xl font-semibold tracking-[-0.025em] sm:text-2xl">What should we work on?</h1>
        <p className="max-w-md text-sm leading-6 text-muted-foreground">
          Connect a paired Anvil machine to choose a project and start chatting.
        </p>
      </div>

      {requestPending ? (
        <div className="grid w-full max-w-sm justify-items-center gap-3 rounded-lg border px-4 py-4" role="status">
          <RefreshCw className="size-4 animate-spin text-accent" aria-hidden="true" />
          <p className="text-sm font-medium">{renewing ? "Reconnecting to Anvil Desktop…" : "Approve this browser in Anvil Desktop"}</p>
          {!renewing && verificationCode ? (
            <p className="font-mono text-lg tracking-[0.16em]" aria-label={`Verification code ${verificationCode}`}>
              {verificationCode}
            </p>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            {renewing ? "Waiting for the selected machine to renew this browser session." : "Confirm the code in Desktop. It will show the workspace and repositories it is sharing."}
          </p>
        </div>
      ) : machines.length > 0 ? (
        <div className="flex w-full max-w-md flex-wrap items-center justify-center gap-2">
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border px-3 text-sm focus-within:ring-2 focus-within:ring-ring">
            <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Run on machine</span>
            <select
              aria-label="Run on machine"
              value={selectedEnrollmentId ?? ""}
              onChange={(event) => onSelectMachine?.(event.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none"
            >
              {machines.map((machine) => (
                <option key={machine.enrollmentId} value={machine.enrollmentId}>
                  {machine.displayName}{machine.self ? " · This machine" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            disabled={!selectedMachine || !onRequestMachine}
            onClick={() => selectedMachine && void onRequestMachine?.(selectedMachine.enrollmentId)}
          >
            Connect
          </Button>
        </div>
      ) : (
        <div className="grid justify-items-center gap-2 text-sm">
          <p className="text-muted-foreground">No paired machines yet.</p>
          {discoveryDetail ? <p role="status" className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />{discoveryDetail}</p> : null}
          <Link href="/account/devices" className="min-h-10 content-center px-2 text-xs font-medium underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Pair or manage a machine
          </Link>
        </div>
      )}

      {error ? <p role="alert" className="max-w-md text-xs leading-5 text-destructive">{error}</p> : null}
      {!requestPending && machines.length > 0 && discoveryDetail ? <p role="status" className="max-w-md text-xs leading-5 text-muted-foreground">{discoveryDetail}</p> : null}
    </div>
  );
}
