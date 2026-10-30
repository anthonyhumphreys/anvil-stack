import Link from "next/link";
import { ArrowRight, Download, Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProductReel } from "@/components/marketing/product-reel";
import { EnvelopeBoundary } from "@/components/site/envelope-boundary";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import {
  companionProducts,
  desktopProviders,
  docsHighlights,
  featureBeta,
  githubRepositoryUrl,
  latestDesktopDmgUrl,
  releasesUrl
} from "@/lib/site";

type Credit = { role: string; value: string; note?: string; href?: string };

const credits: Credit[] = [
  { role: "Agents", value: `${desktopProviders.join(", ")}.`, note: "Your own accounts. Providers bill you directly." },
  { role: "Review", value: "Diffs, test runs, security and dependency checks beside the thread." },
  { role: "Plans", value: "Work items with acceptance criteria, risks and follow-ups attached." },
  { role: "Automations", value: "Scheduled checks and multi-agent workflows, each in its own working copy." },
  {
    role: "Software factories",
    value: "Labelled GitHub issue to confirmed merge, under a policy you activate.",
    note: `${featureBeta.label}.`,
    href: "/docs/desktop/software-factories"
  },
  { role: "Check-ins", value: "Approve a step or reply from iPhone, Apple Watch, Raycast or the menu bar." },
  { role: "Price", value: "Free and MIT licensed. No Mezair account for local work." }
];

const docPicks = [
  "/docs/overview",
  "/docs/desktop/installation",
  "/docs/desktop/agent-workflows",
  "/docs/sync/encryption",
  "/docs/project/repositories"
];

