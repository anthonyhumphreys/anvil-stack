import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AnalysisReportRecord, AuditEventRecord, NodeBaseReportRecord, OverrideRecord, PolicyDecisionRecord } from "@anvilstack/persistence";
import { actionTone, formatDate, IdentityStack, PackageLink, packageHref, ReasonSummary, Score, shortMiddle } from "./format";
import { revokeOverrideAction } from "@/lib/actions";
import { analysisReportUrl } from "@/lib/admin-data";

export function DecisionTable({ decisions }: { decisions: PolicyDecisionRecord[] }) {
  if (decisions.length === 0) return <p className="text-sm text-muted-foreground">No policy decisions yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Package</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Identity</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map((record) => (
          <TableRow key={`${record.packageName}@${record.version}:${record.createdAt}:${record.analyserVersion ?? ""}`}>
            <TableCell>
              <PackageLink packageName={record.packageName} version={record.version} />
            </TableCell>
            <TableCell>
              <Badge variant={actionTone(record.decision.action)}>{record.decision.action}</Badge>
            </TableCell>
            <TableCell>
              <Score value={record.decision.score} />
            </TableCell>
            <TableCell>
              <ReasonSummary decision={record.decision} />
            </TableCell>
            <TableCell>
              <IdentityStack integrity={record.tarballIntegrity} shasum={record.tarballShasum} analyser={record.analyserVersion} />
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(record.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ReportTable({ reports }: { reports: AnalysisReportRecord[] }) {
  if (reports.length === 0) return <p className="text-sm text-muted-foreground">No analysis reports yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Package</TableHead>
          <TableHead>Analyser</TableHead>
          <TableHead>Signals</TableHead>
          <TableHead>Score</TableHead>
          <TableHead>Identity</TableHead>
          <TableHead>Artifact</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reports.map((record) => (
          <TableRow key={`${record.packageName}@${record.version}:${record.createdAt}:${record.analyserVersion ?? ""}`}>
            <TableCell>
              <Link className="font-mono text-[13px] font-medium underline-offset-4 hover:underline" href={analysisReportUrl(record)}>
                {record.packageName}@{record.version}
              </Link>
            </TableCell>
            <TableCell className="font-mono text-[13px]">{record.report.analyserVersion}</TableCell>
            <TableCell>{record.report.signals.length}</TableCell>
            <TableCell>
              <Score value={record.report.score} />
            </TableCell>
            <TableCell>
              <IdentityStack integrity={record.tarballIntegrity} shasum={record.tarballShasum} analyser={record.analyserVersion} />
            </TableCell>
            <TableCell>
              {record.report.objectKey ? (
                <code className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]" title={record.report.objectKey}>
                  {shortMiddle(record.report.objectKey, 42)}
                </code>
              ) : (
                <span className="text-muted-foreground">not stored</span>
              )}
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(record.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function OverrideTable({ overrides, canManage }: { overrides: OverrideRecord[]; canManage: boolean }) {
  if (overrides.length === 0) return <p className="text-sm text-muted-foreground">No overrides yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Package</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Approved by</TableHead>
          <TableHead>Created</TableHead>
          {canManage ? <TableHead>Manage</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {overrides.map((record) => {
          const status = overrideStatus(record);
          return (
            <TableRow key={`${record.override.packageName}:${record.override.version ?? "*"}:${record.createdAt}`}>
              <TableCell>
                {record.override.version ? (
                  <PackageLink packageName={record.override.packageName} version={record.override.version} />
                ) : (
                  <Link className="font-mono text-[13px] underline-offset-4 hover:underline" href={packageHref(record.override.packageName, "*")}>
                    {record.override.packageName}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={actionTone(record.override.action)}>{record.override.action}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={status === "active" ? "outline" : "secondary"}>{status}</Badge>
              </TableCell>
              <TableCell>{record.override.reason}</TableCell>
              <TableCell>{record.override.approvedBy}</TableCell>
              <TableCell className="text-muted-foreground">{formatDate(record.createdAt)}</TableCell>
              {canManage ? (
                <TableCell>
                  {status === "active" ? (
                    <form action={revokeOverrideAction}>
                      <input type="hidden" name="packageName" value={record.override.packageName} />
                      {record.override.version ? <input type="hidden" name="version" value={record.override.version} /> : null}
                      <input type="hidden" name="revokedBy" value="admin-ui" />
                      <Button size="sm" variant="outline" type="submit">
                        Revoke
                      </Button>
                    </form>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function NodeBaseReportTable({ reports }: { reports: NodeBaseReportRecord[] }) {
  if (reports.length === 0) return <p className="text-sm text-muted-foreground">No Node Base reports yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Project</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {reports.map((record) => (
          <TableRow key={record.id ?? `${record.reportType}:${record.createdAt}`}>
            <TableCell>
              {record.id ? (
                <Link className="underline-offset-4 hover:underline" href={`/node-base/reports/${encodeURIComponent(record.id)}`}>
                  <Badge variant="secondary">{record.reportType}</Badge>
                </Link>
              ) : (
                <Badge variant="secondary">{record.reportType}</Badge>
              )}
            </TableCell>
            <TableCell>{record.source}</TableCell>
            <TableCell>{record.projectName ?? "unknown"}</TableCell>
            <TableCell className="text-muted-foreground">{nodeBaseSummary(record)}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(record.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AuditEventTable({ events }: { events: AuditEventRecord[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No audit events yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Metadata</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <TableRow key={`${event.eventType}:${event.targetId}:${event.createdAt}`}>
            <TableCell>
              <Badge variant="secondary">{event.eventType}</Badge>
            </TableCell>
            <TableCell className="font-mono text-[13px]">{event.targetType}:{event.targetId}</TableCell>
            <TableCell>{event.actor}</TableCell>
            <TableCell>
              <code className="block max-w-[48ch] truncate rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[12px]" title={JSON.stringify(event.metadata)}>
                {JSON.stringify(event.metadata)}
              </code>
            </TableCell>
            <TableCell className="text-muted-foreground">{formatDate(event.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function overrideStatus(record: OverrideRecord) {
  if (record.revokedAt) return "revoked";
  if (record.override.expiresAt && Date.parse(record.override.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function nodeBaseSummary(record: NodeBaseReportRecord) {
  const summary = record.summary ?? (isRecord(record.report) && isRecord(record.report.summary) ? record.report.summary : undefined);
  if (!summary) return "No summary";
  const parts = [
    numberPart(summary, "packagesWithLifecycleScripts", "lifecycle scripts"),
    numberPart(summary, "packagesWithFindings", "packages with findings"),
    numberPart(summary, "highConfidenceFindings", "high findings"),
    numberPart(summary, "mediumConfidenceFindings", "medium findings"),
    numberPart(summary, "outboundConnections", "connections")
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" | ") : JSON.stringify(summary);
}

function numberPart(summary: Record<string, unknown>, key: string, label: string) {
  return typeof summary[key] === "number" ? `${summary[key]} ${label}` : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
