import Link from "next/link";
import Image from "next/image";
import { githubRepositoryUrl, productLines, repositoryUrl } from "@/lib/site";

const syncLinks = [
  { label: "Overview", href: "/sync" },
  { label: "Pricing", href: "/pricing" },
  { label: "Sync & Mesh docs", href: "/docs/sync/overview" },
  { label: "Encryption & keys", href: "/docs/sync/encryption" },
  { label: "Self-deploy", href: "/docs/sync/self-deploy" },
  { label: "Status & limits", href: "/docs/sync/status-and-limits" }
];

const projectLinks = [
  { label: "Documentation", href: "/docs" },
  { label: "Monorepo map", href: repositoryUrl },
  { label: "GitHub", href: githubRepositoryUrl },
  { label: "Open source posture", href: "/docs/project/open-source" },
  { label: "Contributing", href: "/docs/project/contributing" },
  { label: "Account", href: "/account" }
];

export function SiteFooter() {
  return (
    <footer className="border-t bg-background">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.2fr_auto_auto_auto] lg:px-8">
        <div className="flex items-start gap-3">
          <Image src="/anvil-crest.svg" alt="" width={36} height={36} className="size-9" aria-hidden="true" />
          <div>
            <p className="font-semibold">Anvil</p>
            <p className="max-w-xs text-sm leading-6 text-muted-foreground">
              Open source developer tools that run on your machines.
            </p>
            <p className="mt-3 font-mono text-[0.6875rem] text-muted-foreground">
              anvil-stack · local-first · provider-neutral
            </p>
          </div>
        </div>
        <FooterLinks
          title="The stack"
          links={productLines.map((product) => ({
            label: product.title.replace("Anvil ", ""),
            href: `/docs/${product.id}`
          }))}
        />
        <FooterLinks title="Sync & Mesh" links={syncLinks} />
        <FooterLinks title="Project" links={projectLinks} />
      </div>
    </footer>
  );
}

function FooterLinks({ title, links }: { title: string; links: Array<{ label: string; href: string }> }) {
  return (
    <nav aria-label={`${title} links`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="mt-3 grid gap-2.5">
        {links.map((link) => (
          <li key={link.href}>
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
  );
}
