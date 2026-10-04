import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export const metadata: Metadata = {
  title: "Pricing | Anvil",
  description:
    "Anvil Sync & Mesh are free. Existing provider integrations use your own accounts. Anvil Cloud Agents hosted compute will be paid when available; no price or release date is set."
};

const syncPoints = [
  "Encrypted sync for workspace definitions, templates, agents, and approved settings",
  "Mesh jobs and session handoff across machines you control",
  "Use local, Anvil-hosted, self-hosted, or compatible backends",
  "No Anvil subscription or billing account required"
];

const providerPoints = [
  "Run on machines you own, or VMs in provider accounts you configure",
  "Use supported AWS, Cloudflare, and Vercel sandbox integrations",
  "Anvil does not charge for these integrations",
  "Cloud providers and model providers bill your account directly"
];

const faqs = [
  {
    q: "Does Sync & Mesh have an Anvil subscription?",
    a: "No. Sync & Mesh are free, including the Anvil-hosted service when it is available. You can also run the backend yourself or use a compatible implementation."
  },
  {
    q: "Can I run agents through my machines and provider accounts?",
    a: "Yes. Run on machines you own, VMs in accounts you configure, or supported AWS, Cloudflare, and Vercel sandbox integrations. Anvil does not charge for these integrations. Cloud and model providers bill you directly."
  },
  {
    q: "What is Anvil Cloud Agents?",
      a: "Anvil Cloud is the open-source runtime and CLI. Anvil Cloud Agents is the planned hosted compute service for running agents on Anvil-managed infrastructure. It is not yet available, and hosted compute will be paid when it launches."
  },
  {
    q: "Are model and cloud provider charges included?",
    a: "No. You connect your own provider accounts and credentials. Any charges for models, VMs, storage, or other provider resources go directly to those providers."
  }
];

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="pricing" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-3xl">
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-accent">
                Pricing and provider costs
              </p>
              <h1 className="mt-4 text-4xl font-semibold leading-[1.02] tracking-[-0.03em] sm:text-5xl lg:text-6xl">
                Sync &amp; Mesh are free. Hosted agent compute is a separate product.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                Sync &amp; Mesh are free. You can run agent work on your own machines
                and provider accounts. Anvil Cloud Agents will charge for Anvil-managed hosted
                compute when that service is available. There is no price or release date yet.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/docs/sync/overview">
                    Read about Sync &amp; Mesh
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/docs/cloud/agent-sandboxes">Read agent execution documentation</Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-16" aria-labelledby="pricing-model-heading">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 max-w-2xl">
              <h2 id="pricing-model-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                What costs money
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Anvil charges only for future compute that Anvil operates. Your own infrastructure
                and provider accounts stay under your control.
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <article className="flex flex-col rounded-lg border border-accent/50 bg-card p-6">
                <h3 className="text-xl font-semibold">Anvil Sync &amp; Mesh</h3>
                <p className="mt-1 text-sm text-muted-foreground">Free</p>
                <p className="mt-5 text-3xl font-semibold">£0</p>
                <p className="mt-1 text-sm text-muted-foreground">No subscription required</p>
                <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                  {syncPoints.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <Check className="proof-check" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-5 border-t pt-4 text-xs leading-5 text-muted-foreground">
                  Anvil-hosted Sync &amp; Mesh is not yet available. The hosted service is being
                  prepared for launch.
                </p>
              </article>

              <article className="flex flex-col rounded-lg border bg-card p-6">
                <h3 className="text-xl font-semibold">Your machines and providers</h3>
                <p className="mt-1 text-sm text-muted-foreground">No Anvil integration fee</p>
                <p className="mt-5 text-3xl font-semibold">Your account</p>
                <p className="mt-1 text-sm text-muted-foreground">You pay the provider directly</p>
                <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                  {providerPoints.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <Check className="proof-check" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </article>

              <article className="flex flex-col rounded-lg border bg-card p-6">
                <h3 className="text-xl font-semibold">Anvil Cloud Agents</h3>
                <p className="mt-1 text-sm text-muted-foreground">Anvil-managed hosted compute</p>
                <p className="mt-5 text-2xl font-semibold">Paid when available</p>
                <p className="mt-1 text-sm text-muted-foreground">Not yet available</p>
                <p className="mt-5 flex-1 text-sm leading-6 text-muted-foreground">
                  This future service will run agent compute on infrastructure operated by Anvil.
                  It is separate from Sync &amp; Mesh and from provider integrations you configure
                  yourself.
                </p>
                <p className="mt-5 border-t pt-4 text-xs leading-5 text-muted-foreground">
                  Model and provider charges are separate and billed by those providers.
                </p>
              </article>
            </div>

            <div className="mt-8 grid gap-8 border-y py-6 md:grid-cols-[0.7fr_1.3fr]">
              <div>
                <h3 className="font-semibold">Run the backend yourself</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sync &amp; Mesh software is open source. Your infrastructure provider may charge
                  for resources in your account.
                </p>
                <Button asChild variant="outline" className="mt-4">
                  <Link href="/docs/sync/self-deploy">
                    Self-deploy guide
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                Anvil Cloud is the open-source runtime and CLI. The paid service described here is
                only the future hosted compute operated by Anvil under the Anvil Cloud Agents name.
                Cloud deployment plans report resource counts and cost drivers; they are not a bill
                or an estimate from Anvil.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t bg-muted/20 py-14 lg:py-16" aria-labelledby="pricing-faq">
          <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.7fr_1.3fr] lg:px-8">
            <div>
              <h2 id="pricing-faq" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                Asked, answered
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                The distinction is who operates and pays for the compute.
              </p>
            </div>
            <dl className="grid gap-0">
              {faqs.map((item) => (
                <div key={item.q} className="border-t py-5">
                  <dt className="font-semibold">{item.q}</dt>
                  <dd className="mt-2 text-sm leading-6 text-muted-foreground">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
