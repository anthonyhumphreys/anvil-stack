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
import { agentExecutionModes, syncModes } from "@/lib/site";

export const metadata: Metadata = {
  title: "Sync & Mesh | Anvil",
  description:
    "Anvil Sync & Mesh keeps portable state encrypted across devices, routes jobs to your machines, and coordinates session handoff through a backend you choose."
};

const loopSteps = [
  { step: "Outbox", body: "Edits queue locally. Offline or online, the write lands on your device first." },
  { step: "Seal", body: "At dispatch, each entity seals under your account key. If the key is missing, the row waits. Plaintext is never a fallback." },
  { step: "Push", body: "The backend validates the envelope shape and journals ciphertext. Dedupe rides the envelope hash." },
  { step: "Pull", body: "Paired devices pull over a live socket with polling fallback, then unseal at the boundary and apply." },
  { step: "Settle", body: "Conflicts stay visible. Quarantined envelopes retry when their key version arrives." }
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
  "Jobs for workspace prep, provider sessions, and diagnostics are created against your account and claimed by your enrolled devices.",
  "Workers verify the pinned Git state before spawning. Attempts run in isolated worktrees at the pinned commit.",
  "Compute, credentials, and providers stay on your machines. The backend coordinates; it never executes.",
  "States stay explicit: `Stopping…` while cancellation propagates, `Lost contact` when the outcome is unknown."
];

const sharePoints = [
  {
    icon: Share2,
    title: "Sealed share links",
    body: "Artifact shares carry a fresh key in the URL fragment. It never reaches a server. The share page fetches ciphertext and decrypts in your browser. Revoking removes the ciphertext."
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
                Sync your state. Run jobs on your machines.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
                Sync &amp; Mesh copies portable Anvil state between paired devices as
                end-to-end-encrypted envelopes. Mesh jobs run on machines you enrolled,
                and session handoff moves ownership through a sealed checkpoint. The
                backend coordinates delivery. It does not hold your keys or run your repo.
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
                Alpha infrastructure. The protocol is implemented and tested, and Cloudflare
                deployment is rehearsed. Physical multi-device acceptance and hosted production
                provisioning remain open.{" "}
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
                  and ownership transfers at a fenced generation. No live process ever
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
                  remediation. The handoff stops before transfer when the workspace is not ready.
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-5">
                <p className="text-sm leading-6 text-muted-foreground">
                  The mesh worker opt-in is per-device and never syncs. Enabling it lets
                  that machine claim account jobs. There is deliberately no account-level
                  “run everywhere” switch.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b bg-muted/20 py-16 lg:py-20" aria-labelledby="agents-title">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.72fr_1.28fr] lg:px-8">
            <div>
              <h2 id="agents-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Give a workflow a temporary machine
              </h2>
              <p className="mt-4 text-base leading-7 text-muted-foreground">
                A workflow can ask for a temporary environment on AWS Lambda MicroVM, Cloudflare
                Sandbox, Vercel Sandbox, or the Anvil-managed tier. The adapter boots a worker,
                the worker joins the mesh, and credentials arrive only for the attempt that needs
                them. Local work stays on enrolled devices and does not need an environment.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/docs/cloud/agent-sandboxes">
                    Read the sandbox contract
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/docs/cloud/aws-preview">Inspect the AWS adapter</Link>
                </Button>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_auto] gap-4 border-b px-5 py-3 text-xs font-medium text-muted-foreground">
                <span>Provider</span>
                <span>What it does</span>
                <span className="text-right">Status</span>
              </div>
              <ul className="divide-y">
                {agentExecutionModes.map((mode) => (
                  <li key={mode.provider} className="grid gap-2 px-5 py-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_auto] sm:items-baseline sm:gap-4">
                    <Link href={mode.href} className="font-medium text-foreground underline-offset-4 hover:underline">
                      {mode.provider}
                    </Link>
                    <p className="text-sm leading-6 text-muted-foreground">{mode.detail}</p>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground sm:text-right">
                      {mode.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mx-auto mt-8 max-w-7xl px-4 sm:px-6 lg:px-8">
            <p className="max-w-4xl border-t pt-4 text-sm leading-6 text-muted-foreground">
              This table describes the Desktop mesh environment path. Anvil Cloud has a separate
              agent-execution control plane with an AWS preview transport; it is not the same
              provider matrix. Hosted environments still depend on the launch checklist: worker
              image, production persistence, account verification, and service configuration.
            </p>
          </div>
        </section>

        <section className="border-b bg-muted/20 py-16 lg:py-20" aria-labelledby="share-title">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="max-w-2xl">
              <h2 id="share-title" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Shares, exports, and the way out
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                You can export synced entities, import them through a staged preview, or seal an
                artifact for someone else. Leaving is a supported operation, not a support ticket.
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
                The same Sync v1 backend with WorkOS sign-in, device management, billing, and
                artifact storage handled for you. The preview policy is free through 31 October
                2026. Production provisioning is still being finished, and self-hosting remains open.
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
                    "Entitlement enforced at the backend, with fail-closed writes and bounded grace"
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
                      The current policy starts paid enforcement on 1 November 2026. Reads and
                      local-only mode are not gated.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Download className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Self-host stays free</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      <code className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">anvil-cloud mesh apply</code>{" "}
                      deploys the official worker to your Cloudflare account.
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
                Configure this in Anvil Desktop under Settings → Sync &amp; Mesh. The same client
                can talk to local-only, hosted, self-deployed, or conformant backends.
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
              Hosted staging and QA are available when
              <code className="font-mono text-xs">ANVIL_HOSTED_BACKEND_URL</code> names a
              tested HTTPS origin. Production provisioning is still finishing. The account area on
              this site is live, and self-hosted backends work today. The{" "}
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
