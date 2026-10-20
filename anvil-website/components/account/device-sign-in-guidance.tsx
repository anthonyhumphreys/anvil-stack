import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function DeviceSignInGuidance() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a device</CardTitle>
        <CardDescription>
          Sign in to the same Anvil account on each machine you want to connect.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>
          <span className="font-medium">Desktop:</span> Open Settings → Sync &amp; Mesh and choose{" "}
          <span className="font-medium">Sign in to Anvil</span>.
        </p>
        <p>
          <span className="font-medium">Headless:</span> Run{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            anvil-daemon sign-in --api-url https://&lt;backend&gt;
          </code>{" "}
          on the host, then complete sign-in in a browser on another device.
        </p>
        <p className="text-muted-foreground">
          New hosted accounts use automatic connection by default. A trusted device must be online
          to deliver the account key. Choose <span className="font-medium">Verify each device with a code</span> in Sync &amp;
          Mesh settings for a manual check, and save the recovery code shown during setup.
        </p>
      </CardContent>
    </Card>
  );
}
