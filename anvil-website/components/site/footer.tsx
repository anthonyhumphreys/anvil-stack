import Link from "next/link";
import Image from "next/image";
import { githubRepositoryUrl, productLines, repositoryUrl } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t bg-background">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1fr_auto_auto] lg:px-8">
        <div className="flex items-start gap-3">
          <Image src="/anvil-crest.svg" alt="" width={36} height={36} className="size-9" aria-hidden="true" />
          <div>
            <p className="font-semibold">Anvil</p>
            <p className="text-sm text-muted-foreground">Open source tools for inspectable developer work.</p>
          </div>
        </div>
        <FooterLinks title="Products" links={productLines.map((product) => ({ label: product.title.replace("Anvil ", ""), href: `/docs/${product.id}` }))} />
        <FooterLinks title="Project" links={[{ label: "Documentation", href: "/docs" }, { label: "Monorepo map", href: repositoryUrl }, { label: "GitHub", href: githubRepositoryUrl }, { label: "Contributing", href: "/docs/project/contributing" }]} />
      </div>
    </footer>
  );
}

function FooterLinks({ title, links }: { title: string; links: Array<{ label: string; href: string }> }) {
  return <nav aria-label={`${title} links`}><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p><ul className="mt-3 grid gap-2.5">{links.map((link) => <li key={link.href}><Link href={link.href} className="text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{link.label}</Link></li>)}</ul></nav>;
}
