import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Dev-posture panel: the account service is optional infrastructure, and a
 * deployment without WorkOS env must say so plainly rather than fail.
 */
export function AuthNotConfigured() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account sign-in is not configured</CardTitle>
        <CardDescription>
          This deployment has no WorkOS AuthKit environment. Nothing here is broken — the account
          area is disabled until `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, and
          `NEXT_PUBLIC_WORKOS_REDIRECT_URI` are set.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          See <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[13px]">.env.example</code> for
          the full variable list, or read the{" "}
          <Link href="/docs/desktop/sync-and-mesh" className="font-medium text-foreground underline underline-offset-4">
            Sync &amp; Mesh docs
          </Link>{" "}
          for what the hosted account provides.
        </p>
      </CardContent>
    </Card>
  );
}

export function BackendNotConfigured() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hosted sync backend is not configured</CardTitle>
        <CardDescription>
          You are signed in, but this deployment has no hosted service channel. Set
          `ANVIL_BACKEND_ORIGIN`, `ANVIL_HOSTED_KEY_ID`, and `ANVIL_HOSTED_SERVICE_SECRET` to enable
          account, billing, and device operations against the backend&apos;s `/internal/hosted/*` API.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Until then, devices are managed locally in Anvil → Settings → Sync &amp; Mesh.
        </p>
      </CardContent>
    </Card>
  );
}
