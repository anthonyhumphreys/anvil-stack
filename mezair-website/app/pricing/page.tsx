import Link from "next/link";
import type { Metadata } from "next";
import { Check, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { pageMetadata } from "@/lib/metadata";
import { featureBeta, plans, pricingFaqs } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Pricing | Mezair",
  description:
    "The Mezair app is free. Sync & Mesh is free on a backend you run, or £8.99 a month for one person and £12 per member for teams if Mezair hosts it.",
  path: "/pricing"
});

function planPrice(id: (typeof plans)[number]["id"]) {
  const plan = plans.find((item) => item.id === id);
  return plan ? `${plan.price} ${plan.cadence}` : "";
}

const bill = [
  { item: "Mezair Desktop", who: "Nobody. It's free and MIT licensed.", amount: "Free" },
  { item: "Hosted Sync & Mesh", who: "Mezair, once paid signup opens", amount: planPrice("sync") },
  { item: "Hosted Team", who: "Mezair, once paid signup opens", amount: planPrice("team") },
  { item: "Self-hosted Sync backend", who: "Your host, such as Cloudflare", amount: "No Mezair fee" },
  {
    item: "Models and sandboxes",
    who: "Your providers: OpenAI, Azure, AWS, Cloudflare, Vercel and the rest",
    amount: "No Mezair margin"
  },
  { item: "Mezair Cloud Agents", who: "Hosted machines billed by use. Not available yet.", amount: "No price yet" }
];

export default function PricingPage() {
  return (
    <div className="cine min-h-screen">
      <SiteHeader active="pricing" showThemeToggle={false} />
      <main id="main-content">
        <section className="cine-hero cine-lit" aria-labelledby="pricing-title">
          <div className="cine-wide">
            <div className="cine-titlerow">
              <h1 id="pricing-title" className="cine-title max-w-[16ch]">
                The app is free. Hosted Sync is £8.99 a month
              </h1>
              <div>
                <p className="cine-lede md:max-w-[60ch] lg:max-w-[46ch]">
                  Run Sync &amp; Mesh yourself for free, or let us host it for £8.99 a month. Teams are £12 per member.
                </p>
                <p className="cine-fine mt-4">
                  Planned prices. Hosting is invite-only until {featureBeta.endDate}, and testers get a free code.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button asChild size="lg">
                    <Link href="/waitlist">Request beta access</Link>
                  </Button>
                  <Button asChild size="lg" variant="outline">
                    <Link href="/account/billing">Redeem a beta code</Link>
                  </Button>
                </div>
              </div>
            </div>

            <section className="cine-stage cine-rise" aria-label="Plans">
              <div className="plans">
                {plans.map((plan) => (
                  <article
                    key={plan.id}
                    className="plan"
                    data-featured={plan.featured ? "true" : "false"}
                    aria-labelledby={`plan-${plan.id}`}
                  >
                    <h2 id={`plan-${plan.id}`} className="text-lg font-semibold">
                      {plan.name}
                    </h2>
                    <p className="mt-1 text-[0.9375rem] text-muted-foreground">{plan.summary}</p>
                    <p className="plan-price">
                      <strong>{plan.price}</strong>
                      <span className="text-sm text-muted-foreground">{plan.cadence}</span>
                    </p>
                    <p className="mt-2 min-h-5 text-sm text-muted-foreground">{plan.annual ?? ""}</p>
                    <ul className="mt-6 grid flex-1 content-start gap-2.5">
                      {plan.features.map((feature) => (
                        <li key={feature} className="flex gap-3 text-[0.9375rem] leading-6">
                          <Check className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                    {plan.note ? <p className="mt-5 text-sm leading-6 text-muted-foreground">{plan.note}</p> : null}
                    <Button asChild className="mt-8 w-full" variant={plan.featured ? "default" : "outline"}>
                      <Link href={plan.cta.href}>{plan.cta.label}</Link>
                    </Button>
                  </article>
                ))}
              </div>
              <p className="cine-fine mt-5">Prices are in pounds sterling. If they change before launch, this page changes first.</p>
            </section>
          </div>
        </section>

        <section id="hosted-compute" className="cine-section scroll-mt-24" aria-labelledby="bill-title">
          <div className="page-shell">
            <h2 id="bill-title" className="cine-h2 max-w-[14ch]">
              Who bills you for what
            </h2>
            <p className="cine-lede mt-4">You use your own model and cloud accounts, and those providers bill you directly. Mezair adds no margin.</p>
            <dl className="bill mt-10">
              {bill.map((row) => (
                <div key={row.item}>
                  <dt>{row.item}</dt>
                  <dd>{row.who}</dd>
                  <dd>{row.amount}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="faq-title">
          <div className="page-shell grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <h2 id="faq-title" className="cine-h2 max-w-[10ch]">
              Common questions
            </h2>
            <div className="faq">
              {pricingFaqs.map((item) => (
                <details key={item.q}>
                  <summary>
                    {item.q}
                    <Plus className="size-5" aria-hidden="true" />
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
