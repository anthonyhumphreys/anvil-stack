import { LockKeyhole } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { loginAction } from "@/lib/actions";

export function LoginPanel({ invalid }: { invalid?: boolean }) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl items-center">
      <Card className="w-full shadow-anvil">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
            <LockKeyhole />
          </div>
          <CardTitle>Unlock admin operations</CardTitle>
          <CardDescription>Enter the local admin token to view package evidence and manage overrides.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {invalid ? (
            <Alert variant="destructive">
              <AlertTitle>Invalid token</AlertTitle>
              <AlertDescription>The token did not match this admin service.</AlertDescription>
            </Alert>
          ) : null}
          <form action={loginAction} className="flex flex-col gap-3 sm:flex-row">
            <Input name="token" type="password" placeholder="local-dev-token" aria-label="Admin token" autoComplete="current-password" />
            <Button type="submit">Unlock</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
