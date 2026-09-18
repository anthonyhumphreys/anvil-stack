import Image from "next/image";
import Link from "next/link";
import { ChevronDown, Download, Github, Menu, Radio, UserRound } from "lucide-react";
import { NavMenu } from "@/components/site/nav-menu";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { githubRepositoryUrl, latestDesktopDmgUrl, productLines } from "@/lib/site";
import { workosConfigured } from "@/lib/workos-env";

const linkClass =
  "flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SiteHeader({ active }: { active?: "home" | "docs" | "sync" | "pricing" | "account" }) {
  const accountEnabled = workosConfigured();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 supports-[backdrop-filter]:bg-background/88 supports-[backdrop-filter]:backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex min-h-11 items-center gap-3 rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Anvil home"
          aria-current={active === "home" ? "page" : undefined}
        >
          <Image src="/anvil-crest.svg" alt="" width={34} height={34} className="size-[2.125rem]" priority aria-hidden="true" />
          <span className="text-lg">Anvil</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main navigation">
          <NavMenu
            label="Products"
            labelClassName="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            panelClassName="absolute left-0 top-12 z-50 grid w-80 gap-1 rounded-lg border bg-background p-2 shadow-lg"
            buttonContent={
              <>
                Products
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </>
            }
          >
            {productLines.map((product) => (
              <Link
                key={product.id}
                href={`/docs/${product.id}`}
                className="grid min-h-14 grid-cols-[1.5rem_1fr] items-center gap-3 rounded-md px-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <product.icon className="size-4 text-accent" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium">{product.title}</span>
                  <span className="block font-mono text-[0.6875rem] text-muted-foreground">{product.repoName}</span>
                </span>
              </Link>
            ))}
            <Link
              href="/sync"
              className="grid min-h-14 grid-cols-[1.5rem_1fr] items-center gap-3 rounded-md border-t px-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Radio className="size-4 text-accent" aria-hidden="true" />
              <span>
                <span className="block text-sm font-medium">Sync &amp; Mesh</span>
                <span className="block font-mono text-[0.6875rem] text-muted-foreground">account layer</span>
              </span>
            </Link>
          </NavMenu>
          <Link href="/docs" aria-current={active === "docs" ? "page" : undefined} className={linkClass}>
            Docs
          </Link>
          <Link href="/sync" aria-current={active === "sync" ? "page" : undefined} className={linkClass}>
            Sync
          </Link>
          <Link href="/pricing" aria-current={active === "pricing" ? "page" : undefined} className={linkClass}>
            Pricing
          </Link>
          <Link href="/docs/project/open-source" className={linkClass}>
            Open source
          </Link>
        </nav>

        <div className="hidden items-center gap-1 md:flex">
          <ThemeToggle />
          {accountEnabled ? (
            <Link href="/account" aria-current={active === "account" ? "page" : undefined} className={`${linkClass} gap-2`}>
              <UserRound className="size-4" aria-hidden="true" />
              Account
            </Link>
          ) : null}
          <Link href={githubRepositoryUrl} className={`${linkClass} gap-2`}>
            <Github className="size-4" aria-hidden="true" />
            GitHub
          </Link>
          <Link
            href={latestDesktopDmgUrl}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Download className="size-4" aria-hidden="true" />
            Download
          </Link>
        </div>

        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <NavMenu
            label="Open navigation menu"
            labelClassName="inline-flex size-11 cursor-pointer items-center justify-center rounded-md border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            panelClassName="absolute right-0 top-12 z-50 grid max-h-[calc(100dvh-5rem)] w-72 gap-1 overflow-y-auto rounded-lg border bg-background p-2 shadow-lg"
            buttonContent={<Menu className="size-4" aria-hidden="true" />}
          >
            <Link href="/docs" className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted">
              Documentation
            </Link>
            <Link href="/sync" className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted">
              Sync &amp; Mesh
            </Link>
            <Link href="/pricing" className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted">
              Pricing
            </Link>
            <Link href="/docs/project/open-source" className="flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-muted">
              Open source
            </Link>
            {productLines.map((product) => (
              <Link
                key={product.id}
                href={`/docs/${product.id}`}
                className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <product.icon className="size-4 text-accent" aria-hidden="true" />
                {product.title}
              </Link>
            ))}
            {accountEnabled ? (
              <Link href="/account" className="flex min-h-11 items-center gap-2 border-t px-3 text-sm font-medium text-muted-foreground hover:text-foreground">
                <UserRound className="size-4" aria-hidden="true" />
                Account
              </Link>
            ) : null}
            <Link href={githubRepositoryUrl} className="flex min-h-11 items-center gap-2 border-t px-3 text-sm font-medium text-muted-foreground hover:text-foreground">
              <Github className="size-4" aria-hidden="true" />
              GitHub
            </Link>
            <Link href={latestDesktopDmgUrl} className="flex min-h-11 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
              <Download className="size-4" aria-hidden="true" />
              Download Desktop
            </Link>
          </NavMenu>
        </div>
      </div>
    </header>
  );
}
