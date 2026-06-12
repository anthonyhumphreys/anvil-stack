import Link from "next/link";
import { Boxes, FileWarning, Gauge, GitCompareArrows, Hammer, ListFilter, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { logoutAction } from "@/lib/actions";

const navItems = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/decisions/blocked", label: "Blocked", icon: ShieldAlert },
  { href: "/decisions/quarantined", label: "Quarantined", icon: FileWarning },
  { href: "/policy", label: "Policy", icon: GitCompareArrows },
  { href: "/node-base/reports", label: "Node Base", icon: Boxes },
  { href: "/popular-package-index", label: "Index", icon: ListFilter }
];

export function AdminShell({ children, isAdmin }: { children: React.ReactNode; isAdmin: boolean }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/92 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1440px] items-center justify-between gap-4 px-4 lg:px-8">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg border bg-primary text-primary-foreground">
              <Hammer data-icon="inline-start" />
            </span>
            <span>
              <span className="block text-base font-semibold leading-tight">Anvil Admin</span>
              <span className="block text-xs text-muted-foreground">Registry policy operations</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            {isAdmin ? (
              <form action={logoutAction}>
                <Button variant="outline" size="sm">
                  Lock
                </Button>
              </form>
            ) : null}
          </div>
        </div>
      </header>
      <div className="mx-auto grid min-w-0 max-w-[1440px] grid-cols-1 gap-0 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b bg-muted/30 lg:min-h-[calc(100vh-65px)] lg:border-b-0 lg:border-r">
          <nav className="flex min-w-0 gap-1 overflow-x-auto p-3 lg:flex-col lg:p-4" aria-label="Admin navigation">
            {navItems.map((item) => (
              <Button key={item.href} asChild variant="ghost" className="justify-start">
                <Link href={item.href}>
                  <item.icon data-icon="inline-start" />
                  {item.label}
                </Link>
              </Button>
            ))}
          </nav>
          <Separator className="hidden lg:block" />
          <div className="hidden p-4 text-xs leading-6 text-muted-foreground lg:block">
            Deterministic policy is the enforcement authority. This console shows the receipts: decisions, identities, artefacts, overrides, and audit events.
          </div>
        </aside>
        <main className="min-w-0 px-4 py-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
