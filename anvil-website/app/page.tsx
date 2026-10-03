import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Download,
  Github,
  KeyRound,
  Radio,
  RefreshCcw,
  Server
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MeshSchematic } from "@/components/site/mesh-schematic";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { TerminalPanel } from "@/components/site/terminal-panel";
import {
  docsHighlights,
  githubRepositoryUrl,
  hostedUpsell,
  latestDesktopDmgUrl,
  productLines,
  syncLayer,
  syncModes,
  syncMoves
} from "@/lib/site";

const moveIcons = [KeyRound, Radio, RefreshCcw] as const;

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="home" />
      <main id="main-content">
        <HeroSection />
        <DesktopSection />
        <SyncLayerSection />
        <StackSection />
        <DocsSection />
        <ClosingSection />
      </main>
      <SiteFooter />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="overflow-hidden border-b">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:px-8 lg:py-24">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-5">
            <h1 className="max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.03em] text-foreground sm:text-6xl lg:text-[4.4rem]">
              Run agent work where your code lives.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
              Anvil Desktop is an open-source workspace for agent work on your own
              repos. Plan, run, review, and keep checks with the work in one local app. Add
              Sync &amp; Mesh when you need a second machine to pick up the work.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button asChild size="lg">
              <Link href={latestDesktopDmgUrl}>
                <Download data-icon="inline-start" aria-hidden="true" />
                Download for macOS
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/sync">
                See Sync &amp; Mesh
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Link
              className="inline-flex min-h-11 items-center gap-2 px-2 text-sm font-medium text-muted-foreground hover:text-foreground"
              href={githubRepositoryUrl}
            >
              <Github className="size-4" aria-hidden="true" />
              anvil-stack on GitHub
            </Link>
          </div>
          <Link
            href="/sync"
            className="group flex w-fit items-center gap-2 rounded-md font-mono text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="inline-block size-1.5 rounded-full bg-accent" aria-hidden="true" />
            Optional account layer · sealed sync, mesh jobs, session handoff
            <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
          </Link>
        </div>
        <MeshSchematic className="min-w-0" />
      </div>
    </section>
  );
}

