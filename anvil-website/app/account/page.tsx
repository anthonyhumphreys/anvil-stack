import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { EntitlementStateBadge, entitlementSummary } from "@/components/account/entitlement";
import { PairDeviceCard } from "@/components/account/pair-device-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  formatBytes,
  hostedFailureMessage,
  loadAccountContext,
  tryHosted
} from "@/lib/account";
import { getAccount, getEntitlement, listDevices } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata = { title: "Account overview | Anvil" };

export default async function AccountOverviewPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;

  const { user } = ctx;
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Account</h1>
        <p className="text-sm text-muted-foreground">
          Your hosted sync identity, entitlement, and paired devices.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Sign-in</CardTitle>
          <CardDescription>WorkOS identity backing this account.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Name</dt>
              <dd className="mt-0.5">{user.name ?? user.firstName ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Email</dt>
              <dd className="mt-0.5">{user.email}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">WorkOS user id</dt>
              <dd className="mt-0.5 font-mono text-xs">{user.id}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {ctx.status === "backend-unconfigured" ? (
        <BackendNotConfigured />
      ) : (
        <OverviewData identity={ctx.identity} />
      )}
    </div>
  );
}

async function OverviewData({ identity }: { identity: HostedIdentity }) {
  const [account, entitlement, devices] = await Promise.all([
    tryHosted(() => getAccount(identity)),
    tryHosted(() => getEntitlement(identity)),
    tryHosted(() => listDevices(identity))
  ]);

  const noAccount = !account.ok && account.code === "not-found";

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1.5">
              <CardTitle>Hosted sync entitlement</CardTitle>
              <CardDescription>
                What the backend currently grants this account.
              </CardDescription>
            </div>
            {entitlement.ok ? <EntitlementStateBadge state={entitlement.data.state} /> : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {entitlement.ok ? (
            <>
              <p className="text-sm text-muted-foreground">
                {entitlementSummary(entitlement.data)}
              </p>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Device limit</dt>
                  <dd className="mt-0.5 font-mono text-xs">{entitlement.data.limits.devices}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Artifact storage</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatBytes(entitlement.data.limits.artifactBytes)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">History retention</dt>
                  <dd className="mt-0.5 font-mono text-xs">
                    {formatBytes(entitlement.data.limits.historyBytes)}
                  </dd>
                </div>
              </dl>
              {entitlement.data.planKey ? (
                <p className="text-sm text-muted-foreground">
                  Plan: <span className="font-mono text-xs">{entitlement.data.planKey}</span>
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {entitlement.code === "not-found"
                ? "No hosted account exists yet — it is created when you pair your first device below."
                : hostedFailureMessage(entitlement.code, entitlement.status)}
            </p>
          )}
          {noAccount && entitlement.ok ? (
            <p className="text-sm text-muted-foreground">
              No hosted account exists yet — it is created when you pair your first device below.
            </p>
          ) : !account.ok ? (
            <p className="text-sm text-muted-foreground">
              {hostedFailureMessage(account.code, account.status)}
            </p>
          ) : account.data.lifecycle !== "active" ? (
            <p role="alert" className="text-sm text-destructive">
              This hosted account is {account.data.lifecycle} — see the Data section.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>Machines paired to this account.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {devices.ok ? (
            <p className="text-sm text-muted-foreground">
              {devices.data.devices.filter((device) => !device.revoked).length} active
              {devices.data.devices.some((device) => device.revoked)
                ? `, ${devices.data.devices.filter((device) => device.revoked).length} revoked`
                : ""}
              .
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {devices.code === "not-found"
                ? "No paired devices are available for this hosted account yet — use the pairing card below to connect one."
                : hostedFailureMessage(devices.code, devices.status)}
            </p>
          )}
          <div>
            <Button asChild size="sm" variant="outline">
              <Link href="/account/devices">
                Manage devices
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <PairDeviceCard />
    </>
  );
}
