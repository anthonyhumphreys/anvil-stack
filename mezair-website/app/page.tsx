import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowRight, Download, Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MeshStage } from "@/components/marketing/mesh-stage";
import { ProductReel } from "@/components/marketing/product-reel";
import { UseCases, type UseCase } from "@/components/marketing/use-cases";
import { AnimatedMark } from "@/components/site/animated-mark";
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

const useCases: UseCase[] = [
  {
    id: "bug",
    title: "Fix a bug while you work on something else",
    body: "Describe the bug in the thread. In this example the agent wrote a failing test, changed one line in src/lib/retry.ts and ran the full suite. Each step stays in the thread.",
    shot: "desktop-run-steps",
    detail: "pnpm test -- retry",
    link: { label: "Agent workflows", href: "/docs/desktop/agent-workflows" }
  },
  {
    id: "review",
    title: "Review your changes before you commit",
    body: "Ask for a review of your uncommitted changes. The review appears in the thread, explains the change section by section and lists findings by severity. You can send any finding back to the agent.",
    shot: "surface-review",
    detail: "Review my uncommitted changes.",
    link: { label: "Change review", href: "/docs/desktop/change-review" }
  },
  {
    id: "audit",
    title: "Audit a repository you're new to",
    body: "A security audit lists each finding with its file and line. A dependency check lists advisories, licence problems and deprecated packages. You can send the findings you want fixed back to the agent.",
    shot: "surface-findings",
    detail: "Run a security audit of this repo.",
    link: { label: "Security and review", href: "/docs/desktop/security-and-review" }
  },
  {
    id: "ci",
    title: "Find out why CI is slow",
    body: "The agent reads your workflow files and draws the pipeline as a graph. In this example it marks the failing test job and an install step that skips the cache.",
    shot: "surface-pipeline",
    detail: "Why is CI slow?",
    link: { label: "Assurance tools", href: "/docs/desktop/assurance-tools" }
  },
  {
    id: "factory",
    title: "Turn labelled issues into merged pull requests",
    body: "A software factory picks up GitHub issues that carry your label and runs each one through the steps you define. It stops for approval where your policy requires it and confirms the merge at the end.",
    shot: "factories-line",
    status: featureBeta.label,
    link: { label: "Software factories", href: "/docs/desktop/software-factories" }
  },
  {
    id: "mesh",
    title: "Run a job on another of your machines",
    body: "Send a job to your desktop or a Linux server. That machine checks out the commit you chose, runs the agent with its own logins and streams the output back to you.",
    shot: "mesh-jobs",
    fit: "panel",
    detail: "start-session → studio-mac",
    link: { label: "Mesh jobs", href: "/docs/sync/mesh-jobs" }
  }
];

type Credit = { role: string; value: string; note?: string; href?: string };

const credits: Credit[] = [
  { role: "Agents", value: `${desktopProviders.join(", ")}.`, note: "Your own accounts. Providers bill you directly." },
  {
    role: "Git",
    value: "Commit, open a pull request or undo a turn from the thread.",
    note: "Workflows, delegated helpers, factories and Mesh jobs each work in their own worktree."
  },
  { role: "Review", value: "Diffs, test results and security, dependency and pipeline checks appear in the thread." },
  { role: "Plans", value: "Work items with acceptance criteria, risks and follow-ups attached." },
  { role: "Automations", value: "Scheduled checks and multi-agent workflows, each in its own working copy." },
  {
    role: "Software factories",
    value: "Labelled GitHub issue to confirmed merge, under a policy you activate.",
    note: `${featureBeta.label}.`,
    href: "/docs/desktop/software-factories"
  },
  { role: "Companions", value: "Approve a step or reply from iPhone, Apple Watch, Raycast or the menu bar." },
  { role: "Price", value: "Free and MIT licensed. No Mezair account for local work." }
];

