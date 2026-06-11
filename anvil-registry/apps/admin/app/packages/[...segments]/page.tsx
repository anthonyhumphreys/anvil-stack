import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AnalysisReportRecord } from "@anvilstack/persistence";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { AuditEventTable, DecisionTable, OverrideTable, ReportTable } from "@/components/admin/data-tables";
import { JsonBlock } from "@/components/admin/json-block";
import { OverrideForm } from "@/components/admin/override-form";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { formatDate, shortMiddle } from "@/components/admin/format";
import { requestLlmReviewAction } from "@/lib/actions";
import { compareAnalysisReports, selectAnalysisComparisonReports } from "@/lib/admin-api";
import { analysisReportComparisonUrl, countActions, getPackageReview, getPersistence, hasPackageReviewEvidence } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PackageReviewPage({ params, searchParams }: { params: Promise<{ segments: string[] }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const isAdmin = await isAdminSession();
  if (!isAdmin) return <LoginPanel />;

  const { segments } = await params;
  const decodedSegments = segments.map((segment) => decodeURIComponent(segment));
  if (decodedSegments.at(-1) === "decisions") {
    const version = decodedSegments.at(-2);
    const packageName = decodedSegments.slice(0, -2).join("/");
    if (!packageName || !version) notFound();
    return <DecisionHistoryView packageName={packageName} version={version} isAdmin={isAdmin} />;
  }
  if (decodedSegments.at(-2) === "reports" && decodedSegments.at(-1) === "compare") {
    const version = decodedSegments.at(-3);
    const packageName = decodedSegments.slice(0, -3).join("/");
    if (!packageName || !version) notFound();
    return <ReportCompareView packageName={packageName} version={version} isAdmin={isAdmin} searchParams={new URLSearchParams(flatten((await searchParams) ?? {}))} />;
  }

  const version = decodedSegments.at(-1);
  const packageName = decodedSegments.slice(0, -1).join("/");
  if (!packageName || !version) notFound();

  const review = await getPackageReview(packageName, version);
  if (!hasPackageReviewEvidence(review)) notFound();
  const latestDecision = review.decisions[0];
  const latestReport = review.reports[0];

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Package review</Badge>
          <h1 className="mt-4 break-words font-mono text-3xl font-semibold tracking-normal">{packageName}@{version}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">Policy outcome, analysed tarball identity, provenance state, and override trail for this package version.</p>
        </section>
        <SummaryTiles
          items={[
            { label: "Current decision", value: latestDecision?.decision.action ?? "none", tone: latestDecision?.decision.action === "block" ? "block" : latestDecision?.decision.action === "allow" ? "allow" : "warn" },
            { label: "Decision score", value: latestDecision?.decision.score ?? 0, tone: (latestDecision?.decision.score ?? 0) >= 95 ? "block" : "warn" },
            { label: "Static signals", value: latestReport?.report.signals.length ?? 0, tone: latestReport?.report.signals.length ? "warn" : "muted" },
            { label: "Weekly downloads", value: review.packageVersion?.weeklyDownloads ?? "unknown", tone: "muted" }
          ]}
        />
        <Section title="Package version" description="Upstream package metadata and cached artefact identity.">
          <Card>
            <CardContent className="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-3">
              <Fact label="Published" value={formatDate(review.packageVersion?.publishedAt)} />
              <Fact label="Weekly downloads" value={review.packageVersion?.weeklyDownloads ?? "unknown"} />
              <Fact label="Integrity" value={review.packageVersion?.integrity ?? "unknown"} mono />
              <Fact label="Shasum" value={review.packageVersion?.shasum ?? "unknown"} mono />
              <Fact label="Cached tarball" value={review.packageVersion?.cachedTarballKey ?? "not cached"} mono />
              <Fact label="Updated" value={formatDate(review.packageVersion?.updatedAt)} />
            </CardContent>
          </Card>
        </Section>
        <Section title="Policy decisions" description="Decision history for this package identity.">
          <div className="flex flex-col gap-4">
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/packages/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/decisions`}>View decision history</Link>
              </Button>
            </div>
            <DecisionTable decisions={review.decisions} />
          </div>
        </Section>
        <Section title="Analysis reports" description="Static analysis reports and artefact keys for the analysed tarball.">
          <div className="flex flex-col gap-4">
            {review.reports.length > 1 ? (
              <div>
                <Button asChild variant="outline" size="sm">
                  <Link href={analysisReportComparisonUrl(review.reports[1], review.reports[0])}>Compare latest reports</Link>
                </Button>
              </div>
            ) : null}
            <ReportTable reports={review.reports} />
          </div>
        </Section>
        {latestReport ? (
          <Section title="Latest signals" description="The static signals that contributed to the current review.">
            <div className="grid gap-3 lg:grid-cols-2">
              {latestReport.report.signals.map((signal) => (
                <Card key={`${signal.code}:${signal.message}`}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="font-mono text-sm">{signal.code}</CardTitle>
                      <Badge variant={signal.severity === "high" || signal.severity === "critical" ? "destructive" : "secondary"}>{signal.severity}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground">{signal.message}</CardContent>
                </Card>
              ))}
            </div>
          </Section>
        ) : null}
        {latestReport?.report.provenance ? (
          <Section title="Provenance" description="Attestation status and subject verification for this analysed package.">
            <ProvenancePanel provenance={latestReport.report.provenance} />
          </Section>
        ) : null}
        <Section title="LLM risk reviews" description="Reviewer-requested model context. Deterministic policy still owns enforcement.">
          <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Request review</CardTitle>
              </CardHeader>
              <CardContent>
                {latestReport && isAdmin ? (
                  <form action={requestLlmReviewAction} className="grid gap-3">
                    <input type="hidden" name="packageName" value={packageName} />
                    <input type="hidden" name="version" value={version} />
                    <input className="h-10 rounded-md border bg-background px-3 text-sm" name="requestedBy" placeholder="requestedBy" defaultValue="admin-ui" />
                    <select className="h-10 rounded-md border bg-background px-3 text-sm" name="priority" defaultValue="high">
                      <option value="high">high</option>
                      <option value="normal">normal</option>
                      <option value="low">low</option>
                    </select>
                    <Button type="submit" disabled={!latestReport || review.llmRiskReviews.length > 0 && !latestReport}>
                      Queue LLM review
                    </Button>
                  </form>
                ) : (
                  <p className="text-sm text-muted-foreground">LLM review is unavailable for this package until an analysis report exists.</p>
                )}
              </CardContent>
            </Card>
            <div className="flex flex-col gap-3">
              {review.llmRiskReviews.length === 0 ? (
                <p className="text-sm text-muted-foreground">No LLM risk reviews yet.</p>
              ) : (
                review.llmRiskReviews.map((record) => (
                  <Card key={`${record.provider}:${record.model}:${record.createdAt}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">{record.provider} / {record.model}</CardTitle>
                        <Badge variant={record.review.riskLevel === "high" || record.review.riskLevel === "critical" ? "destructive" : "secondary"}>{record.review.riskLevel}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <p className="text-muted-foreground">{record.review.summary}</p>
                      <JsonBlock value={record.review} />
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        </Section>
        <Section title="Overrides" description="Audited local exceptions for this package version.">
          <div className="flex flex-col gap-4">
            <OverrideForm packageName={packageName} version={version} />
            <OverrideTable overrides={review.overrides} canManage={isAdmin} />
          </div>
        </Section>
        <Section title="Audit events">
          <AuditEventTable events={review.auditEvents} />
        </Section>
      </div>
    </AdminShell>
  );
}

