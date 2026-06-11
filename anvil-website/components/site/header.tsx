import Link from "next/link";
import Image from "next/image";
import { BookOpen, Github } from "lucide-react";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { Button } from "@/components/ui/button";
import { navItems, repositoryUrl } from "@/lib/site";

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
            <Link href={repositoryUrl}>
              <Github data-icon="inline-start" aria-hidden="true" />
              Repositories
            </Link>
          </Button>
        </div>
        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <Button asChild variant="outline" size="icon" aria-label="Read the docs">
            <Link href="/docs/overview">
              <BookOpen aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
