"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { accountNavItems } from "@/lib/site";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string): boolean {
  return href === "/account" ? pathname === "/account" : pathname.startsWith(href);
}

/**
 * Account section navigation: a horizontal tab row on small screens and a
 * compact sidebar list on lg+. Mirrors the docs-nav link styling.
 */
export function AccountNav() {
  const pathname = usePathname();
  return (
    <>
      <nav aria-label="Account sections" className="mb-7 lg:hidden">
        <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
          {accountNavItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active && "bg-[oklch(var(--accent)/0.13)] text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <nav aria-label="Account sections" className="hidden lg:block">
        <ul className="grid gap-0.5">
          {accountNavItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-[background-color,color] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active && "bg-[oklch(var(--accent)/0.13)] font-semibold text-foreground"
                  )}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
                    <span
                      className={cn(
                        "size-1 rounded-full bg-border transition-[transform,background-color]",
                        active && "size-2 bg-accent"
                      )}
                    />
                  </span>
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
