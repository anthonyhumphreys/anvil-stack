"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Globe,
  Laptop,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  ShieldCheck,
  Workflow
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  dashboardSnapshotAction,
  dashboardStatusAction,
  requestDashboardAccessAction
} from "@/app/account/dashboard/actions";
import {
  decodeDsk,
  encodeBrowserPub,
  generateBrowserKeypair,
  openDashboardSnapshot,
  randomChallenge,
  randomRequestId,
  unwrapDashboardGrant,
  type DashboardGrantEnvelope,
  type SealedSnapshot
} from "@/lib/mesh-crypto";

/**
 * The decrypted dashboard projection — mirrors buildDashboardSnapshot in
 * anvil-app's dashboard-grant service. Deliberately narrow: device names
 * and trust, environment lifecycle, recent jobs, pending requests.
 */
interface DashboardProjection {
  v: number;
  at: string;
  devices: Array<{
    enrollmentId: string;
    displayName: string | null;
    state: string;
    trust: string;
  }>;
  environments: Array<{
    environmentId: string;
    provider: string;
    state: string;
    expiresAt: string | null;
  }>;
  jobs: Array<{ jobId: string; kind: string; state: string; keyDelivery: string }>;
  requests: Array<{
    requestId: string;
    scopes: string[];
    expiresAt: string;
    origin?: string;
    userAgent?: string;
  }>;
}

interface BrowserSession {
  requestId: string;
  priv: string; // base64 raw X25519 private scalar — tab-scoped only
  pub: string; // base64 raw X25519 public key
  challenge: string;
  expiresAt?: string;
}

const SESSION_KEY = "anvil.dashboard.session";
const STATUS_POLL_MS = 5_000;
const SNAPSHOT_POLL_MS = 10_000;
const REQUEST_TTL_MS = 60 * 60_000;

const SCOPE_LABELS: Record<string, string> = {
  "read-dashboard": "Read dashboard",
  "submit-task": "Submit tasks",
  "approve-action": "Approve actions",
  "request-handoff": "Request handoffs"
};

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadSession(): BrowserSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as BrowserSession;
    return typeof parsed.requestId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function saveSession(session: BrowserSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private-mode storage denial just means no resume — same as a fresh tab.
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* no-op */
  }
}

type Phase =
  | { kind: "locked" }
  | { kind: "pending"; session: BrowserSession }
  | {
      kind: "unlocked";
      session: BrowserSession;
      backendId: string;
      accountId: string;
      dsk: Uint8Array;
      scopes: string[];
      expiresAt: string;
    }
  | { kind: "ended"; reason: "denied" | "expired" | "revoked" };

function endedMessage(reason: "denied" | "expired" | "revoked"): string {
  switch (reason) {
    case "denied":
      return "A trusted device denied this browser's request. Request access again if that was a mistake.";
    case "expired":
      return "This request expired before a device approved it. Request access again to continue.";
    case "revoked":
      return "A trusted device revoked this session. The dashboard locked immediately — request access again to continue.";
  }
}

/**
 * DASH-01 browser side: locked → request → pending → unlocked. The
 * private key never leaves this tab (sessionStorage, memory-resident
 * after load); sign-in alone never unlocks anything — a trusted device
 * must approve the request and seal a DSK to this browser's keypair.
 */
