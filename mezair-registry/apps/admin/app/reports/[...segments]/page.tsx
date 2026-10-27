import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { JsonBlock } from "@/components/admin/json-block";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { formatDate, Score, shortMiddle } from "@/components/admin/format";
import { analysisArtifactKinds, analysisReportArtifactObjectKey, analysisReportIdentity, splitPackageSegments } from "@/lib/admin-api";
import { analysisReportArtifactUrl, getPersistence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params, searchParams }: { params: Promise<{ segments: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const { segments } = await params;
  const target = splitPackageSegments(segments);
  if (!target) notFound();
  const query = new URLSearchParams(flatten(await searchParams));
  const report = await getPersistence().getAnalysisReport(target.packageName, target.version, analysisReportIdentity(query));
  if (!report) notFound();

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Analysis report</Badge>
          <h1 className="mt-4 break-words font-mono text-3xl font-semibold tracking-normal">{target.packageName}@{target.version}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Static analysis evidence for one immutable package identity.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Score", value: report.score, tone: report.score >= 95 ? "block" : report.score > 0 ? "warn" : "allow" },
            { label: "Signals", value: report.signals.length, tone: report.signals.length ? "warn" : "muted" },
            { label: "Analyser", value: report.analyserVersion, tone: "muted" },
            { label: "Created", value: formatDate(report.createdAt), tone: "muted" }
          ]}
        />
        <Section title="Identity" description="The analysed tarball and policy identity.">
          <Card>
            <CardContent className="grid gap-4 p-6 md:grid-cols-2">
              <Fact label="Policy" value={report.policyVersion} />
              <Fact label="Integrity" value={report.tarballIntegrity ?? "unknown"} />
              <Fact label="Shasum" value={report.tarballShasum ?? "unknown"} />
              <Fact label="Object key" value={report.objectKey ?? "not stored"} />
            </CardContent>
          </Card>
        </Section>
        <Section title="Stored artifacts" description="Download raw analysis artifacts from object storage when available.">
          <div className="flex flex-wrap gap-2">
            {analysisArtifactKinds.map((kind) => {
              const objectKey = analysisReportArtifactObjectKey(report, kind);
              return objectKey ? (
                <Button key={kind} asChild variant="outline" size="sm">
                  <Link href={`${analysisReportArtifactUrl(report)}${kind === "report" ? "" : `&kind=${kind}`}`}>{kind}</Link>
                </Button>
              ) : null;
            })}
          </div>
        </Section>
        <Section title="Signals">
          <div className="grid gap-3 lg:grid-cols-2">
            {report.signals.map((signal) => (
              <Card key={`${signal.code}:${signal.message}`}>
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div>
                    <div className="font-mono text-sm font-medium">{signal.code}</div>
                    <p className="mt-1 text-sm text-muted-foreground">{signal.message}</p>
                  </div>
                  <Badge variant={signal.severity === "high" || signal.severity === "critical" ? "destructive" : "secondary"}>{signal.severity}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
        <Section title="Raw report">
          <JsonBlock value={report} />
        </Section>
      </div>
    </AdminShell>
  );
}

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px]" title={String(value)}>
        {shortMiddle(String(value), 72)}
      </div>
    </div>
  );
}

function flatten(params: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(Object.entries(params).flatMap(([key, value]) => (Array.isArray(value) ? [[key, value[0] ?? ""]] : value ? [[key, value]] : [])));
}