async function DecisionHistoryView({ packageName, version, isAdmin }: { packageName: string; version: string; isAdmin: boolean }) {
  const decisions = await getPersistence().listPolicyDecisions({ packageName, version, limit: 200 });
  if (decisions.length === 0) notFound();

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Decision history</Badge>
          <h1 className="mt-4 break-words font-mono text-3xl font-semibold tracking-normal">{packageName}@{version}</h1>
        </section>
        <SummaryTiles
          items={[
            { label: "Decisions", value: decisions.length, tone: "muted" },
            { label: "Blocked", value: countActions(decisions, "block"), tone: "block" },
            { label: "Warned", value: countActions(decisions, "warn"), tone: "warn" },
            { label: "Allowed", value: countActions(decisions, "allow"), tone: "allow" }
          ]}
        />
        <Section title="Timeline">
          <DecisionTable decisions={decisions} />
        </Section>
        <Section title="Raw decisions">
          <JsonBlock value={decisions} />
        </Section>
      </div>
    </AdminShell>
  );
}

async function ReportCompareView({ packageName, version, isAdmin, searchParams }: { packageName: string; version: string; isAdmin: boolean; searchParams: URLSearchParams }) {
  const reports = await getPersistence().listAnalysisReports({ packageName, version, limit: 200 });
  const pair = selectAnalysisComparisonReports(reports, searchParams);
  if (!pair) notFound();
  const comparison = compareAnalysisReports(pair.left.report, pair.right.report);

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section>
          <Badge variant="outline">Report comparison</Badge>
          <h1 className="mt-4 break-words font-mono text-3xl font-semibold tracking-normal">{packageName}@{version}</h1>
        </section>
        <SummaryTiles
          items={[
            { label: "Left score", value: pair.left.report.score, tone: "muted" },
            { label: "Right score", value: pair.right.report.score, tone: "muted" },
            { label: "Score delta", value: comparison.scoreDelta, tone: comparison.scoreDelta > 0 ? "warn" : "allow" },
            { label: "Added signals", value: comparison.signals.added.length, tone: comparison.signals.added.length ? "warn" : "muted" }
          ]}
        />
        <Section title="Report identities">
          <div className="grid gap-4 lg:grid-cols-2">
            <IdentityCard label="Left" report={pair.left} />
            <IdentityCard label="Right" report={pair.right} />
          </div>
        </Section>
        <Section title="Signal changes">
          <JsonBlock value={comparison.signals} />
        </Section>
        <Section title="File finding changes">
          <JsonBlock value={comparison.fileFindings} />
        </Section>
      </div>
    </AdminShell>
  );
}

