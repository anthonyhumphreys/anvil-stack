import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check, MoonStar } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export const metadata: Metadata = {
  title: "Hosted sync | Anvil",
  description:
    "Anvil hosted sync: encrypted replication of your Anvil state across devices, mesh execution coordination, and artifact storage — free through 31 October 2026."
};

const includes = [
  "Encrypted sync of account-owned Anvil state — workspace definitions, workflow templates, editable agents, and approved settings — across your devices.",
  "Mesh execution: enrolled devices pick up jobs such as workspace preparation, provider sessions, and delegated workflow nodes.",
  "Artifact storage for run outputs within the account's hosted limits.",
  "Device pairing by single-use codes, with revoke and rename surfaced in the account area."
];

const notIncluded = [
  "Your machines supply the compute. Enrolled devices run the jobs — the hosted backend does not execute your code.",
  "Your LLM providers supply the models. Hosted sync coordinates work; it does not run inference or resell tokens.",
  "The backend sees sealed payloads and metadata needed to coordinate — content stays encrypted for your devices."
];

export default function SyncPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="sync" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 py-14 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-20">
            <div className="flex flex-col gap-6">
              <Badge variant="secondary" className="w-fit border bg-muted/70">
                Anvil-hosted sync — preview
              </Badge>
              <h1 className="max-w-3xl text-4xl font-semibold leading-[1.05] tracking-normal sm:text-5xl">
                Your Anvil state, everywhere you work.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
                Hosted sync is the operated backend for Anvil Sync &amp; Mesh: one account, your
                devices kept in step, mesh jobs dispatched to your own machines. Free through the
                preview; paid enforcement starts 1 Nov 2026.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <Button asChild size="lg">
                  <Link href="/account">
                    Open your account
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href="/docs/desktop/sync-and-mesh">Sync &amp; Mesh docs</Link>
                </Button>
              </div>
            </div>
            <div className="grid content-start gap-3">
              <WhatItIs />
            </div>
          </div>
        </section>

        <section className="border-b bg-muted/20 py-14">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.58fr_1.42fr] lg:px-8">
            <SectionHeading
              title="What hosted sync includes"
              description="The operated backend stores and coordinates — it does not compute."
            />
            <div className="grid gap-6">
              <ul className="grid gap-2 text-sm text-muted-foreground">
                {includes.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="rounded-lg border bg-background p-5">
                <h3 className="font-semibold">Where the compute lives</h3>
                <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
                  {notIncluded.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <span className="mt-2 size-1 shrink-0 rounded-full bg-border" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b py-14">
          <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.58fr_1.42fr] lg:px-8">
            <SectionHeading
              title="Preview, then paid"
              description="The dates are fixed and stated plainly — no surprise metering."
            />
            <div className="grid gap-5">
              <div className="rounded-lg border bg-card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">Preview window</h3>
                  <Badge variant="outline" className="border-accent/60">
                    <MoonStar className="mr-1 size-3" aria-hidden="true" />
                    Ends at the stroke of midnight, Oct 31
                  </Badge>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Hosted sync is free for every signed-in account through 31 October 2026. From
                  1 Nov 2026 (2026-11-01T00:00:00Z) the backend enforces paid entitlement: sync
                  writes and mesh submissions need an active subscription or a grace window. Reads
                  and local-only mode are unaffected — Anvil works without hosted sync entirely.
                </p>
              </div>
              <div className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Self-host instead</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  The backend is open source and provider-neutral. Point Anvil at your own
                  Cloudflare deployment, or any implementation that passes the conformance suite —
                  no subscription, no hosted account.
                </p>
                <div className="mt-4">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/docs/desktop/sync-and-mesh">
                      Self-deploy guide
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                This is alpha infrastructure: implemented and rehearsed on real deployments, not
                yet demoed end-to-end on physical hardware. The{" "}
                <Link
                  href="/docs/desktop/sync-and-mesh"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  docs
                </Link>{" "}
                carry the current limits.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function WhatItIs() {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <p className="font-mono text-xs text-muted-foreground">Settings → Sync &amp; Mesh</p>
      <dl className="mt-4 grid gap-3 text-sm">
        {[
          ["Local only", "Nothing leaves the device."],
          ["Anvil-hosted", "This operated backend — sign in, pair devices, sync."],
          ["Your Cloudflare", "A Workers deployment you own."],
          ["Compatible backend", "Any URL implementing the Sync v1 contract."]
        ].map(([mode, body]) => (
          <div
            key={mode}
            className="grid gap-1 rounded-md border bg-background/70 px-3 py-2 sm:grid-cols-[9.5rem_1fr]"
          >
            <dt className="font-medium">{mode}</dt>
            <dd className="text-muted-foreground">{body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">{title}</h2>
      <p className="mt-3 text-base leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}
