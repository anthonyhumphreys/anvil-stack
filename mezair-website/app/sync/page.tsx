import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MeshStage } from "@/components/marketing/mesh-stage";
import { Shot } from "@/components/marketing/shot";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { pageMetadata } from "@/lib/metadata";
import { agentEnvironments, featureBeta, syncBackends } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Sync & Mesh | Mezair",
  description:
    "Sync copies Mezair workspaces, templates and agents between your machines and encrypts them on your device first. Mesh runs jobs on another machine at a chosen commit and can move a running session.",
  path: "/sync"
});

const syncs = ["Workspace setups, including repositories, agents and rules", "Workflow templates and custom agents", "Settings you choose to share"];

const neverSyncs = ["Repository files", "API keys and provider logins", "Chat transcripts", "Paths on your machine"];

const routes = [
  { name: "The host's LAN address", tag: "tried first" },
  { name: "Other private routes", tag: "next" },
  { name: "HTTPS", tag: "then" },
  { name: "Managed ingress", tag: "last" }
];

const guarantees = [
  {
    title: "One owner at a time",
    body: "A handoff increments the ownership generation, and the backend rejects commands from the previous owner."
  },
  {
    title: "Readiness checks",
    body: "Uncommitted changes or unpushed commits stop a handoff before it starts, and Mezair tells you how to fix them."
  },
  {
    title: "Lost contact is reported",
    body: "If a worker stops responding, its job shows Lost contact. Mezair does not mark it as cancelled."
  },
  {
    title: "Approvals",
    body: "A bootstrap recipe waits for approval from another of your devices. A worker can't approve its own request."
  }
];

const leaving = [
  { title: "Share links", body: "The recipient's browser decrypts them. Revoke a link to remove the hosted copy." },
  { title: "Export", body: "An encrypted backup of your synced data. Keep your recovery key to restore it." },
  { title: "Delete your account", body: "Deletes the account's data from the backend. The account page shows the deletion's progress until it finishes." }
];

