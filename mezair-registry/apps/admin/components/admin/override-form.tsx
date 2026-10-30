import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createOverrideAction } from "@/lib/actions";

export function OverrideForm({ packageName = "", version = "" }: { packageName?: string; version?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create override</CardTitle>
        <CardDescription>Overrides are audited and invalidate the current cached policy decision for the package identity.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={createOverrideAction} className="grid gap-3 lg:grid-cols-[1.2fr_.7fr_.7fr_1.4fr_1fr_1fr_auto]">
          <Input name="packageName" placeholder="Package name" aria-label="Package name" defaultValue={packageName} required />
          <Input name="version" placeholder="Version" aria-label="Version" defaultValue={version} />
          <select name="action" aria-label="Action" className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <option value="allow">allow</option>
            <option value="warn">warn</option>
            <option value="quarantine">quarantine</option>
            <option value="block">block</option>
          </select>
          <Input name="reason" placeholder="Reason" aria-label="Reason" required />
          <Input name="approvedBy" placeholder="Approved by" aria-label="Approved by" defaultValue="admin-ui" />
          <Input name="expiresAt" placeholder="Expires at" aria-label="Expires at" />
          <Button type="submit">Create</Button>
        </form>
      </CardContent>
    </Card>
  );
}
