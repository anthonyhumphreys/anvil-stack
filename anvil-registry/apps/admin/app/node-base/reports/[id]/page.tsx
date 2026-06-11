import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { JsonBlock } from "@/components/admin/json-block";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { formatDate } from "@/components/admin/format";
import { getPersistence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function NodeBaseReportPage({ params }: { params: Promise<{ id: string }> }) {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const { id } = await params;
  const report = await getPersistence().getNodeBaseReport(decodeURIComponent(id));
  if (!report) notFound();

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Node Base report</Badge>
          <h1 className="mt-4 break-words text-3xl font-semibold tracking-normal">{report.reportType}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Install-time evidence captured by Anvil Node Base.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Type", value: report.reportType, tone: "muted" },
            { label: "Source", value: report.source, tone: "muted" },
            { label: "Project", value: report.projectName ?? "unknown", tone: "muted" },
            { label: "Created", value: formatDate(report.createdAt), tone: "muted" }
          ]}
        />
        <Section title="Summary">
          <Card>
            <CardContent className="p-6">
              <JsonBlock value={report.summary ?? (isRecord(report.report) ? report.report.summary : undefined) ?? {}} />
            </CardContent>
          </Card>
        </Section>
        <Section title="Raw report">
          <JsonBlock value={report.report} />
        </Section>
      </div>
    </AdminShell>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
