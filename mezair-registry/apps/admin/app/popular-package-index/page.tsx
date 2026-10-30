import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { uploadPopularPackageIndexAction } from "@/lib/actions";
import { getDashboardData } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PopularPackageIndexPage() {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const { popularPackageIndex } = await getDashboardData();

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Name squatting reference</Badge>
          <h1 className="mt-4 text-3xl font-semibold tracking-normal">Popular package index</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Reference package names and known confusions used by deterministic similarity checks.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Source", value: popularPackageIndex.source, tone: "muted" },
            { label: "Generated", value: popularPackageIndex.generatedAt ?? "unknown", tone: "muted" },
            { label: "Packages", value: popularPackageIndex.popularPackages.length, tone: "allow" },
            { label: "Known confusions", value: Object.keys(popularPackageIndex.knownConfusions).length, tone: "warn" }
          ]}
        />
        <Section title="Popular packages">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Weekly downloads</TableHead>
                <TableHead>Aliases</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {popularPackageIndex.popularPackages.map((pkg) => (
                <TableRow key={pkg.name}>
                  <TableCell className="font-mono text-[13px]">{pkg.name}</TableCell>
                  <TableCell>{pkg.weeklyDownloads ?? "unknown"}</TableCell>
                  <TableCell className="text-muted-foreground">{pkg.aliases?.join(", ") || "none"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
        <Section title="Known ecosystem confusions">
          <div className="grid gap-3 lg:grid-cols-2">
            {Object.entries(popularPackageIndex.knownConfusions).map(([name, confusedWith]) => (
              <Card key={name}>
                <CardHeader className="pb-2">
                  <CardTitle className="font-mono text-sm">{name}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{Array.isArray(confusedWith) ? confusedWith.join(", ") : confusedWith}</CardContent>
              </Card>
            ))}
          </div>
        </Section>
        <Section title="Upload index" description="Replace the active typo-squatting reference index after offline generation or review.">
          <form action={uploadPopularPackageIndexAction} className="grid gap-4">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-2 text-sm font-medium">
                Generated at
                <input className="h-10 rounded-md border bg-background px-3 text-sm font-normal" name="generatedAt" placeholder="2026-05-20T00:00:00.000Z" />
              </label>
              <label className="grid gap-2 text-sm font-medium">
                Uploaded by
                <input className="h-10 rounded-md border bg-background px-3 text-sm font-normal" name="uploadedBy" defaultValue="admin-ui" />
              </label>
            </div>
            <label className="grid gap-2 text-sm font-medium">
              Index JSON
              <textarea
                className="min-h-52 rounded-md border bg-background p-3 font-mono text-xs font-normal leading-5"
                name="indexJson"
                defaultValue={JSON.stringify({ popularPackages: popularPackageIndex.popularPackages, knownConfusions: popularPackageIndex.knownConfusions }, null, 2)}
              />
            </label>
            <div>
              <Button type="submit">Upload index</Button>
            </div>
          </form>
        </Section>
      </div>
    </AdminShell>
  );
}
