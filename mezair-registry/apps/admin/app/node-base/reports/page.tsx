import { Badge } from "@/components/ui/badge";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { NodeBaseReportTable } from "@/components/admin/data-tables";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { getPersistence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NodeBaseReportsPage() {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const reports = await getPersistence().listNodeBaseReports({ limit: 100 });
  const typeCounts = reports.reduce<Record<string, number>>((counts, report) => {
    counts[report.reportType] = (counts[report.reportType] ?? 0) + 1;
    return counts;
  }, {});

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Local safety harness</Badge>
          <h1 className="mt-4 text-3xl font-semibold tracking-normal">Node Base reports</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Observed install, network, lifecycle, and image reports from hardened development environments.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Reports", value: reports.length, tone: "muted" },
            { label: "Lifecycle", value: typeCounts.lifecycle ?? 0, tone: "warn" },
            { label: "Network", value: typeCounts.network ?? 0, tone: "quarantine" },
            { label: "IOC", value: typeCounts.ioc ?? 0, tone: "block" }
          ]}
        />
        <Section title="Recent reports">
          <NodeBaseReportTable reports={reports} />
        </Section>
      </div>
    </AdminShell>
  );
}