const keys: Array<{ label: string; keys: string[] }> = [
  { label: "Command palette", keys: ["⌘", "K"] },
  { label: "New chat thread", keys: ["⌘", "⇧", "N"] },
  { label: "Toggle terminal", keys: ["⌘", "`"] },
  { label: "Guide a running agent", keys: ["⌘", "↵"] },
  { label: "Commands in the composer", keys: ["/"] },
  { label: "Skills in the composer", keys: ["$"] }
];

const dx: Array<{ title: string; body: string }> = [
  {
    title: "Agent tools",
    body: "Mezair runs a local MCP server for each agent session. Agents use it to ask you questions and to post reviews, findings and diagrams in the thread."
  },
  {
    title: "No account",
    body: "Mezair stores repositories, threads and settings in a local SQLite database. Crash reporting is off by default."
  },
  {
    title: "Custom shortcuts",
    body: "You can change any global shortcut in Settings. On Windows and Linux, Ctrl replaces ⌘."
  },
  {
    title: "Source code",
    body: "The Electron app, the Sync backend, the registry and this website are in one MIT-licensed repository. A preview mode renders the app's screens with sample data and no agent account."
  }
];

const docPicks = ["/docs/overview", "/docs/desktop/installation", "/docs/desktop/agent-workflows", "/docs/sync/encryption", "/docs/project/repositories"];

const fade = (ms: number) => ({ "--fade-delay": `${ms}ms` }) as CSSProperties;

