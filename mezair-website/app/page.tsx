import Link from "next/link";
import {
  ArrowRight,
  Bell,
  ClipboardList,
  Download,
  Factory,
  Github,
  KeyRound,
  ShieldCheck,
  Smartphone,
  Workflow
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MeshSchematic } from "@/components/site/mesh-schematic";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { Workbench } from "@/components/site/workbench";
import {
  companionProducts,
  desktopProviders,
  docsHighlights,
  featureBeta,
  githubRepositoryUrl,
  latestDesktopDmgUrl,
  releasesUrl
} from "@/lib/site";

type Capability = {
  icon: typeof Bell;
  title: string;
  body: string;
  status?: string;
  href?: string;
};

const capabilities: Capability[] = [
  {
    icon: Bell,
    title: "Work keeps running",
    body: "Threads and terminals carry on while you switch workspaces. A notification takes you straight to whichever one needs you."
  },
  {
    icon: ShieldCheck,
    title: "Review is built in",
    body: "Diffs, test runs, security and dependency checks sit next to the conversation that produced them."
  },
  {
    icon: ClipboardList,
    title: "Plans you can follow",
    body: "Break a job into work items with acceptance criteria, and keep the risks and follow-ups attached to them."
  },
  {
    icon: Workflow,
    title: "Automations",
    body: "Schedule recurring checks and multi-agent workflows. Each run uses a separate working copy of your repo."
  },
  {
    icon: Factory,
    title: "User-definable software factories",
    body: "Describe an issue-to-PR process in chat, review the typed definition, then activate it. Labelled GitHub issues run through checks, CI and review repair to a confirmed merge, with human-approved or standing automatic merge.",
    status: featureBeta.label,
    href: "/docs/desktop/software-factories"
  },
  {
    icon: KeyRound,
    title: "Your agents, your accounts",
    body: "Use the Codex, Cursor or Devin subscription you already have, or your own OpenAI or Azure keys."
  },
  {
    icon: Smartphone,
    title: "Check in from anywhere",
    body: "Approve a step or send a reply from your iPhone, Apple Watch, Raycast or the menu bar."
  }
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="home" />
      <main id="main-content">
        <Hero />
        <Workbench />
        <Capabilities />
        <SyncBand />
        <CompanionTools />
        <OpenSource />
        <DocsPaths />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  return (
    <section className="page-shell pb-16 pt-16 sm:pt-24 lg:pb-24">
      <h1 className="font-display text-display-1 max-w-[14ch]">A workbench for coding agents.</h1>
      <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
        <div>
          <p className="lede">
            Mezair (may-ZAIR) is a free desktop app for running coding agents on your own repos. Plan the work,
            watch it happen, and check every change before you keep it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href={latestDesktopDmgUrl}>
                <Download aria-hidden="true" />
                Download for Mac
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={githubRepositoryUrl}>
                <Github aria-hidden="true" />
                View the source
              </Link>
            </Button>
          </div>
          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            Want to pick it up on another machine?{" "}
            <Link href="/sync" className="font-medium text-foreground underline decoration-accent/60 underline-offset-4">
              Use Mezair across your machines
            </Link>
            . Use your own server today, or request access to the invite-only hosted beta.
          </p>
          <p className="mt-5 max-w-[56ch] text-sm leading-6 text-muted-foreground">
            Also on{" "}
            <Link href={releasesUrl} className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
              Windows and Linux
            </Link>
            . Mac builds aren&apos;t notarised yet, so the{" "}
            <Link href="/docs/desktop/installation" className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground">
              install guide
            </Link>{" "}
            has one Terminal command to run before the first launch.
          </p>
        </div>
        <dl className="spec-plate" aria-label="Mezair Desktop at a glance">
          <div>
            <dt>Price</dt>
            <dd>Free, MIT licensed</dd>
          </div>
          <div>
            <dt>Agents</dt>
            <dd>{desktopProviders.join(", ")}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>On your machine, against your checkouts</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>Not needed</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Capabilities() {
  return (
    <section className="border-t py-20 lg:py-28" aria-labelledby="capabilities-title">
      <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div>
          <h2 id="capabilities-title" className="font-display text-display-2 max-w-[12ch]">
            More than a chat window.
          </h2>
          <p className="mt-5 max-w-[38ch] text-muted-foreground">
            The parts of a coding job that happen around the prompt live in the same app.
          </p>
          <Link
            href="/docs/desktop"
            className="mt-6 inline-flex min-h-11 items-center gap-2 font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            Everything Desktop can do
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <ul className="grid gap-x-12 gap-y-10 sm:grid-cols-2">
          {capabilities.map((item) => (
            <li key={item.title}>
              <item.icon className="size-5 text-accent" aria-hidden="true" />
              <h3 className="mt-4 text-lg font-semibold">
                {item.href ? (
                  <Link href={item.href} className="underline decoration-border underline-offset-4 hover:decoration-foreground">
                    {item.title}
                  </Link>
                ) : (
                  item.title
                )}
              </h3>
              {item.status ? <p className="mt-1 text-sm font-medium text-muted-foreground">{item.status}</p> : null}
              <p className="mt-2 text-[0.9375rem] leading-7 text-muted-foreground">{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SyncBand() {
  return (
    <section className="border-t bg-muted/40 py-20 lg:py-28" aria-labelledby="sync-title">
      <div className="page-shell grid gap-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
        <div>
          <h2 id="sync-title" className="font-display text-display-2 max-w-[14ch]">
            Pick up where you left off.
          </h2>
          <p className="mt-5 max-w-[46ch] text-lg leading-8 text-muted-foreground">
            Sync &amp; Mesh keeps your workspaces, templates and agents in step across your machines.
            Send a long job to the machine under your desk, or move a running session to your laptop
            when you head out.
          </p>
          <ul className="mt-7 grid gap-3 text-[0.9375rem] leading-7">
            <li className="flex gap-3">
              <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
              Your synced setup is encrypted before it leaves your device.
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
              Workspace Sync excludes repository files, provider credentials and chat history.
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
              <span>
                <Link href="/docs/sync/lan-first-routes" className="font-medium underline decoration-border underline-offset-4 hover:decoration-foreground">
                  LAN-first Mesh
                </Link>{" "}
                (beta through {featureBeta.endDate}) tries the host&apos;s LAN address first, then other
                private routes, HTTPS and managed ingress. Your backend still admits and authorises
                every session.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
              Planned Mezair hosting starts at £6 a month. Self-hosting has no Mezair fee; your hosting provider may charge.
            </li>
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/waitlist">Request hosted beta access</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">See pricing</Link>
            </Button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Invited testers receive a beta code. <Link href="/account/billing" className="underline underline-offset-4">Redeem yours</Link> without a payment method.
          </p>
        </div>
        <MeshSchematic className="min-w-0" />
      </div>
    </section>
  );
}

function CompanionTools() {
  return (
    <section className="border-t py-20 lg:py-28" aria-labelledby="companion-tools-title">
      <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div>
          <h2 id="companion-tools-title" className="font-display text-display-2 max-w-[11ch]">
            Tools you can use on their own.
          </h2>
          <p className="mt-5 max-w-[38ch] text-muted-foreground">
            Separate open-source tools for the jobs around agent work. Use any of them on their own;
            none of them need Desktop.
          </p>
        </div>
        <ul className="divide-y border-y">
          {companionProducts.map((product) => (
            <li key={product.id} className="grid gap-4 py-8 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-10">
              <div>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-xl font-semibold">{product.title}</h3>
                  <span className="text-sm text-muted-foreground">{product.statusLabel}</span>
                </div>
                <p className="mt-1 font-medium">{product.tagline}</p>
                <p className="mt-2 max-w-[60ch] text-[0.9375rem] leading-7 text-muted-foreground">
                  {product.description}
                </p>
                <code className="mt-4 inline-block max-w-full overflow-x-auto rounded-md border bg-muted/60 px-2.5 py-1.5 font-mono text-[0.8125rem]">
                  {product.command}
                </code>
              </div>
              <div className="flex gap-4 text-sm font-medium sm:flex-col sm:items-end sm:pt-1">
                <Link href={product.href} className="underline decoration-border underline-offset-4 hover:decoration-foreground">
                  Docs
                </Link>
                <Link href={product.repoHref} className="text-muted-foreground hover:text-foreground">
                  Source
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function OpenSource() {
  return (
    <section className="border-t py-20 lg:py-28" aria-labelledby="oss-title">
      <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
        <div>
          <h2 id="oss-title" className="font-display text-display-2 max-w-[13ch]">
            Open source, all the way down.
          </h2>
          <p className="mt-5 max-w-[44ch] text-lg leading-8 text-muted-foreground">
            The app, the sync backend, the registry and this website live in one MIT-licensed
            repo. Read how it works, run it from source, or send a fix.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
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
        </div>
        <figure className="artifact-panel">
          <div className="artifact-window-bar" aria-hidden="true">
            <span className="dot dot--accent" />
            <span className="dot" />
            <span className="dot" />
            <span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--artifact-dim))]">Run Mezair from source</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[0.8125rem] leading-7 sm:p-6">
            <code>
              <span className="text-[oklch(var(--artifact-dim))]"># clone the monorepo</span>
              {"\n"}
              <span className="text-[oklch(var(--artifact-accent))]">$</span> git clone {githubRepositoryUrl}
              {"\n"}
              <span className="text-[oklch(var(--artifact-accent))]">$</span> cd mezair-stack/mezair-app
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
  );
}

function DocsPaths() {
  return (
    <section className="border-t py-20 lg:py-28" aria-labelledby="docs-title">
      <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div>
          <h2 id="docs-title" className="font-display text-display-2 max-w-[10ch]">
            Find your way in.
          </h2>
          <p className="mt-5 max-w-[36ch] text-muted-foreground">
            The docs cover setup, how each part works and what doesn&apos;t work yet.
          </p>
          <Link
            href="/docs"
            className="mt-6 inline-flex min-h-11 items-center gap-2 font-medium underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            Browse all docs
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <ul className="grid gap-x-10 sm:grid-cols-2">
          {docsHighlights.map((doc) => (
            <li key={doc.href} className="border-t">
              <Link
                href={doc.href}
                className="group flex items-start gap-4 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <doc.icon className="mt-1 size-4 shrink-0 text-accent" aria-hidden="true" />
                <span>
                  <span className="block font-semibold group-hover:underline group-hover:decoration-border group-hover:underline-offset-4">
                    {doc.label}
                  </span>
                  <span className="mt-1 block text-[0.9375rem] leading-6 text-muted-foreground">{doc.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="border-t py-24 lg:py-32">
      <div className="page-shell">
        <h2 className="font-display text-display-1 max-w-[16ch]">Try it on a repo you know well.</h2>
        <p className="lede mt-6">
          Download the free app, add a local repository, and try a small task. No Mezair account is
          needed for local work. Connect your own coding-agent account when you are ready.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
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
  );
}
