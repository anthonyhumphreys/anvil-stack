import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
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
  proofPoints,
  repoComparison,
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
        <SyncLayerSection />
        <ProductsSection />
        <ProofSection />
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
              Evidence, everywhere you work.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
              Anvil is a family of open-source developer tools: a desktop app for agent
              workflows on your repos, an npm gateway with deterministic install policy,
              a hardened Node base image, a portable app runtime — and
              Sync&nbsp;&amp;&nbsp;Mesh to keep every machine you own in step.
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
              <Link href="/docs">
                Read the docs
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
            sync-mesh--foundations · sealed sync, mesh jobs, session handoff
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
              One account. Every machine you own, in step.
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

function ProductsSection() {
  const [desktop, registry, cloud, nodeBase] = productLines;

  return (
    <section id="products" className="border-b py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          title="One repo, four tools"
          description="Everything lives in the anvil-stack monorepo, but the split is intentional. Each project owns a boundary you can inspect on its own."
        />
        <div className="mt-10 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          {desktop ? <ProductFeature product={desktop} /> : null}
          <div className="grid gap-5">
            {cloud ? <ProductRow product={cloud} /> : null}
            {registry ? <ProductRow product={registry} /> : null}
            {nodeBase ? <ProductRow product={nodeBase} compact /> : null}
          </div>
        </div>

        <div className="mt-6 grid gap-3">
          {repoComparison.map((item) => (
            <article key={item.repo} className="grid gap-4 rounded-lg border bg-background p-5 md:grid-cols-[13rem_1fr]">
              <div>
                <p className="font-mono text-sm font-semibold text-foreground">{item.repo}</p>
                <p className="mt-1 text-sm text-muted-foreground">{item.product}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <RepoFact label="Owns" value={item.owns} />
                <RepoFact label="Start in" value={item.firstFiles} />
                <RepoFact label="Use when" value={item.usefulWhen} />
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function RepoFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm leading-6 text-foreground">{value}</p>
    </div>
  );
}

function ProductFeature({ product }: { product: (typeof productLines)[number] }) {
  return (
    <article className="overflow-hidden rounded-lg border bg-card">
      <div className="relative aspect-[16/10] border-b bg-muted">
        <Image
          src={product.image}
          alt={product.imageAlt}
          fill
          priority
          className="object-cover"
          sizes="(min-width: 1024px) 680px, 100vw"
        />
      </div>
      <div className="grid gap-7 p-6">
        <ProductHeading product={product} />
        <p className="max-w-2xl text-base leading-7 text-muted-foreground">{product.description}</p>
        <ProductDetails product={product} />
      </div>
    </article>
  );
}

function ProductRow({
  product,
  compact = false
}: {
  product: (typeof productLines)[number];
  compact?: boolean;
}) {
  return (
    <article className="rounded-lg border bg-card p-5">
      <div className="grid gap-5">
        <ProductHeading product={product} />
        <p className="text-sm leading-6 text-muted-foreground">{product.description}</p>
        {compact ? (
          <div className="rounded-md border bg-muted/45 px-3 py-3 font-mono text-xs text-muted-foreground">{product.command}</div>
        ) : (
          <ProductDetails product={product} />
        )}
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

function ProductDetails({ product }: { product: (typeof productLines)[number] }) {
  return (
    <div className="grid gap-5">
      <div className="grid gap-2 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Boundary:</span> {product.boundary}
        </p>
        <p>
          <span className="font-medium text-foreground">Status:</span> {product.status}
        </p>
      </div>
      <ul className="grid gap-2 text-sm text-muted-foreground">
        {product.points.slice(0, 5).map((point) => (
          <li key={point} className="flex items-start gap-2">
            <Check className="proof-check" aria-hidden="true" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <div className="rounded-md border bg-muted/45 px-3 py-3 font-mono text-xs text-muted-foreground">{product.command}</div>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link href={product.href}>
            Docs
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href={product.repoHref}>Repository</Link>
        </Button>
        {"downloadHref" in product && product.downloadHref ? (
          <Button asChild size="sm" variant="outline">
            <Link href={product.downloadHref}>
              <Download data-icon="inline-start" aria-hidden="true" />
              {product.downloadLabel}
            </Link>
          </Button>
        ) : null}
        {product.links.map((link) => (
          <Button key={link.href} asChild size="sm" variant="ghost">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </div>
    </div>
  );
}

function ProofSection() {
  return (
    <section className="border-b bg-muted/20 py-16 lg:py-20">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 sm:px-6 lg:grid-cols-[0.72fr_1.28fr] lg:px-8">
        <SectionHeading
          title="The useful promise is narrow"
          description="Anvil does not claim that agents, heuristics, or abstractions remove engineering judgement. It gives reviewers better artefacts to judge."
        />
        <div className="grid gap-x-10 sm:grid-cols-2">
          {proofPoints.map((item) => (
            <article key={item.title} className="border-t py-5">
              <div className="flex items-center gap-3">
                <item.icon className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <h3 className="font-semibold">{item.title}</h3>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function DocsSection() {
  return (
    <section className="border-b py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <SectionHeading
            title="Docs for builders"
            description="Start with the public docs, then follow the links into commands, architecture, status notes, contribution paths, and the repo boundaries that matter."
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
          {docsHighlights.map((doc) => (
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
            Run it, read it, or run it yourself.
          </h2>
          <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
            The whole stack is open source and the backend contract is frozen. Use the
            Anvil-hosted preview, deploy the same worker to your own Cloudflare account,
            or stay local-only — the tools do not care which you choose.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/docs/sync/self-deploy">
                Self-deploy the backend
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/docs/project/open-source">Open source posture</Link>
            </Button>
          </div>
        </div>
        <TerminalPanel
          title="mesh deploy — your cloudflare account"
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