export function DashboardAccess() {
  const [phase, setPhase] = useState<Phase>({ kind: "locked" });
  const [projection, setProjection] = useState<DashboardProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshotSeq, setSnapshotSeq] = useState(0);

  const endSession = useCallback((reason: "denied" | "expired" | "revoked") => {
    clearSession();
    setProjection(null);
    setPhase({ kind: "ended", reason });
  }, []);

  // Status polling: pending → unlocked on approval, terminal → ended.
  useEffect(() => {
    const current = phase;
    if (current.kind !== "pending") return;
    let cancelled = false;
    let polling = false;
    const session = current.session;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (session.expiresAt !== undefined && Date.parse(session.expiresAt) <= Date.now()) {
          endSession("expired");
          return;
        }
        const result = await dashboardStatusAction(session.requestId);
        if (cancelled) return;
        if (!result.ok) {
          if (result.code === "not-found") endSession("expired");
          else setError(result.message);
          return;
        }
        setError(null);
        const status = result.data;
        if (status.state === "pending") return;
        if (status.state === "approved" && status.grant !== undefined) {
          if (status.accountId === undefined || status.backendId === undefined) {
            setError("The backend omitted routing metadata — cannot verify the grant.");
            return;
          }
          const inner = await unwrapDashboardGrant(
            b64decode(session.priv),
            b64decode(session.pub),
            status.grant as DashboardGrantEnvelope,
            { backendId: status.backendId, accountId: status.accountId }
          );
          if (inner === null) {
            setError("Could not open the sealed grant — request access again.");
            return;
          }
          setPhase({
            kind: "unlocked",
            session,
            backendId: status.backendId,
            accountId: status.accountId,
            dsk: decodeDsk(inner),
            scopes: inner.scopes,
            expiresAt: inner.expiresAt
          });
          return;
        }
        if (status.state === "denied" || status.state === "expired" || status.state === "revoked") {
          endSession(status.state);
          return;
        }
        clearSession();
        setPhase({ kind: "locked" });
        setError("The dashboard service returned an invalid session state. Request access again.");
      } catch {
        if (!cancelled) setError("The dashboard service is unavailable. Retrying…");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, endSession]);

  // Snapshot polling: the approving device republishes sealed projections;
  // the AAD authenticates each seq, so stale snapshots fail closed.
  useEffect(() => {
    const current = phase;
    if (current.kind !== "unlocked") return;
    let cancelled = false;
    let polling = false;
    const ctx = current;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        if (Date.parse(ctx.expiresAt) <= Date.now()) {
          endSession("expired");
          return;
        }
        const status = await dashboardStatusAction(ctx.session.requestId);
        if (cancelled) return;
        if (!status.ok) {
          if (status.code === "not-found") endSession("expired");
          else setError(status.message);
          return;
        }
        if (status.data.state === "revoked" || status.data.state === "expired") {
          endSession(status.data.state);
          return;
        }
        if (status.data.state !== "approved" || status.data.snapshotSeq === undefined) return;
        if (status.data.snapshotSeq <= snapshotSeq) return;
        const result = await dashboardSnapshotAction(ctx.session.requestId);
        if (cancelled) return;
        if (!result.ok) {
          if (result.code === "not-found") endSession("expired");
          else setError(result.message);
          return;
        }
        const snapshot = result.data.snapshot as SealedSnapshot | undefined;
        if (snapshot === undefined || snapshot.seq <= snapshotSeq) return;
        const inner = await openDashboardSnapshot(ctx.dsk, snapshot, {
          backendId: ctx.backendId,
          accountId: ctx.accountId,
          requestId: ctx.session.requestId
        });
        if (inner === null) {
          setError("Received a snapshot that failed authentication — keeping the last good view.");
          return;
        }
        setError(null);
        setSnapshotSeq(snapshot.seq);
        setProjection(inner as unknown as DashboardProjection);
      } catch {
        if (!cancelled) setError("The dashboard service is unavailable. Retrying…");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, endSession, snapshotSeq]);

  // Resume a tab-scoped session on reload — the private key is already in
  // sessionStorage, so a refresh rejoins the pending/approved request
  // rather than spamming a new one.
  useEffect(() => {
    const session = loadSession();
    if (session !== null) {
      queueMicrotask(() => setPhase({ kind: "pending", session }));
    }
  }, []);

  const requestAccess = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const keypair = generateBrowserKeypair();
      const expiresAt = new Date(Date.now() + REQUEST_TTL_MS).toISOString();
      const session: BrowserSession = {
        requestId: randomRequestId(),
        priv: b64encode(keypair.priv),
        pub: encodeBrowserPub(keypair.pub),
        challenge: randomChallenge(),
        expiresAt
      };
      const result = await requestDashboardAccessAction({
        requestId: session.requestId,
        browserPub: session.pub,
        challenge: session.challenge,
        scopes: ["read-dashboard", "submit-task", "approve-action", "request-handoff"],
        expiresAt,
        origin: window.location.origin,
        userAgent: navigator.userAgent
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      saveSession(session);
      setPhase({ kind: "pending", session });
    } catch {
      setError("Could not request dashboard access. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const startOver = useCallback(() => {
    clearSession();
    setProjection(null);
    setSnapshotSeq(0);
    setError(null);
    setPhase({ kind: "locked" });
  }, []);

  return (
    <div className="grid gap-6">
      {phase.kind === "locked" && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1.5">
                <CardTitle className="flex items-center gap-2">
                  <Lock size={16} aria-hidden="true" />
                  Dashboard locked
                </CardTitle>
                <CardDescription>
                  Signed in — but sign-in alone never unlocks account content.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              This browser holds no account key. Requesting access generates a one-session keypair
              here; a trusted device then decides which capabilities to grant and seals a dashboard
              key to this browser only. Everything you see afterwards is a projection encrypted for
              this session — the coordinator relays ciphertext it cannot read.
            </p>
            <div>
              <Button onClick={() => void requestAccess()} disabled={busy}>
                {busy ? "Requesting…" : "Request dashboard access"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase.kind === "pending" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Waiting for a trusted device
            </CardTitle>
            <CardDescription>
              A device signed in to this account must approve this browser before anything unlocks.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm text-muted-foreground">
              Open Anvil on a paired device → Settings → Sync &amp; Mesh → Browser dashboard access,
              review this request, and approve the scopes you want to grant. This page updates the
              moment a device decides.
            </p>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Request</dt>
                <dd className="mt-0.5 font-mono text-xs">{phase.session.requestId.slice(0, 8)}…</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Browser key</dt>
                <dd className="mt-0.5 font-mono text-xs">{phase.session.pub.slice(0, 12)}…</dd>
              </div>
            </dl>
            <div>
              <Button variant="outline" size="sm" onClick={startOver}>
                Cancel request
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase.kind === "ended" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock size={16} aria-hidden="true" />
              Session ended
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm text-muted-foreground">{endedMessage(phase.reason)}</p>
            <div>
              <Button onClick={startOver}>Request access again</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {phase.kind === "unlocked" && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="grid gap-1.5">
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck size={16} className="text-accent" aria-hidden="true" />
                    Dashboard unlocked
                  </CardTitle>
                  <CardDescription>
                    Encrypted projection sealed to this session until{" "}
                    {new Date(phase.expiresAt).toLocaleString()}.
                  </CardDescription>
                </div>
                <span className="rounded bg-[oklch(var(--accent)/0.13)] px-2 py-1 text-xs font-medium">
                  seq {snapshotSeq}
                </span>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap gap-1.5">
                {phase.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {SCOPE_LABELS[scope] ?? scope}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Action scopes appear here when granted; task submission and approvals from the
                browser land with the delegated-action packet.
              </p>
            </CardContent>
          </Card>

          {projection === null ? (
            <Card>
              <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <RefreshCw size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Waiting for the first encrypted snapshot…
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Devices</CardTitle>
                  <CardDescription>
                    Enrollments on this account, as projected by the approving device.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {projection.devices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No devices in the projection.</p>
                  ) : (
                    <ul className="grid gap-2">
                      {projection.devices.map((device) => (
                        <li
                          key={device.enrollmentId}
                          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-sm">
                            <Laptop size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate">
                              {device.displayName ?? `device ${device.enrollmentId.slice(0, 8)}`}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {device.trust}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Environments</CardTitle>
                  <CardDescription>Managed cloud environments and their lifecycle.</CardDescription>
                </CardHeader>
                <CardContent>
                  {projection.environments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No environments in the projection.</p>
                  ) : (
                    <ul className="grid gap-2">
                      {projection.environments.map((environment) => (
                        <li
                          key={environment.environmentId}
                          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-sm">
                            <Server size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate font-mono text-xs">
                              {environment.environmentId.slice(0, 12)}… · {environment.provider}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {environment.state}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Recent jobs</CardTitle>
                  <CardDescription>
                    Latest mesh executions — prompts and payloads never appear here.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {projection.jobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No jobs in the projection.</p>
                  ) : (
                    <ul className="grid gap-2">
                      {projection.jobs.map((job) => (
                        <li
                          key={job.jobId}
                          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-sm">
                            <Workflow size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate">
                              {job.kind} · {job.jobId.slice(0, 8)}…
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">{job.state}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              {projection.requests.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle>Other pending requests</CardTitle>
                    <CardDescription>
                      Browsers also waiting for a trusted device decision.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="grid gap-2">
                      {projection.requests.map((request) => (
                        <li
                          key={request.requestId}
                          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                        >
                          <span className="flex min-w-0 items-center gap-2 text-sm">
                            <Globe size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="truncate">{request.origin ?? "browser session"}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {request.scopes.length} scope{request.scopes.length === 1 ? "" : "s"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
