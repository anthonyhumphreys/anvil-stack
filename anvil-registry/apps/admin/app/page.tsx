import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AdminShell } from "@/components/admin/shell";
import { LoginPanel } from "@/components/admin/login-panel";
import { AuditEventTable, DecisionTable, NodeBaseReportTable, OverrideTable, ReportTable } from "@/components/admin/data-tables";
import { OverrideForm } from "@/components/admin/override-form";
import { Section, SummaryTiles } from "@/components/admin/summary";
import { config, countActions, getDashboardData } from "@/lib/admin-data";
import { isAdminSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<{ auth?: string }> }) {
  const isAdmin = await isAdminSession();
  const params = await searchParams;
  if (!isAdmin) return <LoginPanel invalid={params?.auth === "invalid"} />;

  const { decisions, reports, nodeBaseReports, overrides, auditEvents, popularPackageIndex } = await getDashboardData();
  const latestDecision = decisions[0];

  return (
    <AdminShell isAdmin={isAdmin}>
      <div className="flex flex-col gap-8">
        <section className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_360px]">
          <div>
            <Badge variant="outline">Policy {config.policy.version}</Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-normal">Registry decisions with receipts.</h1>
            <p className="mt-3 max-w-3xl text-muted-foreground">
              Review deterministic policy outcomes, inspect package evidence, and manage audited overrides without spelunking through raw JSON unless you truly miss it.
            </p>
          </div>
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="text-sm font-medium text-muted-foreground">Latest decision</div>
            {latestDecision ? (
              <div className="mt-3 flex flex-col gap-2">
                <Link className="font-mono text-sm font-semibold underline-offset-4 hover:underline" href={`/packages/${encodeURIComponent(latestDecision.packageName)}/${encodeURIComponent(latestDecision.version)}`}>
                  {latestDecision.packageName}@{latestDecision.version}
                </Link>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">{latestDecision.decision.action}</Badge>
                  <span className="text-sm text-muted-foreground">score {latestDecision.decision.score}</span>
                </div>
                <p className="text-sm text-muted-foreground">{latestDecision.decision.reasons[0]?.message ?? latestDecision.decision.explanation}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No policy decisions have been recorded yet.</p>
            )}
          </div>
        </section>

        <SummaryTiles
          items={[
            { label: "Blocked", value: countActions(decisions, "block"), tone: "block", detail: "install denied" },
            { label: "Quarantined", value: countActions(decisions, "quarantine"), tone: "quarantine", detail: "held for review" },
            { label: "Warned", value: countActions(decisions, "warn"), tone: "warn", detail: "allowed with signal" },
            { label: "Allowed", value: countActions(decisions, "allow"), tone: "allow", detail: "clean path" }
          ]}
        />

        <Section
          title="Recent decisions"
          description="The policy result plus the immutable tarball identity used for the decision."
          action={
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/decisions/blocked">Blocked</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/decisions/quarantined">Quarantined</Link>
              </Button>
            </div>
          }
        >
          <DecisionTable decisions={decisions} />
        </Section>

        <Section title="Analysis reports" description="Static analysis output grouped by analysed package identity.">
          <ReportTable reports={reports} />
        </Section>

        <Section
          title="Node Base reports"
          description="Local install and network observations from Anvil Node Base."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/node-base/reports">View all</Link>
            </Button>
          }
        >
          <NodeBaseReportTable reports={nodeBaseReports} />
        </Section>

        <Section
          title="Popular package index"
          description="Typo-squatting reference data used by name similarity policy checks."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/popular-package-index">Inspect index</Link>
            </Button>
          }
        >
          <SummaryTiles
            items={[
              { label: "Source", value: popularPackageIndex.source, tone: "muted" },
              { label: "Generated", value: popularPackageIndex.generatedAt ?? "unknown", tone: "muted" },
              { label: "Packages", value: popularPackageIndex.popularPackages.length, tone: "allow" },
              { label: "Known confusions", value: Object.keys(popularPackageIndex.knownConfusions).length, tone: "warn" }
            ]}
          />
        </Section>

        <Section title="Overrides" description="Audited exceptions that invalidate cached policy decisions.">
          <div className="flex flex-col gap-4">
            <OverrideForm />
            <OverrideTable overrides={overrides} canManage={isAdmin} />
          </div>
        </Section>

        <Section title="Audit events" description="Operational trail for policy decisions, analyses, overrides, and index changes.">
          <AuditEventTable events={auditEvents} />
        </Section>
      </div>
    </AdminShell>
  );
}
