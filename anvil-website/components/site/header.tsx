import Link from "next/link";
import { ChevronDown, Download, Github, Menu, UserRound } from "lucide-react";
import { AnvilMark } from "@/components/site/anvil-mark";
import { NavMenu } from "@/components/site/nav-menu";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { githubRepositoryUrl, latestDesktopDmgUrl, products } from "@/lib/site";
import { workosConfigured } from "@/lib/workos-env";

type Active = "home" | "docs" | "sync" | "pricing" | "account";

const linkClass =
  "flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const mobileLinkClass =
  "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-foreground hover:bg-muted";

export function SiteHeader({ active }: { active?: Active }) {
  const accountEnabled = workosConfigured();
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 supports-[backdrop-filter]:bg-background/80 supports-[backdrop-filter]:backdrop-blur-lg">
      <div className="page-shell flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="-ml-1 flex min-h-11 items-center gap-2 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Anvil home"
          aria-current={active === "home" ? "page" : undefined}
        >
          <AnvilMark className="size-8 text-foreground" />
          <span className="font-display text-xl tracking-[-0.02em]">Anvil</span>
        </Link>

        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="Main navigation">
          <NavMenu
            label="Products"
            labelClassName={`${linkClass} cursor-pointer gap-1.5`}
            panelClassName="absolute left-0 top-12 z-50 grid w-[22rem] gap-0.5 rounded-xl border bg-popover p-2 shadow-[0_16px_40px_-12px_oklch(0.2_0.02_255/0.28)]"
            buttonContent={
              <>
                Products
                <ChevronDown className="size-3.5" aria-hidden="true" />
              </>
            }
          >
            {products.map((product) => (
              <Link
                key={product.id}
                href={product.href}
                className="grid grid-cols-[1.25rem_1fr] items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <product.icon className="mt-0.5 size-4 text-accent" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-semibold">{product.title}</span>
                  <span className="mt-0.5 block text-[0.8125rem] leading-5 text-muted-foreground">
                    {product.tagline}
                  </span>
                </span>
              </Link>
            ))}
          </NavMenu>
          <Link href="/sync" aria-current={active === "sync" ? "page" : undefined} className={linkClass}>
            Sync &amp; Mesh
          </Link>
          <Link href="/docs" aria-current={active === "docs" ? "page" : undefined} className={linkClass}>
            Docs
          </Link>
          <Link href="/pricing" aria-current={active === "pricing" ? "page" : undefined} className={linkClass}>
            Pricing
          </Link>
        </nav>

        <div className="hidden items-center gap-1 lg:flex">
          <ThemeToggle />
          <Link href={githubRepositoryUrl} className={`${linkClass} gap-2`} aria-label="Anvil on GitHub">
            <Github className="size-4" aria-hidden="true" />
            <span className="hidden lg:inline">GitHub</span>
          </Link>
          {accountEnabled ? (
            <Link
              href="/account"
              aria-current={active === "account" ? "page" : undefined}
              className={`${linkClass} gap-2`}
            >
              <UserRound className="size-4" aria-hidden="true" />
              <span className="hidden lg:inline">Account</span>
            </Link>
          ) : null}
          <Link
            href={latestDesktopDmgUrl}
            className="ml-1 inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-[color-mix(in_oklch,oklch(var(--primary))_88%,white)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Download className="size-4" aria-hidden="true" />
            Download
          </Link>
        </div>

        <div className="flex items-center gap-1 lg:hidden">
          <ThemeToggle />
          <NavMenu
            label="Menu"
            labelClassName="inline-flex size-11 cursor-pointer items-center justify-center rounded-md border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            panelClassName="absolute right-0 top-12 z-50 grid max-h-[calc(100dvh-5rem)] w-[min(20rem,calc(100vw-2rem))] gap-0.5 overflow-y-auto rounded-xl border bg-popover p-2 shadow-[0_16px_40px_-12px_oklch(0.2_0.02_255/0.28)]"
            buttonContent={<Menu className="size-4" aria-hidden="true" />}
          >
            {products.map((product) => (
              <Link key={product.id} href={product.href} className={mobileLinkClass}>
                <product.icon className="size-4 text-accent" aria-hidden="true" />
                {product.title}
              </Link>
            ))}
            <div className="my-1 border-t" />
            <Link href="/docs" className={mobileLinkClass}>Docs</Link>
            <Link href="/pricing" className={mobileLinkClass}>Pricing</Link>
            <Link href={githubRepositoryUrl} className={mobileLinkClass}>
              <Github className="size-4" aria-hidden="true" />
              GitHub
            </Link>
            {accountEnabled ? (
              <Link href="/account" className={mobileLinkClass}>
                <UserRound className="size-4" aria-hidden="true" />
                Account
              </Link>
            ) : null}
            <Link
              href={latestDesktopDmgUrl}
              className="mt-1 flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground"
            >
              <Download className="size-4" aria-hidden="true" />
              Download for Mac
            </Link>
          </NavMenu>
        </div>
      </div>
    </header>
  );
}
