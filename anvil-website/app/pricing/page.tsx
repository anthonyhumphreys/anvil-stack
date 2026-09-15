import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
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
  "Encrypted sync of workspaces, templates, agents, and approved settings",
  "Mesh job dispatch to your enrolled devices",
  "Artifact storage within account limits",
  "Device pairing, rename, and revoke from the web account"
];

export default function PricingPage() {
  const monthly = formatPrice(monthlyPrice);
  const annual = formatPrice(annualPrice);

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="pricing" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
            <div className="max-w-3xl">
              <Badge variant="secondary" className="border bg-muted/70">
                Pricing — current and planned
              </Badge>
              <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-normal sm:text-5xl">
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

        <section className="py-14">
          <div className="mx-auto grid max-w-7xl gap-5 px-4 sm:px-6 lg:grid-cols-3 lg:px-8">
            <article className="rounded-lg border bg-card p-6 shadow-sm">
              <h2 className="text-xl font-semibold">Preview</h2>
              <p className="mt-1 text-sm text-muted-foreground">Every signed-in account, now.</p>
              <p className="mt-5 text-3xl font-semibold">Free</p>
              <p className="mt-1 text-sm text-muted-foreground">through 31 October 2026</p>
              <ul className="mt-5 grid gap-2 text-sm text-muted-foreground">
                {hostedPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
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

            <article className="rounded-lg border bg-card p-6 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold">Sync</h2>
                <Badge variant="outline" className="border-accent/60">
                  Available 1 Nov 2026
                </Badge>
              </div>
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
              <ul className="mt-5 grid gap-2 text-sm text-muted-foreground">
                {hostedPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
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

            <article className="rounded-lg border bg-card p-6 shadow-sm">
              <h2 className="text-xl font-semibold">Self-host</h2>
              <p className="mt-1 text-sm text-muted-foreground">Your backend, your rules.</p>
              <p className="mt-5 text-3xl font-semibold">Free</p>
              <p className="mt-1 text-sm text-muted-foreground">always — it is your infrastructure</p>
              <ul className="mt-5 grid gap-2 text-sm text-muted-foreground">
                {selfHostPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Button asChild variant="outline">
                  <Link href="/docs/desktop/sync-and-mesh">
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
                  Anvil is alpha infrastructure. If that caveat matters to you, the docs carry the
                  current status rather than a promise.
                </li>
              </ul>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
