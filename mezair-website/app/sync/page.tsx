import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check, FileDown, Minus, Share2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { agentEnvironments, featureBeta, syncBackends } from "@/lib/site";

export const metadata: Metadata = {
  title: "Sync & Mesh | Mezair",
  description:
    "Keep your Mezair workspaces, templates and agents in step across your machines, send jobs between machines, and move a running session. Encrypted on your device before anything leaves it."
};

const syncs = [
  "Workspace setups: which repos, which agent, which rules",
  "Templates and custom agents you've built",
  "The settings you choose to share"
];

const neverSyncs = [
  "Your repository files",
  "API keys and provider logins",
  "Chat transcripts",
  "Paths on your machine"
];

const journey = [
  { title: "Saved here first", body: "Your change lands on this machine straight away, online or not." },
  {
    title: "Encrypted",
    body: "Your device encrypts the change before sending it. If your encryption key is unavailable, the change waits on your device."
  },
  {
    title: "Stored",
    body: "The server stores the encrypted change. It can see metadata such as its size and timing, but cannot read its contents."
  },
  {
    title: "Delivered",
    body: "Your connected devices receive the change and decrypt it with your account key."
  },
  {
    title: "Conflicts resolved",
    body: "If two devices change the same setting, Mezair shows the conflict so you can choose what to keep."
  }
];

const handoff = [
  "Requested",
  "Other machine checks it can continue",
  "Current session pauses",
  "Session progress is encrypted",
  "Session moves to the other machine",
  "Other machine resumes the session",
  "Done"
];

const leaving = [
  {
    icon: Share2,
    title: "Share links that stay private",
    body: "The person with the complete link can open the shared content. Their browser decrypts it locally. Revoke the link to remove the hosted copy and prevent future downloads."
  },
  {
    icon: FileDown,
    title: "Export everything",
    body: "Download an encrypted backup of your synced data. Preview changes before you import it, and keep your account recovery key so you can restore it."
  },
  {
    icon: Trash2,
    title: "Delete your account",
    body: "Deleting your account removes its data from the backend, and you can follow the deletion through to the end."
  }
];

