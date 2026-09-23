"use client";

import { usePathname } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export function AccountChrome({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const isWorkspace = pathname === "/account/workspace" || pathname.startsWith("/account/workspace/");

  if (isWorkspace) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader active="account" />
        <main id="main-content" className="min-w-0">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader active="account" />
      <div className="mx-auto grid max-w-[90rem] grid-cols-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:px-8">
        <aside className="lg:pt-1">
          <div className="lg:sticky lg:top-24">
            <AccountNav />
          </div>
        </aside>
        <main id="main-content" className="min-w-0">
          {children}
        </main>
      </div>
      <SiteFooter />
    </div>
  );
}
