import Link from "next/link";
import { MezairMark } from "@/components/site/mezair-mark";
import { githubRepositoryUrl, latestDesktopDmgUrl, products, releasesUrl, repositoryUrl } from "@/lib/site";

const columns = [
  {
    title: "Products",
    links: products.map((product) => ({ label: product.title.replace("Mezair ", ""), href: product.href }))
  },
  {
    title: "Get started",
    links: [
      { label: "Download for Mac", href: latestDesktopDmgUrl },
      { label: "Windows and Linux", href: releasesUrl },
      { label: "Install guide", href: "/docs/desktop/installation" },
      { label: "Documentation", href: "/docs" },
      { label: "Pricing", href: "/pricing" },
      { label: "Run your own backend", href: "/docs/sync/self-deploy" }
    ]
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: githubRepositoryUrl },
      { label: "Monorepo map", href: repositoryUrl },
      { label: "Contributing", href: "/docs/project/contributing" },
      { label: "Why open source", href: "/docs/project/open-source" },
      { label: "What does Mezair mean?", href: "/what-does-mezair-mean" },
      { label: "Account", href: "/account" }
    ]
  }
];

export function SiteFooter() {
  return (
    <footer className="border-t bg-background">
      <div className="page-shell grid gap-12 py-14 md:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))]">
        <div className="max-w-xs">
          <Link href="/" className="mk-hover inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <MezairMark className="h-8 w-12 text-foreground" />
            <span className="font-display text-xl tracking-[-0.02em]">Mezair</span>
          </Link>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            Open-source tools for running coding agents on your own machines.
          </p>
        </div>
        {columns.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <p className="text-sm font-semibold">{column.title}</p>
            <ul className="mt-4 grid gap-2.5">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t">
        <div className="page-shell flex flex-col gap-2 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>MIT licensed. © {new Date().getFullYear()} Anthony Humphreys.</p>
          <Link href={githubRepositoryUrl} className="hover:text-foreground">
            Source on GitHub
          </Link>
        </div>
      </div>
    </footer>
  );
}