export default function SyncPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="sync" />
      <main id="main-content">
        <section className="page-shell pb-20 pt-16 sm:pt-24">
          <h1 className="font-display text-display-1 max-w-[15ch]">Your workbench, on every machine you use.</h1>
          <div className="mt-10 grid gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
            <div>
              <p className="lede">
                Sync &amp; Mesh moves your Mezair setup between machines and lets them share work. Your synced setup
                is encrypted on your device before it reaches the server. Repository files stay on
                your own machines.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg">
                  <Link href="/waitlist">Request beta access</Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/docs/sync/self-deploy">Run your own backend</Link>
                </Button>
              </div>
              <p className="mt-6 max-w-[52ch] text-sm leading-6 text-muted-foreground">
                Sync &amp; Mesh, including LAN-first Mesh routing, is in beta through{" "}
                {featureBeta.endDate}. It works today on a backend you deploy to your own Cloudflare
                account. Mezair hosting is invite-only during the beta: request access, and invited
                testers receive a beta access code. Requesting access is not a purchase; paid plans
                start at £6 a month when signup opens.{" "}
                <Link href="/account/billing" className="font-medium text-foreground underline underline-offset-4">Redeem your code</Link>.{" "}
                <Link href="/docs/sync/status-and-limits" className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
                  What works today
                </Link>
              </p>
            </div>
            <EnvelopeBoundary className="min-w-0" />
          </div>
        </section>

        <section className="border-t py-20 lg:py-28" aria-labelledby="what-syncs">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div>
              <h2 id="what-syncs" className="font-display text-display-2 max-w-[11ch]">
                What syncs, and what never does.
              </h2>
              <p className="mt-5 max-w-[36ch] text-muted-foreground">
                Every workspace starts local. Nothing syncs until you turn it on for that workspace.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
              <div className="bg-card p-7">
                <h3 className="text-lg font-semibold">Syncs, encrypted</h3>
                <ul className="mt-5 grid gap-3">
                  {syncs.map((item) => (
                    <li key={item} className="flex gap-3 text-[0.9375rem] leading-7">
                      <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-card p-7">
                <h3 className="text-lg font-semibold">Not included in workspace Sync</h3>
                <ul className="mt-5 grid gap-3">
                  {neverSyncs.map((item) => (
                    <li key={item} className="flex gap-3 text-[0.9375rem] leading-7">
                      <Minus className="mt-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t bg-muted/40 py-20 lg:py-28" aria-labelledby="journey-title">
          <div className="page-shell">
            <h2 id="journey-title" className="font-display text-display-2 max-w-[18ch]">
              How a change reaches your other machines.
            </h2>
            <ol className="mt-14 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-5">
              {journey.map((item, index) => (
                <li key={item.title} className="relative border-t-2 border-foreground/80 pt-5">
                  <span className="font-mono text-sm text-accent">{index + 1}</span>
                  <h3 className="mt-2 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-[0.9375rem] leading-7 text-muted-foreground">{item.body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-12 max-w-[60ch] text-muted-foreground">
              The details, including key rotation and how a new device gets the key, are in{" "}
              <Link href="/docs/sync/encryption" className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
                encryption and keys
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="border-t py-20 lg:py-28" aria-labelledby="mesh-title">
          <div className="page-shell grid gap-14 lg:grid-cols-2">
            <div>
              <h2 id="mesh-title" className="font-display text-display-2 max-w-[13ch]">
                Send work to another machine.
              </h2>
              <p className="mt-5 max-w-[48ch] text-lg leading-8 text-muted-foreground">
                Each machine says what it can run. Send a job and a suitable machine picks it up, checks
                out the exact commit you pinned, and runs it in a separate working copy. You watch the
                output from wherever you are.
              </p>
              <ul className="mt-8 grid gap-4 text-[0.9375rem] leading-7">
                <li className="flex gap-3">
                  <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  Your chosen machine runs the job and uses its own credentials. Model calls go to
                  your chosen provider. The Sync server routes jobs between your machines.
                </li>
                <li className="flex gap-3">
                  <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  Making a machine a worker is a choice you make on that machine. There&apos;s no switch that
                  makes every machine run everything.
                </li>
                <li className="flex gap-3">
                  <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  When a job is stopping or a machine goes quiet, Mezair says so plainly instead of
                  guessing.
                </li>
                <li className="flex gap-3">
                  <Check className="mt-1.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  <span>
                    <Link href="/docs/sync/lan-first-routes" className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground">
                      LAN-first routes
                    </Link>{" "}
                    (beta through {featureBeta.endDate}). Mesh tries the host&apos;s LAN address
                    first, then other private routes, HTTPS and managed ingress. A live session
                    moves to a better route only after its replacement has authenticated and caught
                    up, and commands are never resent. Your backend still admits and authorises
                    every session, so this is not offline mode.
                  </span>
                </li>
              </ul>
            </div>
            <div className="rounded-xl border bg-card p-7 sm:p-8">
              <h3 className="text-xl font-semibold">Move a running session</h3>
              <p className="mt-3 text-[0.9375rem] leading-7 text-muted-foreground">
                Hand a session from your laptop to your desktop, or back. The other machine prepares the
                workspace and checks it can continue. Mezair then pauses the current session, encrypts
                its saved progress, and resumes it on the other machine.
              </p>
              <ol className="mt-7 grid gap-0" aria-label="Handoff steps">
                {handoff.map((state, index) => (
                  <li key={state} className="flex items-center gap-4">
                    <span className="flex w-5 flex-col items-center self-stretch" aria-hidden="true">
                      <span className={`w-px flex-1 ${index === 0 ? "bg-transparent" : "bg-border"}`} />
                      <span className={`size-2.5 rounded-full border-2 ${index === handoff.length - 1 ? "border-accent bg-accent" : "border-foreground/60 bg-card"}`} />
                      <span className={`w-px flex-1 ${index === handoff.length - 1 ? "bg-transparent" : "bg-border"}`} />
                    </span>
                    <span className="py-1.5 text-[0.9375rem]">{state}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-6 border-t pt-5 text-sm leading-6 text-muted-foreground">
                Uncommitted or unpushed changes stop a handoff before it starts, and Mezair tells you
                what to fix.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t py-20 lg:py-28" aria-labelledby="borrow-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div>
              <h2 id="borrow-title" className="font-display text-display-2 max-w-[12ch]">
                Borrow a machine for a while.
              </h2>
              <p className="mt-5 max-w-[38ch] text-muted-foreground">
                A workflow can ask for a temporary environment in a cloud account you connect. That
                provider bills you directly.
              </p>
              <Link
                href="/docs/cloud/agent-sandboxes"
                className="mt-6 inline-flex min-h-11 items-center gap-2 font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
              >
                How sandboxes work
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <ul className="divide-y border-y">
              {agentEnvironments.map((environment) => (
                <li key={environment.provider} className="grid gap-1 py-5 sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-6">
                  <Link href={environment.href} className="font-semibold underline-offset-4 hover:underline">
                    {environment.provider}
                  </Link>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{environment.detail}</p>
                  <span className={`text-sm font-medium ${environment.status === "Later" ? "text-muted-foreground" : "text-foreground"}`}>
                    {environment.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t bg-muted/40 py-20 lg:py-28" aria-labelledby="leave-title">
          <div className="page-shell">
            <h2 id="leave-title" className="font-display text-display-2 max-w-[16ch]">
              Share safely. Leave whenever you like.
            </h2>
            <ul className="mt-14 grid gap-x-12 gap-y-10 md:grid-cols-3">
              {leaving.map((item) => (
                <li key={item.title}>
                  <item.icon className="size-5 text-accent" aria-hidden="true" />
                  <h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-[0.9375rem] leading-7 text-muted-foreground">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t py-20 lg:py-28" aria-labelledby="backends-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div>
              <h2 id="backends-title" className="font-display text-display-2 max-w-[11ch]">
                Choose where it lives.
              </h2>
              <p className="mt-5 max-w-[38ch] text-muted-foreground">
                The same app talks to any of these. Pick one in Settings, under Sync &amp; Mesh.
              </p>
            </div>
            <ul className="divide-y border-y">
              {syncBackends.map((backend) => (
                <li key={backend.name} className="grid gap-1 py-5 sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-6">
                  <p className="font-semibold">{backend.name}</p>
                  <p className="text-[0.9375rem] leading-7 text-muted-foreground">{backend.body}</p>
                  <p className="text-sm font-medium sm:text-right">{backend.cost}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t py-24 lg:py-32">
          <div className="page-shell">
            <h2 className="font-display text-display-1 max-w-[15ch]">Try the hosted beta.</h2>
            <p className="lede mt-6">
              Hosted Sync &amp; Mesh is invite-only. Request access, and redeem the code you&apos;re
              sent without a payment method. Paid plans aren&apos;t on sale yet. You can also run
              the whole thing yourself.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
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
