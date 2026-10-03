import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { DeviceTable } from "@/components/account/device-table";
import { LinkCodeCard } from "@/components/account/link-code-card";
import { PairDeviceCard } from "@/components/account/pair-device-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hostedFailureMessage, loadAccountContext, tryHosted } from "@/lib/account";
import { listDevices } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata = { title: "Devices | Anvil" };

export default async function DevicesPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;
  if (ctx.status === "backend-unconfigured") return <BackendNotConfigured />;
  return <DevicesData identity={ctx.identity} />;
}

async function DevicesData({ identity }: { identity: HostedIdentity }) {
  const devices = await tryHosted(() => listDevices(identity));

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Devices</h1>
        <p className="text-sm text-muted-foreground">
          Machines paired to your hosted sync account. Revoking signs a device out of hosted sync;
          it keeps working local-only.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Paired devices</CardTitle>
          <CardDescription>
            Every enrolled device session on the account, including revoked rows kept for audit.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {devices.ok ? (
            devices.data.devices.length > 0 ? (
              <DeviceTable devices={devices.data.devices} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No devices paired yet — mint a pairing code below and enter it in Anvil.
              </p>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              {devices.code === "not-found"
                ? "The hosted API does not expose device management yet. Pair and revoke devices in Anvil → Settings → Sync & Mesh — the pairing and link codes below already work."
                : hostedFailureMessage(devices.code, devices.status)}
            </p>
          )}
        </CardContent>
      </Card>

      <PairDeviceCard />
      <LinkCodeCard />
    </div>
  );
}