export default function HomePage() {
  const docs = docsHighlights.filter((doc) => docPicks.includes(doc.href));

  return (
    <div className="cine min-h-screen">
      <SiteHeader active="home" showThemeToggle={false} />
      <main id="main-content">
        <section className="cine-hero cine-lit" aria-labelledby="hero-title">
          <div className="cine-wide">
            <div className="mx-auto flex max-w-[56rem] flex-col items-center text-center">
              <AnimatedMark className="hero-mark text-foreground" />
              <h1 id="hero-title" className="cine-title cine-fade mt-6 max-w-[14ch]" style={fade(250)}>
                Put your agents in motion.
              </h1>
              <p className="cine-lede cine-fade mt-5 max-w-[52ch]" style={fade(420)}>
                Mezair is a free, open-source desktop app that runs Codex, Cursor, Devin and other coding agents on
                your own repositories. It shows each command and edit as the agent works.
              </p>
              <div className="cine-fade mt-7 flex flex-wrap justify-center gap-3" style={fade(560)}>
                <Button asChild size="lg">
                  <Link href={latestDesktopDmgUrl}>
                    <Download aria-hidden="true" />
                    Download for Mac
                  </Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link href={githubRepositoryUrl}>
                    <Github aria-hidden="true" />
                    View source
                  </Link>
                </Button>
              </div>
              <p className="cine-fine cine-fade mt-4" style={fade(640)}>
                The Mac build is unsigned, so follow the{" "}
                <Link href="/docs/desktop/installation" className="cine-link">
                  install guide
                </Link>
                . Builds for{" "}
                <Link href={releasesUrl} className="cine-link">
                  Windows and Linux
                </Link>{" "}
                are on GitHub. Mezair is{" "}
                <Link href="/what-does-mezair-mean" className="cine-link">
                  pronounced may-ZAIR
                </Link>
                .
              </p>
            </div>
            <div className="cine-stage">
              <ProductReel />
            </div>
          </div>
        </section>

        <section className="py-10" aria-label="Agent providers">
          <div className="page-shell">
            <p className="text-center text-sm text-muted-foreground">Uses your own account with any of these providers</p>
            <ul className="providers mt-4">
              {desktopProviders.map((provider) => (
                <li key={provider}>{provider}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="uses-title">
          <div className="page-shell">
            <h2 id="uses-title" className="cine-h2 max-w-[17ch]">
              What you can ask it to do
            </h2>
            <p className="cine-lede mt-4">
              These screenshots come from the app, running against a sample workspace called Acme.
            </p>
            <div className="mt-12 lg:mt-4">
              <UseCases items={useCases} />
            </div>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="sync-title">
          <div className="cine-wide">
            <div className="cine-titlerow">
              <h2 id="sync-title" className="cine-h2 max-w-[13ch]">
                Use Mezair on more than one machine
              </h2>
              <div>
                <p className="cine-lede">
                  Sync copies your workspace setup to your other machines and encrypts it on your device before upload.
                  Mesh sends jobs to those machines and can move a running session from one to another.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button asChild>
                    <Link href="/sync">How Sync &amp; Mesh work</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/docs/sync/self-deploy">Run your own backend</Link>
                  </Button>
                </div>
                <p className="cine-fine mt-4">
                  Beta through {featureBeta.endDate}. Hosted Sync is invite-only and planned from £6 a month. Self-hosting
                  has no Mezair fee; your host may charge.
                </p>
              </div>
            </div>
            <div className="cine-stage">
              <MeshStage compact />
            </div>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="credits-title">
          <div className="page-shell">
            <h2 id="credits-title" className="cine-h2 mx-auto max-w-[16ch] text-center">
              What else is in the app
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
              <Link href="/docs/desktop/feature-directory" className="cine-link inline-flex min-h-11 items-center gap-2">
                Full Desktop feature list
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </p>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="dx-title">
          <div className="page-shell grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:items-start">
            <div>
              <h2 id="dx-title" className="cine-h2 max-w-[15ch]">
                Keyboard shortcuts and developer tools
              </h2>
              <p className="cine-lede mt-5">
                Mezair works alongside your editor and Git. It opens repositories in VS Code and has a built-in
                terminal for each workspace.
              </p>
              <dl className="mt-10 grid gap-x-10 gap-y-7 sm:grid-cols-2">
                {dx.map((item) => (
                  <div key={item.title}>
                    <dt className="font-semibold">{item.title}</dt>
                    <dd className="mt-1.5 text-[0.9375rem] leading-relaxed text-muted-foreground">{item.body}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-9">
                <Link href="/docs/desktop/keyboard-shortcuts" className="cine-link inline-flex min-h-11 items-center gap-2">
                  Shortcuts and composer reference
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </p>
            </div>
            <figure className="keys">
              <figcaption className="keys-head">
                <span>Keyboard</span>
                <span>macOS shortcuts. You can change them.</span>
              </figcaption>
              <dl>
                {keys.map((item) => (
                  <div key={item.label}>
                    <dt>{item.label}</dt>
                    <dd>
                      {item.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </figure>
          </div>
        </section>

        <section className="cine-section" aria-labelledby="tools-title">
          <div className="page-shell">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 id="tools-title" className="cine-h2 max-w-[14ch]">
                Other Mezair tools
              </h2>
              <p className="cine-fine max-w-[40ch]">Each one is open source and works without Desktop.</p>
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
                The source is on GitHub
              </h2>
              <p className="cine-lede mt-5">
                The app, the Sync backend, the registry and this website are in one MIT-licensed repository.
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
                  <Link
                    href="/docs"
                    className="inline-flex min-h-11 items-center gap-2 font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
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
                  {"\n\n"}
                  <span className="text-[oklch(var(--artifact-dim))]"># real components on fixture data, no provider needed</span>
                  {"\n"}
                  <span className="text-[oklch(var(--artifact-accent))]">$</span> pnpm exec vite --config scripts/chat-replay.vite.config.ts
                </code>
              </pre>
              <figcaption className="sr-only">
                Commands to clone the mezair-stack repository, start Mezair Desktop in development mode, and open the
                fixture replay that renders the screens on this site.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="cine-section cine-lit" aria-labelledby="close-title">
          <div className="page-shell">
            <h2 id="close-title" className="cine-title max-w-[16ch]">
              Try it on a repository you know well
            </h2>
            <p className="cine-lede mt-6">
              Local use needs no Mezair account. You connect your agent account before your first task.
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
