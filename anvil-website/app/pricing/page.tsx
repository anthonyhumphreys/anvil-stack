import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { workosConfigured } from "@/lib/workos-env";

export const metadata: Metadata = {
  title: "Pricing | Anvil",
  description:
    "Anvil hosted access is free for admitted preview users through Halloween 2026. Personal plans start at £8/month; team billing starts at £35/month for five developers."
};

const hostedPoints = [
  "End-to-end encrypted sync of workspaces, templates, agents, and approved settings",
  "Mesh job dispatch to your own enrolled devices",
  "Hosted artifact storage under fair use",
  "Device pairing, rename, and revoke from the web account"
];

const selfHostPoints = [
  "Same Sync v1 contract — the desktop does not care who operates the backend",
  "Deploy the open-source backend to your own Cloudflare account",
  "Or point at any third-party implementation that passes the conformance suite",
  "No hosted account, subscription, or entitlement checks"
];

const faqs = [
  {
    q: "Who can use hosted Anvil during preview?",
    a: "Access is invite-only through the WorkOS waitlist. Anvil reviews requests and approves people before they can create an account. Existing users can still sign in."
  },
  {
    q: "What happens on 1 November 2026?",
    a: "Paid enforcement begins at 2026-11-01T00:00:00Z. Each developer will need a Personal subscription or a seat funded by a team. Preview access will not convert into a charge automatically. Local-only mode remains free."
  },
  {
    q: "Can my organisation see my work?",
    a: "No. A team seat pays for hosted access only. Membership does not give owners access to personal workspaces, repositories, artifacts, devices, or execution environments. Shared projects are not part of this release."
  },
  {
    q: "How many devices are included?",
    a: "Each developer can enroll up to five trusted devices, across personal and team funding. Revoke an old device to make room for a replacement."
  },
  {
    q: "Are there usage charges?",
    a: "There are no automatic usage charges or normal-use caps on projects and jobs. Hosted storage and transfer are covered by fair use; sustained exceptional usage is handled with notice."
  },
  {
    q: "Why would I pay instead of self-hosting?",
    a: "If operating a Cloudflare Worker, R2 bucket, D1 database, and WorkOS/Stripe wiring sounds fine, self-hosting is free. Hosted buys you the operated account, device, sync, and billing surfaces."
  }
];

export default function PricingPage() {
  const authEnabled = workosConfigured();

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="pricing" />
      <main id="main-content">
        <section className="border-b">
          <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-3xl">
              <h1 className="text-4xl font-semibold leading-[1.02] tracking-[-0.03em] sm:text-5xl lg:text-6xl">
                Hosted access, solo or team funded.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                The preview is invite-only and free through 31 October 2026. From 1 November, pay
                personally or use a seat paid for by your team. Self-hosting remains free.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                {authEnabled ? (
                  <Button asChild>
                    <Link href="/waitlist">
                      Request preview access
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                ) : null}
                <Button asChild variant="outline">
                  <Link href="/account">Already admitted? Sign in</Link>
                </Button>
              </div>
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-16" aria-labelledby="plans-heading">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-8 max-w-2xl">
              <h2 id="plans-heading" className="text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                One hosted service. Two ways to pay.
              </h2>
              <p className="mt-3 text-base leading-7 text-muted-foreground">
                Personal and team-funded developers get the same hosted features and five trusted
                devices. Team plans combine billing; they do not combine private work.
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <article className="flex flex-col rounded-lg border border-accent/50 bg-card p-6">
                <h3 className="text-xl font-semibold">Preview</h3>
                <p className="mt-1 text-sm text-muted-foreground">Approved waitlist members.</p>
                <p className="mt-5 text-3xl font-semibold">Free</p>
                <p className="mt-1 text-sm text-muted-foreground">through 31 October 2026 · no card</p>
                <ul className="mt-5 grid flex-1 gap-2 text-sm text-muted-foreground">
                  {hostedPoints.map((point) => (
                    <li key={point} className="flex items-start gap-2">
                      <Check className="proof-check" aria-hidden="true" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </article>

              <article className="flex flex-col rounded-lg border bg-card p-6">
                <h3 className="text-xl font-semibold">Personal</h3>
                <p className="mt-1 text-sm text-muted-foreground">Your account, your hosted access.</p>
                <dl className="mt-5 grid gap-2 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">Monthly</dt>
                    <dd className="text-2xl font-semibold">£8<span className="text-sm font-normal text-muted-foreground"> / month</span></dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">Annual</dt>
                    <dd className="text-xl font-semibold">£80<span className="text-sm font-normal text-muted-foreground"> / year</span></dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Five devices. No normal-use caps on projects or jobs. Hosted storage and transfer
                  are covered by fair use.
                </p>
                <p className="mt-auto pt-5 text-xs text-muted-foreground">Available from 1 November 2026.</p>
              </article>

              <article className="flex flex-col rounded-lg border bg-card p-6">
                <h3 className="text-xl font-semibold">Small Team</h3>
                <p className="mt-1 text-sm text-muted-foreground">One invoice for up to five developers.</p>
                <dl className="mt-5 grid gap-2 text-sm">
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">Monthly · 5 seats</dt>
                    <dd className="text-2xl font-semibold">£35<span className="text-sm font-normal text-muted-foreground"> / month</span></dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted-foreground">Annual · 5 seats</dt>
                    <dd className="text-xl font-semibold">£350<span className="text-sm font-normal text-muted-foreground"> / year</span></dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Five seats are the minimum purchase. From seat six, add £7/month or £70/year per
                  developer. Each person keeps five devices.
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  The organisation pays for hosted access only. Personal work remains private; this
                  plan does not include shared workspaces.
                </p>
                <p className="mt-auto pt-5 text-xs text-muted-foreground">Available from 1 November 2026.</p>
              </article>
            </div>

            <div className="mt-8 grid gap-8 border-y py-6 md:grid-cols-[0.7fr_1.3fr]">
              <div>
                <h3 className="font-semibold">Self-host</h3>
                <p className="mt-1 text-sm text-muted-foreground">Your backend, your rules. Free always.</p>
                <Button asChild variant="outline" className="mt-4">
                  <Link href="/docs/sync/self-deploy">
                    Self-deploy guide
                    <ArrowRight data-icon="inline-end" aria-hidden="true" />
                  </Link>
                </Button>
              </div>
              <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                {selfHostPoints.map((point) => (
                  <li key={point} className="flex items-start gap-2">
                    <Check className="proof-check" aria-hidden="true" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-8 rounded-lg border bg-muted/30 p-5">
              <h3 className="font-semibold">Fair use and the preview deadline</h3>
              <ul className="mt-3 grid gap-2 text-sm text-muted-foreground">
                <li>
                  Paid enforcement starts 1 November 2026 at 00:00 UTC. Preview accounts will not
                  become paid subscriptions automatically.
                </li>
                <li>
                  The five-device limit applies per person. Hosted storage and transfer follow fair
                  use; no automatic usage charges apply.
                </li>
                <li>
                  If hosted access is not the right fit, local-only use and self-hosting remain
                  available. See the{" "}
                  <Link href="/docs/sync/status-and-limits" className="font-medium text-foreground underline underline-offset-4">
                    status and limits
                  </Link>{" "}
                  notes for current implementation details.
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
                How access, billing, and team membership work during and after preview.
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