function SyncLayerSection() {
  return (
    <section className="border-b bg-muted/20" aria-labelledby="sync-layer-title">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
        <div className="grid gap-10 lg:grid-cols-[0.62fr_1.38fr]">
          <div>
            <h2 id="sync-layer-title" className="max-w-md text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
              Add another machine without copying your workspace by hand.
            </h2>
            <p className="mt-4 max-w-md text-base leading-7 text-muted-foreground">
              {syncLayer.description}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button asChild>
                <Link href={syncLayer.detailHref}>
                  How Sync &amp; Mesh works
                  <ArrowRight data-icon="inline-end" aria-hidden="true" />
                </Link>
              </Button>
              <Link
                href={syncLayer.docsHref}
                className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Read the docs
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div className="grid gap-8">
            <ol className="grid gap-x-8 gap-y-6 sm:grid-cols-3">
              {syncMoves.map((move, index) => {
                const Icon = moveIcons[index] ?? KeyRound;
                return (
                  <li key={move.title} className="border-t pt-5">
                    <div className="flex items-center gap-2.5">
                      <Icon className="size-4 text-accent" aria-hidden="true" />
                      <h3 className="font-semibold">{move.title}</h3>
                    </div>
                    <p className="mt-2.5 text-sm leading-6 text-muted-foreground">{move.body}</p>
                    <p className="mt-3 font-mono text-[0.6875rem] tracking-wide text-muted-foreground">
                      {move.proof}
                    </p>
                  </li>
                );
              })}
            </ol>

            <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
              <div className="overflow-hidden rounded-lg border bg-background">
                <div className="border-b px-5 py-3.5">
                  <h3 className="text-sm font-semibold">Pick the backend, keep the keys</h3>
                </div>
                <ul className="divide-y">
                  {syncModes.map((mode) => (
                    <li key={mode.mode} className="grid gap-1.5 px-5 py-4 sm:grid-cols-[9.5rem_1fr] sm:gap-x-4">
                      <p className="font-medium">{mode.mode}</p>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="text-sm leading-6 text-muted-foreground">{mode.body}</p>
                        <p className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{mode.cost}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>

              <aside className="flex flex-col rounded-lg border bg-background p-5">
                <div className="flex items-center gap-2.5">
                  <Server className="size-4 text-accent" aria-hidden="true" />
                  <h3 className="font-semibold">{hostedUpsell.title}</h3>
                </div>
                <p className="mt-3 flex-1 text-sm leading-6 text-muted-foreground">{hostedUpsell.body}</p>
                <div className="mt-5">
                  <Button asChild variant="outline" size="sm">
                    <Link href={hostedUpsell.href}>
                      {hostedUpsell.cta}
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DesktopSection() {
  const [desktop] = productLines;

  return (
    <section id="products" className="border-b py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          title="From checkout to handoff, in one workspace."
          description="Open a repo, give the agent the context it needs, inspect the change, and hand off a result with the checks attached. Anvil Desktop runs locally on macOS."
        />
        <div className="mt-10">
          {desktop ? <ProductFeature product={desktop} /> : null}
        </div>
      </div>
    </section>
  );
}

function StackSection() {
  const [, registry, cloud, nodeBase] = productLines;
  const companions = [cloud, registry, nodeBase].filter(Boolean);
  const summaries: Record<string, string> = {
    cloud: "Build provider-neutral Cells and Agents, inspect them locally, and deploy through the CLI.",
    registry: "Put deterministic policy and reviewable analysis in front of npm installs.",
    "node-base": "Run Node installs in a controlled container, either with scripts disabled or observed."
  };

  return (
    <section className="border-b py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          title="Add only what the job needs."
          description="These projects are optional. Each one owns a separate problem and comes with its own docs and repository."
        />
        <div className="mt-10 grid gap-5 md:grid-cols-3">
          {companions.map((product) => (
            <StackCard
              key={product.id}
              product={product}
              summary={summaries[product.id] ?? product.description}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductFeature({ product }: { product: (typeof productLines)[number] }) {
  const desktopTasks = [
    { title: "Start with a repo", body: "Index local checkouts, branch state, and architecture context before the first prompt." },
    { title: "Run the work", body: "Plan, implement, investigate, or review in a chat-first workspace with terminals attached." },
    { title: "Inspect the change", body: "Use Git state, tests, security checks, and review criteria before accepting the result." },
    { title: "Hand it over", body: "Keep decisions, checks, and unresolved risk with the work so the next person can pick it up." }
  ];

  return (
    <article className="overflow-hidden rounded-lg border bg-card lg:grid lg:grid-cols-[1.08fr_0.92fr]">
      <div className="grid gap-7 p-6 sm:p-8">
        <ProductHeading product={product} />
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">
          A local workspace for repo-aware agent delivery. The app keeps the conversation,
          checkout, terminal, review, and handoff in the same place while active work continues.
        </p>
        <ol className="grid gap-4 border-y py-5 sm:grid-cols-2">
          {desktopTasks.map((task, index) => (
            <li key={task.title} className="flex items-start gap-3">
              <span className="font-mono text-xs text-muted-foreground">0{index + 1}</span>
              <div>
                <h4 className="font-medium">{task.title}</h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{task.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={latestDesktopDmgUrl}>
              <Download data-icon="inline-start" aria-hidden="true" />
              Download Desktop
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={product.href}>
              Read the Desktop docs
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={product.repoHref}>Browse source</Link>
          </Button>
        </div>
      </div>
      <div className="relative aspect-[16/10] border-t bg-muted lg:aspect-auto lg:border-l lg:border-t-0">
        <Image
          src={product.image}
          alt={product.imageAlt}
          fill
          priority
          className="object-cover object-top"
          sizes="(min-width: 1024px) 560px, 100vw"
        />
      </div>
    </article>
  );
}

function StackCard({
  product,
  summary
}: {
  product: (typeof productLines)[number];
  summary: string;
}) {
  return (
    <article className="flex flex-col rounded-lg border bg-card p-5">
      <div className="flex items-start gap-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-background">
          <product.icon className="size-5 text-accent" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-lg font-semibold tracking-[-0.015em]">{product.title}</h3>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{product.repoName}</p>
        </div>
      </div>
      <p className="mt-4 flex-1 text-sm leading-6 text-muted-foreground">{summary}</p>
      <div className="mt-4 rounded-md border bg-muted/45 px-3 py-3 font-mono text-xs text-muted-foreground">{product.command}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={product.href}>
            Docs
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href={product.repoHref}>Repository</Link>
        </Button>
      </div>
    </article>
  );
}

function ProductHeading({ product }: { product: (typeof productLines)[number] }) {
  return (
    <div className="flex items-start gap-4">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-md border bg-background">
        <product.icon className="size-5 text-accent" aria-hidden="true" />
      </span>
      <div>
        <h3 className="text-2xl font-semibold tracking-[-0.015em]">{product.title}</h3>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{product.repoName}</p>
      </div>
    </div>
  );
}


function DocsSection() {
  const homepageDocs = docsHighlights.filter((doc) =>
    [
      "Start here",
      "Desktop agent workflows",
      "Sync & Mesh overview",
      "Mesh jobs",
      "Desktop architecture",
      "Monorepo map"
    ].includes(doc.label)
  );

  return (
    <section className="border-b py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <SectionHeading
            title="Read the path that matches the work."
            description="Start with Desktop, Sync & Mesh, or the companion tools. Commands, architecture, limits, and repository ownership live in the docs."
          />
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link href={githubRepositoryUrl}>
                <Github data-icon="inline-start" aria-hidden="true" />
                anvil-stack on GitHub
              </Link>
            </Button>
          </div>
        </div>
        <div className="mt-8 grid gap-x-10 sm:grid-cols-2">
          {homepageDocs.map((doc) => (
            <Link
              key={doc.href}
              href={doc.href}
              className="group flex items-start gap-4 rounded-sm border-t py-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <doc.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <h3 className="flex items-center gap-1.5 font-medium">
                  {doc.label}
                  <ArrowRight
                    className="size-3.5 -translate-x-1 text-muted-foreground opacity-0 transition-[opacity,transform] duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{doc.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function ClosingSection() {
  return (
    <section className="py-16 lg:py-20">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:px-8">
        <div>
          <h2 className="max-w-xl text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">
            Start local. Add the cloud path later.
          </h2>
          <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
            Download Anvil Desktop for macOS, then decide whether a second machine, a
            self-deployed backend, or a cloud agent environment belongs in the workflow.
            You can use Desktop without an account.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link href={latestDesktopDmgUrl}>
                <Download data-icon="inline-start" aria-hidden="true" />
                Download for macOS
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/docs">
                Read the docs
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
        <TerminalPanel
          title="mesh deploy / your cloudflare account"
          command="anvil-cloud mesh apply --name anvil-sync"
          lines={[
            { text: "plan    wrangler.mesh.jsonc · DO bindings + R2 bucket", tone: "dim" },
            { text: "deploy  worker uploaded · migrations applied (14)", tone: "plain" },
            { text: "secrets provisioned after first deploy", tone: "plain" },
            { text: "ready   admin health check passed", tone: "ok" },
            { text: "next    anvil-cloud mesh connection --name anvil-sync --base-url …", tone: "accent" }
          ]}
        />
      </div>
    </section>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-[-0.02em] text-foreground sm:text-4xl">{title}</h2>
      <p className="mt-3 text-base leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}