export default function SyncPage() {
  return (
    <div className="cine min-h-screen">
      <SiteHeader active="sync" showThemeToggle={false} />
      <main id="main-content">
        <section className="cine-hero cine-lit" aria-labelledby="sync-hero-title">
          <div className="cine-wide">
            <div className="cine-titlerow">
              <h1 id="sync-hero-title" className="cine-title">
                Use Mezair on all your machines
              </h1>
              <div>
                <p className="cine-lede md:max-w-[60ch] lg:max-w-[46ch]">
                  Sync copies your Mezair setup between machines and encrypts it on your device first. Mesh sends jobs
                  between those machines and can move a running session.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button asChild size="lg">
                    <Link href="/waitlist">Request beta access</Link>
                  </Button>
                  <Button asChild size="lg" variant="outline">
                    <Link href="/docs/sync/self-deploy">Self-host</Link>
                  </Button>
                </div>
                <p className="cine-fine mt-4">
                  Invite-only beta through {featureBeta.endDate}. Requesting access is not a purchase.{" "}
                  <Link href="/account/billing" className="cine-link">
                    Redeem your code
                  </Link>{" "}
                  or check{" "}
                  <Link href="/docs/sync/status-and-limits" className="cine-link">
                    beta status
                  </Link>
                  .
                </p>
              </div>
            </div>
            <div className="cine-stage">
              <MeshStage />
            </div>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="what-syncs">
          <div className="page-shell">
            <h2 id="what-syncs" className="cine-h2 max-w-[16ch]">
              What syncs and what stays local
            </h2>
            <p className="cine-lede mt-4">Every workspace starts local. Nothing syncs until you turn it on for that workspace.</p>
            <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
              <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-1">
                <div>
                  <h3 className="font-semibold">Syncs, encrypted</h3>
                  <ul className="mt-3 grid gap-2">
                    {syncs.map((item) => (
                      <li key={item} className="flex gap-3 text-[0.9375rem] leading-6">
                        <Check className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="font-semibold">Not included in workspace Sync</h3>
                  <ul className="mt-3 grid gap-2">
                    {neverSyncs.map((item) => (
                      <li key={item} className="flex gap-3 text-[0.9375rem] leading-6">
                        <Minus className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <EnvelopeBoundary className="min-w-0" />
            </div>
            <p className="cine-fine mt-8">
              Key rotation and how a new device gets the key are in{" "}
              <Link href="/docs/sync/encryption" className="cine-link">
                encryption and keys
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="devices-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
            <div>
              <h2 id="devices-title" className="cine-h2 max-w-[14ch]">
                Manage your devices
              </h2>
              <p className="cine-lede mt-5">
                Settings lists each enrolled machine and how it became trusted. You can compare a code to verify a device
                or revoke a lost one. Revoking from the app also rotates the account key.
              </p>
              <p className="cine-fine mt-4">
                Each machine has its own setting for running jobs and its own limit on what those jobs may do.
              </p>
              <Link href="/docs/sync/devices" className="cine-link mt-6 inline-flex min-h-11 items-center gap-2">
                Devices and sign-in
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="grid min-w-0 gap-6">
              <Shot id="mesh-status" sizes="(min-width: 1024px) 640px, 94vw" />
              <Shot id="mesh-devices" sizes="(min-width: 1024px) 640px, 94vw" />
            </div>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="mesh-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
            <div className="lg:sticky lg:top-24">
              <h2 id="mesh-title" className="cine-h2 max-w-[13ch]">
                Run jobs on another machine
              </h2>
              <p className="cine-lede mt-5">
                A machine you set up as a worker checks out the commit you chose and runs the job in its own worktree,
                with its own logins. You can watch the output from any of your devices.
              </p>
              <dl className="mt-8 grid gap-6 sm:grid-cols-2">
                {guarantees.map((item) => (
                  <div key={item.title}>
                    <dt className="font-semibold">{item.title}</dt>
                    <dd className="mt-1 text-[0.9375rem] leading-relaxed text-muted-foreground">{item.body}</dd>
                  </div>
                ))}
              </dl>
              <Link href="/docs/sync/mesh-jobs" className="cine-link mt-8 inline-flex min-h-11 items-center gap-2">
                How Mesh jobs work
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="grid min-w-0 gap-6">
              <Shot id="mesh-jobs" sizes="(min-width: 1024px) 640px, 94vw" />
              <Shot id="mesh-approval" sizes="(min-width: 1024px) 640px, 94vw" />
            </div>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="routes-title">
          <div className="page-shell grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 id="routes-title" className="cine-h2 max-w-[13ch]">
                LAN-first routing
              </h2>
              <p className="cine-lede mt-5">
                Commands and output use the host&apos;s LAN address when it answers. A live session switches to a better
                route only after the new route has authenticated and caught up, and Mesh never resends a command.
              </p>
              <p className="cine-fine mt-4">
                {featureBeta.label}. Your backend still admits and authorises every session, so this is not offline
                mode. A route labelled Direct is the host&apos;s address hint, not proof of a physical LAN path.
              </p>
              <Link href="/docs/sync/lan-first-routes" className="cine-link mt-6 inline-flex min-h-11 items-center gap-2">
                How routes work
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <figure className="min-w-0">
              <figcaption className="mb-4">
                <span className="block font-semibold">LAN-first routes</span>
                <span className="cine-fine block">Mesh tries routes in this order.</span>
              </figcaption>
              <ol className="ladder">
                {routes.map((route, index) => (
                  <li key={route.name}>
                    <span className="ladder-rank" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="ladder-name">{route.name}</span>
                    <span className="ladder-tag">{route.tag}</span>
                  </li>
                ))}
              </ol>
            </figure>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="handoff-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
            <div>
              <h2 id="handoff-title" className="cine-h2 max-w-[14ch]">
                Move a running session
              </h2>
              <p className="cine-lede mt-5">
                Move session hands a running thread to another machine. The source machine pauses the thread and saves an
                encrypted checkpoint at the current commit. The target machine resumes from that checkpoint. No running
                process moves between machines.
              </p>
              <p className="cine-fine mt-4">Save and push your changes before moving a session.</p>
              <Link href="/docs/sync/session-handoff" className="cine-link mt-6 inline-flex min-h-11 items-center gap-2">
                How session handoff works
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <Shot id="mesh-session" className="min-w-0" sizes="(min-width: 1024px) 640px, 94vw" />
          </div>
        </section>

        <section className="cine-section" aria-labelledby="backends-title">
          <div className="page-shell">
            <h2 id="backends-title" className="cine-h2 max-w-[14ch]">
              Choose a backend
            </h2>
            <p className="cine-lede mt-4">The same app talks to any of these. Pick one in Settings, under Sync &amp; Mesh.</p>
            <ul className="rows mt-10">
              {syncBackends.map((backend) => (
                <li key={backend.name}>
                  <p className="font-semibold">{backend.name}</p>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{backend.body}</p>
                  <p className="text-sm font-medium md:text-right">{backend.cost}</p>
                </li>
              ))}
            </ul>

            <h3 className="mt-16 text-xl font-semibold">Temporary cloud environments</h3>
            <p className="cine-fine mt-2">
              A workflow can ask for a temporary environment in a cloud account you connect. That provider bills you
              directly.{" "}
              <Link href="/docs/cloud/agent-sandboxes" className="cine-link">
                How sandboxes work
              </Link>
            </p>
            <ul className="rows mt-6">
              {agentEnvironments.map((environment) => (
                <li key={environment.provider}>
                  <Link href={environment.href} className="cine-link font-semibold">
                    {environment.provider}
                  </Link>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{environment.detail}</p>
                  <p
                    className={`text-sm font-medium md:text-right ${environment.status === "Later" ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {environment.status}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="leave-title">
          <div className="page-shell">
            <h2 id="leave-title" className="cine-h2 max-w-[16ch]">
              Sharing, export and deletion
            </h2>
            <ul className="rows mt-10">
              {leaving.map((item) => (
                <li key={item.title}>
                  <p className="font-semibold">{item.title}</p>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="sync-close-title">
          <div className="page-shell">
            <h2 id="sync-close-title" className="cine-title max-w-[15ch]">
              Try the hosted beta
            </h2>
            <p className="cine-lede mt-6">
              The beta is invite-only. You can redeem your invitation code without a payment method, and paid plans
              aren&apos;t on sale yet. You can also run the backend yourself.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/waitlist">Request beta access</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/pricing">See pricing</Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link href="/docs/sync">Read the docs</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
