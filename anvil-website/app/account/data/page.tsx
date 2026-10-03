import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { DeleteDataCard } from "@/components/account/delete-data-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, hostedFailureMessage, loadAccountContext, tryHosted } from "@/lib/account";
import { getDataStatus } from "@/lib/hosted";
import type { HostedIdentity } from "@/lib/hosted/types";

export const metadata = { title: "Data | Anvil" };

export default async function DataPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;
  if (ctx.status === "backend-unconfigured") return <BackendNotConfigured />;
  return <DataSection identity={ctx.identity} />;
}

async function DataSection({ identity }: { identity: HostedIdentity }) {
  const status = await tryHosted(() => getDataStatus(identity));
  const deleting = status.ok && status.data.state !== "none";

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Data</h1>
        <p className="text-sm text-muted-foreground">
          What the hosted backend stores for this account, and how to remove it.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Hosted data status</CardTitle>
          <CardDescription>
            Deletion lifecycle reported by the backend — enrollments disable first, then hosted
            data purges in bounded passes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status.ok ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">State</dt>
                <dd className="mt-0.5 font-mono text-xs">{status.data.state}</dd>
              </div>
              {status.data.purgedRows !== undefined ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Rows purged so far</dt>
                  <dd className="mt-0.5 font-mono text-xs">{status.data.purgedRows}</dd>
                </div>
              ) : null}
              {status.data.startedAt ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Deletion started</dt>
                  <dd className="mt-0.5">{formatDate(status.data.startedAt)}</dd>
                </div>
              ) : null}
              {status.data.deletedAt ? (
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Deletion finished</dt>
                  <dd className="mt-0.5">{formatDate(status.data.deletedAt)}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status.code === "not-found"
                ? "The hosted API does not expose a data-status endpoint yet. Deletion can be started in Anvil → Settings → Sync & Mesh on any paired device."
                : hostedFailureMessage(status.code, status.status)}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>
            Export runs inside Anvil → Settings → Sync &amp; Mesh. The website shows account state;
            the data itself stays on your machines and the backend you point them at.
          </CardDescription>
        </CardHeader>
      </Card>

      {deleting ? (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle>Delete hosted data</CardTitle>
            <CardDescription>
              Deletion is already in progress — the backend reports state{" "}
              <span className="font-mono">{status.ok ? status.data.state : "unknown"}</span>.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <DeleteDataCard />
      )}
    </div>
  );
}
