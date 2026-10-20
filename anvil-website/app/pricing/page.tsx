import Link from "next/link";
import type { Metadata } from "next";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { cn } from "@/lib/utils";
import { plans, pricingFaqs } from "@/lib/site";

export const metadata: Metadata = {
  title: "Pricing | Anvil",
  description:
    "Anvil Desktop is free and open source. Hosted Sync & Mesh is planned at £6 a month for one person or £12 per member for teams. Self-hosting stays free."
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="pricing" />
      <main id="main-content">
        <section className="page-shell pb-14 pt-16 sm:pt-24">
          <h1 className="font-display text-display-1 max-w-[16ch]">Free to use. £6 a month to take it everywhere.</h1>
          <p className="lede mt-8">
            Anvil Desktop is free and open source. You only pay if you want us to host Sync &amp; Mesh,
            so your work follows you from one machine to the next.
          </p>
          <p className="mt-8 inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-accent/40 bg-accent/[0.07] px-4 py-3 text-[0.9375rem]">
            <span className="font-semibold">Hosted Sync &amp; Mesh is invite-only.</span>
            <span className="text-muted-foreground">Planned launch prices below. Invited beta testers receive a code to redeem without a payment method.</span>
            <Link href="/waitlist" className="font-medium underline decoration-accent/50 underline-offset-4 hover:decoration-foreground">
              Join the waitlist
            </Link>
          </p>
          <p className="mt-3 text-sm text-muted-foreground">Already invited? <Link href="/account/billing" className="underline underline-offset-4">Redeem your beta code</Link>.</p>
        </section>

        <section className="page-shell pb-20 lg:pb-28" aria-label="Plans">
          <div className="grid overflow-hidden rounded-2xl border bg-card md:grid-cols-2 xl:grid-cols-4">
            {plans.map((plan, index) => (
              <article
                key={plan.id}
                className={cn(
                  "relative flex flex-col p-7 sm:p-8",
                  index > 0 && "border-t md:border-t-0",
                  index % 2 === 1 && "md:border-l",
                  index >= 2 && "md:border-t xl:border-t-0",
                  index === 2 && "xl:border-l",
                  index === 3 && "xl:border-l",
                  plan.featured && "bg-[color-mix(in_oklch,oklch(var(--accent))_6%,oklch(var(--card)))]"
                )}
                aria-labelledby={`plan-${plan.id}`}
              >
                {plan.featured ? <span className="absolute inset-x-0 top-0 h-1 bg-accent" aria-hidden="true" /> : null}
                <h2 id={`plan-${plan.id}`} className="text-lg font-semibold">
                  {plan.name}
                </h2>
                <p className="mt-1 text-[0.9375rem] text-muted-foreground">{plan.summary}</p>
                <p className="mt-7 flex flex-wrap items-baseline gap-x-2">
                  <span className="font-display text-[2.75rem] leading-none">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{plan.cadence}</span>
                </p>
                <p className="mt-2 h-5 text-sm text-muted-foreground">{plan.annual ?? ""}</p>
                <ul className="mt-7 grid flex-1 content-start gap-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-3 text-[0.9375rem] leading-6">
                      <Check className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                </ul>
                {plan.note ? <p className="mt-6 text-sm leading-6 text-muted-foreground">{plan.note}</p> : null}
                <Button asChild className="mt-9 w-full" variant={plan.featured ? "default" : "outline"}>
                  <Link href={plan.cta.href}>{plan.cta.label}</Link>
                </Button>
              </article>
            ))}
          </div>
          <p className="mt-5 text-sm text-muted-foreground">
            Prices are in pounds sterling. If they change before launch, this page changes first.
          </p>
        </section>

        <section id="hosted-compute" className="scroll-mt-24 border-t bg-muted/40 py-20 lg:py-24" aria-labelledby="compute-title">
          <div className="page-shell grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <h2 id="compute-title" className="font-display text-display-2 max-w-[12ch]">
              Machines we run for you, later.
            </h2>
            <div className="grid max-w-[60ch] gap-5 text-lg leading-8 text-muted-foreground">
              <p>
                We&apos;re building Anvil Cloud Agents: hosted machines your workflows can borrow, billed
                by what you use. It isn&apos;t available yet, and it doesn&apos;t have a price.
              </p>
              <p>
                When you use your own model or cloud account, that provider bills you directly.
                Anvil doesn&apos;t add anything on top. You can keep using those accounts without
                waiting for hosted agents.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t py-20 lg:py-28" aria-labelledby="faq-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <h2 id="faq-title" className="font-display text-display-2 max-w-[10ch]">
              Questions people ask.
            </h2>
            <dl className="divide-y border-y">
              {pricingFaqs.map((item) => (
                <div key={item.q} className="grid gap-2 py-6 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-10">
                  <dt className="text-lg font-semibold">{item.q}</dt>
                  <dd className="text-[0.9375rem] leading-7 text-muted-foreground">{item.a}</dd>
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
