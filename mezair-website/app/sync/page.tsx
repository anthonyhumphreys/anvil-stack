import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check, Minus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HandoffScene } from "@/components/marketing/product-reel";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { agentEnvironments, featureBeta, syncBackends } from "@/lib/site";

export const metadata: Metadata = {
  title: "Sync & Mesh | Mezair",
  description:
    "Keep your Mezair workspaces, templates and agents in step across your machines, send jobs between machines, and move a running session. Encrypted on your device before anything leaves it."
};

const syncs = ["Workspace setups: repos, agent and rules", "Templates and custom agents", "Settings you choose to share"];

const neverSyncs = ["Repository files", "API keys and provider logins", "Chat transcripts", "Paths on your machine"];

const journey = [
  { title: "Saved here first", body: "Online or not." },
  { title: "Encrypted", body: "On your device. Without the key, it waits." },
  { title: "Stored", body: "The server sees size and timing, not contents." },
  { title: "Delivered", body: "Your devices decrypt it." },
  { title: "Conflicts shown", body: "You choose what to keep." }
];

const routes = [
  { name: "The host's LAN address", tag: "tried first" },
  { name: "Other private routes", tag: "next" },
  { name: "HTTPS", tag: "then" },
  { name: "Managed ingress", tag: "last" }
];

const leaving = [
  { title: "Share links", body: "The recipient's browser decrypts them. Revoke a link to remove the hosted copy." },
  { title: "Export", body: "An encrypted backup of your synced data. Keep your recovery key to restore it." },
  { title: "Delete your account", body: "Removes its data from the backend, and you can follow the deletion to the end." }
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
                Work moves with you.
              </h1>
              <div>
                <p className="cine-lede md:max-w-[60ch] lg:max-w-[46ch]">
                  Sync carries your Mezair setup between machines, encrypted on your device. Mesh sends work between
                  them and moves a running session.
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
              <HandoffScene />
            </div>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="what-syncs">
          <div className="page-shell">
            <h2 id="what-syncs" className="cine-h2 max-w-[16ch]">
              What syncs, and what never does.
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
            <ol className="journey mt-14" aria-label="How a change reaches your other machines">
              {journey.map((step) => (
                <li key={step.title}>
                  {step.title}
                  <span>{step.body}</span>
                </li>
              ))}
            </ol>
            <p className="cine-fine mt-8">
              Key rotation and how a new device gets the key are in{" "}
              <Link href="/docs/sync/encryption" className="cine-link">
                encryption and keys
              </Link>
              .
            </p>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="mesh-title">
          <div className="page-shell grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 id="mesh-title" className="cine-h2 max-w-[13ch]">
                Send work to another machine.
              </h2>
              <p className="cine-lede mt-5">
                A machine you made a worker checks out the commit you pinned and runs the job in its own working
                copy, with its own credentials. You watch the output from anywhere.
              </p>
              <p className="cine-fine mt-4">
                Making a machine a worker is a choice you make on that machine. When a job is stopping or a machine
                goes quiet, Mezair says so instead of guessing.
              </p>
              <Link href="/docs/sync/mesh-jobs" className="cine-link mt-6 inline-flex min-h-11 items-center gap-2">
                How Mesh jobs work
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
            <figure className="min-w-0">
              <figcaption className="mb-4">
                <span className="block font-semibold">LAN-first routes</span>
                <span className="cine-fine block">{featureBeta.label}. Mesh tries routes in this order.</span>
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
              <p className="cine-fine mt-4">
                A live session moves to a better route only after the replacement has authenticated and caught up,
                and commands are never resent. Your backend still admits and authorises every session, so this is not
                offline mode.{" "}
                <Link href="/docs/sync/lan-first-routes" className="cine-link">
                  How routes work
                </Link>
              </p>
            </figure>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="backends-title">
          <div className="page-shell">
            <h2 id="backends-title" className="cine-h2 max-w-[14ch]">
              Choose where it lives.
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

            <h3 className="mt-16 text-xl font-semibold">Borrow a machine for a while.</h3>
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
              Share safely. Leave whenever you like.
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
              Try the hosted beta.
            </h2>
            <p className="cine-lede mt-6">
              Invite-only. Redeem the code you&apos;re sent without a payment method; paid plans aren&apos;t on sale
              yet. Or run the whole thing yourself.
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