function Fact({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className={mono ? "mt-1 truncate font-mono text-[13px]" : "mt-1 text-sm"} title={typeof value === "string" ? value : undefined}>
        {typeof value === "string" && mono ? shortMiddle(value, 58) : value}
      </div>
    </div>
  );
}

function ProvenancePanel({ provenance }: { provenance: NonNullable<Awaited<ReturnType<typeof getPackageReview>>["reports"][number]["report"]["provenance"]> }) {
  const verification = provenance.verification;
  const verified = verification?.verified === true;
  return (
    <div className="flex flex-col gap-4">
      {verification ? (
        <Alert variant={verified ? "default" : "destructive"} className={verified ? "border-accent/40 bg-accent/10" : undefined}>
          <AlertTitle>{verified ? "Provenance verified" : "Provenance needs review"}</AlertTitle>
          <AlertDescription>{verification.summary ?? (verified ? "The attestation matches the analysed package identity." : "The attestation did not verify cleanly.")}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 p-6 md:grid-cols-2">
          <Fact label="Status" value={provenance.status} />
          <Fact label="Target source" value={provenance.target?.source ?? "unknown"} />
          <Fact label="Target attestation" value={provenance.target?.attestationUrl ?? "none"} mono />
          <Fact label="Previous attestation" value={provenance.previous?.attestationUrl ?? "none"} mono />
          <Fact label="Subject" value={verification?.subjectName ?? "unknown"} mono />
          <Fact label="Expected subject" value={verification?.expectedSubjectName ?? "unknown"} mono />
        </CardContent>
      </Card>
    </div>
  );
}

function IdentityCard({ label, report }: { label: string; report: AnalysisReportRecord }) {
  return (
    <Card>
      <CardContent className="grid gap-2 p-5 text-sm">
        <div className="font-semibold">{label}</div>
        <div className="text-muted-foreground">Created {formatDate(report.createdAt)}</div>
        <div className="font-mono text-xs">analyser {report.analyserVersion ?? report.report.analyserVersion}</div>
        <div className="font-mono text-xs">integrity {report.tarballIntegrity ?? report.report.tarballIntegrity ?? "unknown"}</div>
      </CardContent>
    </Card>
  );
}

function flatten(params: Record<string, string | string[] | undefined>) {
  return Object.fromEntries(Object.entries(params).flatMap(([key, value]) => (Array.isArray(value) ? [[key, value[0] ?? ""]] : value ? [[key, value]] : [])));
}
