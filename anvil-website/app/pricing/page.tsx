import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export const metadata: Metadata = {
  title: "Pricing | Anvil",
  description:
    "Anvil hosted sync pricing: free through the preview ending 31 October 2026, a single paid plan from 1 Nov 2026, and a self-host path that costs nothing."
};

// Prices are shown verbatim from env — never fabricated. Unset means the
// card states availability without inventing a number.
const monthlyPrice = process.env.NEXT_PUBLIC_SYNC_PRICE_MONTHLY;
const annualPrice = process.env.NEXT_PUBLIC_SYNC_PRICE_ANNUAL;
const currency = process.env.NEXT_PUBLIC_SYNC_PRICE_CURRENCY;

function formatPrice(value: string | undefined): string | null {
  if (!value) return null;
  return currency ? `${currency}${value}` : value;
}

const selfHostPoints = [
  "Same Sync v1 contract — the desktop does not care who operates the backend",
  "Deploy the open-source backend to your own Cloudflare account",
  "Or point at any third-party implementation that passes the conformance suite",
  "No hosted account, no subscription, no entitlement checks"
];

const hostedPoints = [
  "End-to-end encrypted sync of workspaces, templates, agents, and approved settings — sealed on your device, stored as ciphertext",
  "Mesh job dispatch to your enrolled devices",
  "Sealed artifact storage within account limits",
  "Device pairing, rename, and revoke from the web account"
];

const faqs = [
  {
    q: "What happens on 1 November 2026?",
    a: "Paid enforcement switches on at 2026-11-01T00:00:00Z. Hosted writes then require an active subscription; failed renewals get a bounded grace window. Reads keep working, local-only mode is never gated, and you can export everything before you decide."
  },
  {
    q: "Can the Anvil-hosted backend read my workspaces?",
    a: "No. Entities seal on your device under a versioned account key; the backend validates the envelope shape and journals ciphertext. It sees ids, types, revisions, sizes, and timestamps — not content. Keys live on your enrolled devices."
  },
  {
    q: "Why would I pay instead of self-hosting?",
    a: "You would not, if running a Cloudflare worker, R2 bucket, D1 database, and WorkOS/Stripe wiring sounds fun. Hosted buys you the operated version: sign-in, web device management, billing, artifact storage, and someone else on the pager. The protocol is the same either way."
  },
  {
    q: "What are the account limits?",
    a: "Devices, artifact bytes, and history bytes are enforced by the backend's configured values, not by marketing copy — your account page shows the actual numbers it holds you to."
  }
];

export default function PricingPage() {
  const monthly = formatPrice(monthlyPrice);
  const annual = formatPrice(annualPrice);

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="pricing" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-3xl">
              <h1 className="text-4xl font-semibold leading-[1.02] tracking-[-0.03em] sm:text-5xl lg:text-6xl">
                Free during preview. One paid plan after. Self-host always.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                Hosted sync costs nothing until 1 November 2026. After that, continued hosted use
                needs the sync plan — or you run the backend yourself, which is free forever because
                it is yours.
              </p>
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-16">
          <div className="mx-auto grid max-w-7xl gap-5 px-4 sm:px-6 lg:grid-cols-3 lg:px-8">
            <article className="flex flex-col rounded-lg border border-accent/50 bg-card p-6">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-accent">Now</p>
              <h2 className="mt-2 text-xl font-semibold">Preview</h2>
              <p className="mt-1 text-sm text-muted-foreground">Every signed-in account.</p>
              <p className="mt-5 text-3xl font-semibold">Free</p>
              <p className="mt-1 text-sm text-muted-foreground">through 31 October 2026</p>
              <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                {hostedPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="proof-check" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Button asChild>
                  <Link href="/account">
                    Open your account
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </article>

            <article className="flex flex-col rounded-lg border bg-card p-6">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
                From 1 Nov 2026
              </p>
              <h2 className="mt-2 text-xl font-semibold">Sync</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The single paid plan — personal hosted sync.
              </p>
              {monthly || annual ? (
                <dl className="mt-5 grid gap-2 text-sm">
                  {monthly ? (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Monthly</dt>
                      <dd className="text-2xl font-semibold">{monthly}</dd>
                    </div>
                  ) : null}
                  {annual ? (
                    <div className="flex items-baseline justify-between gap-4">
                      <dt className="text-muted-foreground">Annual</dt>
                      <dd className="text-2xl font-semibold">{annual}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : (
                <p className="mt-5 text-3xl font-semibold">Not priced yet</p>
              )}
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Checkout opens when paid enforcement begins. Until then the backend answers
                checkout-disabled — there is nothing to buy early.
              </p>
              <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                {hostedPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="proof-check" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Button asChild variant="outline">
                  <Link href="/sync">What hosted sync does</Link>
                </Button>
              </div>
            </article>

            <article className="flex flex-col rounded-lg border bg-card p-6">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
                Always
              </p>
              <h2 className="mt-2 text-xl font-semibold">Self-host</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your backend, your rules.</p>
              <p className="mt-5 text-3xl font-semibold">Free</p>
              <p className="mt-1 text-sm text-muted-foreground">always — it is your infrastructure</p>
              <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                {selfHostPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="proof-check" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Button asChild variant="outline">
                  <Link href="/docs/sync/self-deploy">
                    Self-deploy guide
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            </article>
          </div>

          <div className="mx-auto mt-10 max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="rounded-lg border bg-muted/30 p-5">
              <h2 className="font-semibold">The honest version</h2>
              <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
                <li>
                  Paid enforcement starts 2026-11-01T00:00:00Z. Failed renewals get a bounded grace
                  window before access restricts; local-only mode is never gated.
                </li>
                <li>
                  Limits (devices, artifact bytes, history bytes) come from the backend&apos;s
                  configured values — your account page shows the numbers it actually enforces.
                </li>
                <li>
                  Anvil is alpha infrastructure. The{" "}
                  <Link href="/docs/sync/status-and-limits" className="font-medium text-foreground underline underline-offset-4">
                    status and limits doc
                  </Link>{" "}
                  carries what is proven today rather than a promise.
                </li>
              </ul>
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
                The short version of everything above, plus the questions people actually ask
                before trusting an account layer.
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