export default function HomePage() {
  const docs = docsHighlights.filter((doc) => docPicks.includes(doc.href));

  return (
    <div className="cine min-h-screen">
      <SiteHeader active="home" showThemeToggle={false} />
      <main id="main-content">
        <section className="cine-hero cine-lit" aria-labelledby="hero-title">
          <div className="cine-wide">
            <div className="cine-titlerow">
              <h1 id="hero-title" className="cine-title">
                Put your agents in motion.
              </h1>
              <div>
                <p className="cine-lede md:max-w-[60ch] lg:max-w-[46ch]">
                  Mezair (may-ZAIR): your agents, your repos, one free desktop app.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button asChild size="lg">
                    <Link href={latestDesktopDmgUrl}>
                      <Download aria-hidden="true" />
                      Download for Mac
                    </Link>
                  </Button>
                  <Button asChild size="lg" variant="outline">
                    <Link href={githubRepositoryUrl}>
                      <Github aria-hidden="true" />
                      Source
                    </Link>
                  </Button>
                </div>
                <p className="cine-fine mt-4">
                  Unsigned Mac build.{" "}
                  <Link href="/docs/desktop/installation" className="cine-link">
                    Install guide
                  </Link>{" · "}
                  <Link href={releasesUrl} className="cine-link">
                    Windows &amp; Linux
                  </Link>
                </p>
              </div>
            </div>
            <div className="cine-stage">
              <ProductReel />
            </div>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="credits-title">
          <div className="page-shell">
            <h2 id="credits-title" className="cine-h2 mx-auto max-w-[16ch] text-center">
              Everything around the prompt.
            </h2>
            <dl className="credits mx-auto max-w-[58rem]">
              {credits.map((item) => (
                <div key={item.role}>
                  <dt>{item.role}</dt>
                  <dd>
                    {item.href ? (
                      <Link href={item.href} className="cine-link">
                        {item.value}
                      </Link>
                    ) : (
                      item.value
                    )}
                    {item.note ? <small>{item.note}</small> : null}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-10 text-center">
              <Link href="/docs/desktop" className="cine-link inline-flex min-h-11 items-center gap-2">
                Everything Desktop can do
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </p>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="sync-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
            <div>
              <h2 id="sync-title" className="cine-h2 max-w-[13ch]">
                Pick up where you left off.
              </h2>
              <p className="cine-lede mt-5">
                Sync &amp; Mesh carries your setup between machines, encrypted on your device, and moves a running
                session when you leave your desk.
              </p>
              <p className="cine-fine mt-4">
                Beta through {featureBeta.endDate}. Hosted Sync is invite-only and planned from £6 a month.
                Self-hosting has no Mezair fee; your host may charge.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild>
                  <Link href="/waitlist">Request hosted beta access</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/sync">How Sync works</Link>
                </Button>
              </div>
              <p className="cine-fine mt-4">
                Invited?{" "}
                <Link href="/account/billing" className="cine-link">
                  Redeem your beta code
                </Link>{" "}
                without a payment method, or{" "}
                <Link href="/pricing" className="cine-link">
                  see pricing
                </Link>
                .
              </p>
            </div>
            <EnvelopeBoundary className="min-w-0" />
          </div>
        </section>

        <section className="cine-section" aria-labelledby="tools-title">
          <div className="page-shell">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 id="tools-title" className="cine-h2 max-w-[14ch]">
                Tools that stand on their own.
              </h2>
              <p className="cine-fine max-w-[40ch]">Open source and separate from Desktop. None of them need it.</p>
            </div>
            <ul className="rows mt-10">
              {companionProducts.map((product) => (
                <li key={product.id}>
                  <p className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-lg font-semibold">{product.shortTitle}</span>
                    <span className="text-sm text-muted-foreground">{product.statusLabel}</span>
                  </p>
                  <div className="min-w-0">
                    <p>{product.tagline}</p>
                    <code className="mt-2 inline-block max-w-full overflow-x-auto whitespace-nowrap rounded-md border bg-[oklch(var(--artifact-bg))] px-2.5 py-1 font-mono text-[0.8125rem]">
                      {product.command}
                    </code>
                  </div>
                  <p className="flex gap-4 text-sm font-medium">
                    <Link href={product.href} className="cine-link inline-flex min-h-11 items-center">
                      Docs
                    </Link>
                    <Link
                      href={product.repoHref}
                      className="inline-flex min-h-11 items-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Source
                    </Link>
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="oss-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
            <div>
              <h2 id="oss-title" className="cine-h2 max-w-[13ch]">
                Open source, all the way down.
              </h2>
              <p className="cine-lede mt-5">
                The app, the Sync backend, the registry and this site live in one MIT-licensed repo.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild variant="outline">
                  <Link href={githubRepositoryUrl}>
                    <Github aria-hidden="true" />
                    mezair-stack on GitHub
                  </Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/docs/project/contributing">How to contribute</Link>
                </Button>
              </div>
              <ul className="mt-8 grid text-[0.9375rem]">
                {docs.map((doc) => (
                  <li key={doc.href}>
                    <Link href={doc.href} className="cine-link inline-flex min-h-11 items-center">
                      {doc.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href="/docs" className="inline-flex min-h-11 items-center gap-2 font-medium text-muted-foreground transition-colors hover:text-foreground">
                    Browse all docs
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </li>
              </ul>
            </div>
            <figure className="cine-term min-w-0">
              <pre>
                <code>
                  <span className="text-[oklch(var(--artifact-dim))]"># clone the monorepo</span>
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> git clone {githubRepositoryUrl}
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> cd mezair-stack
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> node .github/scripts/prepare-desktop-clis.mjs
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> cd mezair-app
                  {"\n\n"}
                  <span className="text-[oklch(var(--artifact-dim))]"># each project installs on its own</span>
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> pnpm install
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> pnpm dev
                </code>
              </pre>
              <figcaption className="sr-only">
                Commands to clone the mezair-stack repository and start Mezair Desktop in development mode.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="close-title">
          <div className="page-shell">
            <h2 id="close-title" className="cine-title max-w-[16ch]">
              Try it on a repo you know well.
            </h2>
            <p className="cine-lede mt-6">
              No Mezair account needed for local work. Connect your own agent account when you&apos;re ready.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href={latestDesktopDmgUrl}>
                  <Download aria-hidden="true" />
                  Download for Mac
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="/docs/desktop/installation">Read the install guide</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
