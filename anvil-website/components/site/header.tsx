import Link from "next/link";
import Image from "next/image";
import { Github, Menu } from "lucide-react";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { Button } from "@/components/ui/button";
import { githubRepositoryUrl, navItems } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/92 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3 font-semibold tracking-normal" aria-label="Anvil home">
          <Image src="/anvil-crest.svg" alt="" width={36} height={36} className="size-9" priority aria-hidden="true" />
          <span className="text-lg" aria-hidden="true">Anvil</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex" aria-label="Main navigation">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className="rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          <Button asChild>
            <Link href="/docs">Read the docs</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={githubRepositoryUrl}>
              <Github data-icon="inline-start" aria-hidden="true" />
              GitHub
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <details className="group relative">
            <summary
              className="inline-flex size-9 cursor-pointer list-none items-center justify-center rounded-md border bg-background text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden"
              aria-label="Open navigation menu"
            >
              <Menu className="size-4" aria-hidden="true" />
            </summary>
            <nav
              className="absolute right-0 top-11 z-50 flex w-56 flex-col gap-1 rounded-lg border bg-background p-2 shadow-lg"
              aria-label="Mobile navigation"
            >
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.label}
                </Link>
              ))}
              <Link
                href={githubRepositoryUrl}
                className="flex items-center gap-2 rounded-md border-t px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Github className="size-4" aria-hidden="true" />
                GitHub
              </Link>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
