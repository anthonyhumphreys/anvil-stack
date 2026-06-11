import Link from "next/link";
import Image from "next/image";
import { repositoryUrl } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="border-t bg-background">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
        <div className="flex items-center gap-3">
          <Image src="/anvil-crest.svg" alt="" width={36} height={36} className="size-9" aria-hidden="true" />
          <div>
            <p className="font-semibold">Anvil</p>
            <p className="text-sm text-muted-foreground">Open source tools for inspectable developer work.</p>
          </div>
        </div>
        <nav className="flex flex-wrap gap-5 text-sm text-muted-foreground" aria-label="Footer navigation">
          <Link href={repositoryUrl} className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Repositories
          </Link>
          <Link href="/docs/cloud/overview" className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Cloud
          </Link>
          <Link href="/docs/registry/policy" className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Policy
          </Link>
          <Link href="/docs/registry/deploy" className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            Deploy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
