import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { DashboardAccess } from "@/components/account/dashboard-access";
import { PairDeviceCard } from "@/components/account/pair-device-card";
import { loadAccountContext } from "@/lib/account";

export const metadata = { title: "Dashboard | Anvil" };

/**
 * The end-to-end encrypted account dashboard. Sign-in alone shows a locked
 * surface — content only appears after a trusted device approves this
 * browser's ephemeral-key request and seals a session key to it.
 */
export default async function AccountDashboardPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          An encrypted projection of your mesh — unlocked only while a trusted device authorizes
          this browser session.
        </p>
      </header>

      {ctx.status === "backend-unconfigured" ? (
        <BackendNotConfigured />
      ) : (
        <>
          <DashboardAccess />
          <PairDeviceCard />
        </>
      )}
    </div>
  );
}
