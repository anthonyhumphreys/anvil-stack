import Link from "next/link";
import type { Metadata } from "next";
import {
  ArrowRight,
  Check,
  Download,
  FileDown,
  GitBranch,
  MonitorSmartphone,
  Server,
  Share2,
  Timer
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { syncModes } from "@/lib/site";

export const metadata: Metadata = {
  title: "Sync & Mesh | Anvil",
  description:
    "Anvil Sync & Mesh: end-to-end encrypted sync across your devices, mesh jobs on your own machines, sealed artifact shares — on a backend you choose, Anvil-hosted or self-deployed."
};

const loopSteps = [
  { step: "Outbox", body: "Edits queue locally — offline or online, the write always lands first on your device." },
  { step: "Seal", body: "At dispatch, each entity seals under your account key. Missing key? The row waits. Plaintext never ships as a fallback." },
  { step: "Push", body: "The backend validates the envelope shape and journals ciphertext. Dedupe rides the envelope hash." },
  { step: "Pull", body: "Paired devices pull over a live socket with polling fallback, then unseal at the boundary and apply." },
  { step: "Settle", body: "Conflicts surface explicitly — never auto-overwritten. Quarantined envelopes self-heal when their key version arrives." }
];

const handoffStates = [
  "requested",
  "target-prepared",
  "source-quiescing",
  "checkpointed",
  "ownership-transferred",
  "target-activating",
  "completed"
];

const meshPoints = [
  "Jobs — workspace prep, provider sessions, diagnostics — are created against your account and claimed by your enrolled devices.",
  "Workers verify the pinned Git state before spawning. Attempts run in isolated worktrees at the pinned commit.",
  "Compute, credentials, and providers stay on your machines. The backend coordinates; it never executes.",
  "States are labeled honestly: `Stopping…` while cancellation propagates, `Lost contact` when the outcome is genuinely unknown."
];

const sharePoints = [
  {
    icon: Share2,
    title: "Sealed share links",
    body: "Artifact shares carry a fresh key in the URL fragment — it never reaches a server. The share page fetches ciphertext and decrypts in your browser. Revoking removes the ciphertext."
  },
  {
    icon: FileDown,
    title: "Your data, exportable",
    body: "Export every synced entity to a portable JSON document and import through a staged preview with conflict counts. Account deletion is durable and visible end to end."
  },
  {
    icon: MonitorSmartphone,
    title: "Everywhere Anvil runs",
    body: "Desktop, the Expo mobile companion, the Raycast extension, and the headless daemon all speak the same Sync v1 contract against the same account."
  }
];

export default function SyncPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="sync" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-center lg:px-8 lg:py-24">
            <div className="flex flex-col gap-7">
              <h1 className="max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.03em] sm:text-5xl lg:text-6xl">
                Sealed. Delivered. Executed.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
                Sync &amp; Mesh replicates your Anvil state across your devices as
                end-to-end-encrypted envelopes, dispatches jobs to your own machines, and
                hands running sessions between them — through a backend that relays
                ciphertext and never holds your keys.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Button asChild size="lg">
                  <Link href="/account">
                    Open your account
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/docs/sync/self-deploy">
                    <GitBranch data-icon="inline-start" aria-hidden="true" />
                    Self-deploy the backend
                  </Link>
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Alpha infrastructure — implemented, tested, and rehearsed on real
                deployments.{" "}
                <Link href="/docs/sync/status-and-limits" className="font-medium text-foreground underline underline-offset-4">
                  Current status and limits
                </Link>
              </p>
            </div>
            <EnvelopeBoundary className="min-w-0" />
          </div>
        </section>

        <section className="border-b bg-muted/20 py-16 lg:py-20" aria-labelledby="loop-title">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 id="loop-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                How a write travels
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Every edit takes the same path, whether the peer is one desk away or one
                ocean away. The interesting part is what the middle never learns.
              </p>
            </div>
            <ol className="mt-10 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-5">
              {loopSteps.map((item, index) => (
                <li key={item.step} className="relative border-t pt-5">
                  <p className="font-mono text-[0.6875rem] text-muted-foreground">0{index + 1}</p>
                  <h3 className="mt-2 font-semibold">{item.step}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-b py-16 lg:py-20" aria-labelledby="mesh-title">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[1fr_1fr] lg:px-8">
            <div>
              <h2 id="mesh-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Mesh: jobs run on your machines, not ours
              </h2>
              <p className="mt-4 text-base leading-7 text-muted-foreground">
                Enrolled devices advertise what they can run. When you dispatch a job, a
                capable machine claims it, verifies the pinned workspace, and streams its
                attempt journal back as sealed entities you can watch live.
              </p>
              <ul className="mt-7 grid gap-3">
                {meshPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2.5 text-sm leading-6 text-muted-foreground">
                    <Check className="proof-check" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid content-start gap-6">
              <div className="rounded-lg border bg-card p-5">
                <h3 className="text-sm font-semibold">Session handoff</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Send a running session to another device. The target materializes the
                  workspace at pinned commits, the source quiesces and seals a checkpoint,
                  and ownership transfers at a fenced generation — no live process ever
                  migrates.
                </p>
                <ol className="mt-4 flex flex-wrap items-center gap-1.5" aria-label="Handoff states">
                  {handoffStates.map((state, index) => (
                    <li key={state} className="flex items-center gap-1.5">
                      <span className="rounded-md border bg-muted/50 px-2 py-1 font-mono text-[0.625rem] text-muted-foreground">
                        {state}
                      </span>
                      {index < handoffStates.length - 1 ? (
                        <ArrowRight className="size-3 text-muted-foreground" aria-hidden="true" />
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="mt-4 border-t pt-4 text-sm leading-6 text-muted-foreground">
                  A dirty tree or unpushed commit blocks the handoff up front with concrete
                  remediation — it never fails mid-transfer.
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-5">
                <p className="text-sm leading-6 text-muted-foreground">
                  The mesh worker opt-in is per-device and never syncs. Enabling it lets
                  that machine claim account jobs — there is deliberately no account-level
                  “run everywhere” switch.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b bg-muted/20 py-16 lg:py-20" aria-labelledby="share-title">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 id="share-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Shares, exports, and the way out
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Account layers earn trust by making leaving boring. Everything you can put
                in, you can take out — or seal and hand to someone else.
              </p>
            </div>
            <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-3">
              {sharePoints.map((item) => (
                <article key={item.title} className="border-t pt-5">
                  <div className="flex items-center gap-2.5">
                    <item.icon className="size-4 text-accent" aria-hidden="true" />
                    <h3 className="font-semibold">{item.title}</h3>
                  </div>
                  <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b py-16 lg:py-20" aria-labelledby="hosted-title">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:px-8">
            <div>
              <h2 id="hosted-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Anvil-hosted, if you would rather not run it
              </h2>
              <p className="mt-4 text-base leading-7 text-muted-foreground">
                The same Sync v1 backend, operated for you. WorkOS sign-in, device
                management and billing on the web, artifact storage, and someone else
                watching the pager. Free through the preview; self-host stays free forever.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/account">
                    Open your account
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/pricing">Pricing and dates</Link>
                </Button>
              </div>
            </div>
            <div className="grid gap-5">
              <div className="overflow-hidden rounded-lg border bg-card">
                <div className="flex items-center gap-2.5 border-b px-5 py-3.5">
                  <Server className="size-4 text-accent" aria-hidden="true" />
                  <h3 className="text-sm font-semibold">What hosted includes</h3>
                </div>
                <ul className="grid gap-0 divide-y">
                  {[
                    "Sealed sync of workspaces, templates, agents, and approved settings",
                    "Mesh job dispatch to your enrolled devices",
                    "Sealed artifact storage within your account limits",
                    "Web account: devices, pair codes, billing, data deletion",
                    "Entitlement enforced at the backend — fail closed, bounded grace"
                  ].map((point) => (
                    <li key={point} className="flex items-start gap-2.5 px-5 py-3.5 text-sm leading-6 text-muted-foreground">
                      <Check className="proof-check" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-4 rounded-lg border bg-muted/30 p-5 sm:grid-cols-2">
                <div className="flex items-start gap-3">
                  <Timer className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Free through 31 October 2026</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      Paid enforcement starts 2026-11-01T00:00:00Z. Reads and local-only
                      mode are never gated.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Download className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Self-host stays free</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      <code className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">anvil-cloud mesh apply</code>{" "}
                      puts the same worker on your Cloudflare account.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="py-16 lg:py-20" aria-labelledby="backends-title">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 id="backends-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Four ways to connect
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Settings → Sync &amp; Mesh in Anvil Desktop. The contract is frozen, so the
                same build talks to any backend that passes conformance.
              </p>
            </div>
            <div className="mt-10 overflow-hidden rounded-lg border">
              <ul className="divide-y">
                {syncModes.map((mode, index) => (
                  <li key={mode.mode} className="grid gap-2 px-5 py-5 sm:grid-cols-[12rem_1fr_auto] sm:items-baseline sm:gap-6">
                    <p className="flex items-baseline gap-3 font-medium">
                      <span className="font-mono text-[0.6875rem] text-muted-foreground">0{index + 1}</span>
                      {mode.mode}
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">{mode.body}</p>
                    <p className="font-mono text-xs text-muted-foreground sm:text-right">{mode.cost}</p>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-6 max-w-3xl text-sm leading-6 text-muted-foreground">
              Hosted staging/QA is available when
              <code className="font-mono text-xs">ANVIL_HOSTED_BACKEND_URL</code> names a
              tested HTTPS origin; production provisioning is still finishing.
              The account area on this site is live, and self-hosted backends work today. The{" "}
              <Link href="/docs/sync/status-and-limits" className="font-medium text-foreground underline underline-offset-4">
                status page
              </Link>{" "}
              tracks what is proven and what is still pending.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/docs/sync/overview">
                  Read the Sync &amp; Mesh docs
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
