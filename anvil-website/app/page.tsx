import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check, Download, Github } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodePanel } from "@/components/site/code-panel";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import {
  codeTabs,
  docsHighlights,
  githubRepositoryUrl,
  latestDesktopDmgUrl,
  productLines,
  proofPoints,
  repoComparison
} from "@/lib/site";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main>
        <HeroSection />
        <RepoMapSection />
        <ProductsSection />
        <ProofSection />
        <DocsSection />
      </main>
      <SiteFooter />
    </div>
  );
}

function HeroSection() {
  return (
    <section className="overflow-hidden border-b">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-14 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:px-8 lg:py-20">
        <div className="flex flex-col gap-8">
          <Badge variant="secondary" className="w-fit border bg-muted/70">
            Open source tools for inspectable developer work
          </Badge>
          <div className="flex flex-col gap-5">
            <h1 className="max-w-4xl text-5xl font-semibold leading-[0.96] tracking-normal text-foreground sm:text-6xl lg:text-7xl">
              Local evidence before trust.
            </h1>
            <p className="max-w-2xl text-lg leading-8 text-muted-foreground">
              Anvil is a small family of developer tools: Desktop for repo-aware agent delivery, Registry for safer npm dependency ingress, and Cloud for inspectable app runtime contracts. The common rule is simple: make the work reviewable before anyone has to believe it.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button asChild size="lg">
              <Link href="/docs">
                Read the docs
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={latestDesktopDmgUrl}>
                <Download data-icon="inline-start" aria-hidden="true" />
                Download macOS Apple Silicon
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/docs/project/repositories">Monorepo map</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href={githubRepositoryUrl}>
                <Github data-icon="inline-start" aria-hidden="true" />
                anvil-stack
              </Link>
            </Button>
          </div>
        </div>
        <div className="hero-proof">
          <div className="hero-proof-main">
            <Image
              src="/anvil-app-homepage.png"
              alt="Anvil Desktop showing repository navigation and an agent chat workspace."
              fill
              priority
              className="object-cover object-left-top"
              sizes="(min-width: 1024px) 680px, 100vw"
            />
          </div>
          <div className="hero-proof-command">
            <CodePanel title="Inspectable command output" command={codeTabs[2].command} output={codeTabs[2].output} />
          </div>
        </div>
      </div>
    </section>
  );
}

function RepoMapSection() {
  return (
    <section id="products" className="border-b bg-muted/20 py-14">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 lg:grid-cols-[0.58fr_1.42fr] lg:px-8">
        <SectionHeading
          title="One repo, three boundaries"
          description="Everything lives in the anvil-stack monorepo, but the split is intentional. Desktop coordinates local work, Registry controls dependency ingress, and Cloud constrains app runtime contracts."
        />
        <div className="grid gap-3">
          {repoComparison.map((item) => (
            <article key={item.repo} className="grid gap-4 rounded-lg border bg-background p-5 shadow-sm md:grid-cols-[13rem_1fr]">
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

function ProductsSection() {
  const [desktop, registry, cloud, nodeBase] = productLines;

  return (
    <section className="border-b py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          title="What each project does"
          description="The docs explain the mechanics. This is the short operational map."
        />
        <div className="mt-9 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          {desktop ? <ProductFeature product={desktop} /> : null}
          <div className="grid gap-5">
            {cloud ? <ProductRow product={cloud} /> : null}
            {registry ? <ProductRow product={registry} /> : null}
            {nodeBase ? <ProductRow product={nodeBase} compact /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProductFeature({ product }: { product: (typeof productLines)[number] }) {
  return (
    <article className="overflow-hidden rounded-lg border bg-card shadow-sm">
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
    <article className="rounded-lg border bg-card p-5 shadow-sm">
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
        <p className="text-sm text-muted-foreground">{product.eyebrow}</p>
        <h3 className="mt-1 text-2xl font-semibold tracking-normal">{product.title}</h3>
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
        {product.points.map((point) => (
          <li key={point} className="flex items-start gap-2">
            <Check className="mt-0.5 size-4 text-accent" aria-hidden="true" />
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
    <section className="border-b bg-muted/20 py-16">
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
    <section className="py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <SectionHeading
            title="Docs meant for maintainers"
            description="Start with the public docs, then follow the links into commands, architecture, status notes, and the repo boundaries that matter."
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

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">{title}</h2>
      <p className="mt-3 text-base leading-7 text-muted-foreground">{description}</p>
    </div>
  );
}
