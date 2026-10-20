import Link from "next/link";

import { signOutAction } from "@/app/account/actions";
import { AuthNotConfigured, BackendNotConfigured } from "@/components/account/not-configured";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, loadAccountContext } from "@/lib/account";

export const metadata = { title: "Security | Anvil" };

export default async function SecurityPage() {
  const ctx = await loadAccountContext();
  if (ctx.status === "auth-unconfigured") return <AuthNotConfigured />;

  const { user } = ctx;
  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Security</h1>
        <p className="text-sm text-muted-foreground">
          Your WorkOS session and sign-in details.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Fields held by the WorkOS session.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Email</dt>
              <dd className="mt-0.5">
                {user.email}
                {user.emailVerified ? (
                  <span className="ml-2 text-xs text-muted-foreground">(verified)</span>
                ) : (
                  <span className="ml-2 text-xs text-destructive">(unverified)</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Name</dt>
              <dd className="mt-0.5">{user.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Last sign-in</dt>
              <dd className="mt-0.5">{formatDate(user.lastSignInAt) ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Account created</dt>
              <dd className="mt-0.5">{formatDate(user.createdAt) ?? "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">WorkOS user id</dt>
              <dd className="mt-0.5 font-mono text-xs">{user.id}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>
            The session is an encrypted cookie sealed by this deployment. Sign-out clears it and
            ends the WorkOS session.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Signing out here does not revoke paired devices — manage them under{" "}
            <Link
              href="/account/devices"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Devices
            </Link>
            .
          </p>
          <div>
            <form action={signOutAction}>
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>

      {ctx.status === "backend-unconfigured" ? <BackendNotConfigured /> : null}
    </div>
  );
}
