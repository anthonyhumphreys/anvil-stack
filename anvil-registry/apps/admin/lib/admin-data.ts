import "server-only";

import { loadConfig } from "@anvilstack/config";
import { loadActivePopularPackageIndex } from "@anvilstack/name-squatting";
import { createObjectStore } from "@anvilstack/object-store";
import { createPersistence, type AnvilPersistence, type AnalysisReportRecord, type PolicyDecisionRecord } from "@anvilstack/persistence";
import type { Override } from "@anvilstack/shared";

export const config = loadConfig();

let persistence: AnvilPersistence | undefined;

export function getPersistence() {
  persistence ??= createPersistence(config);
  return persistence;
}

export function getObjectStore() {
  return createObjectStore(config);
}

export async function getDashboardData() {
  const store = getObjectStore();
  const [decisions, reports, nodeBaseReports, overrides, auditEvents, popularPackageIndex] = await Promise.all([
    getPersistence().listPolicyDecisions({ limit: 50 }),
    getPersistence().listAnalysisReports({ limit: 20 }),
    getPersistence().listNodeBaseReports({ limit: 20 }),
    getPersistence().listOverrides({ limit: 20 }),
    getPersistence().listAuditEvents({ limit: 20 }),
    loadActivePopularPackageIndex({
      objectStore: store,
      objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
      indexPath: config.POPULAR_PACKAGE_INDEX_PATH
    })
  ]);

  return { decisions, reports, nodeBaseReports, overrides, auditEvents, popularPackageIndex };
}

export async function getPackageReview(packageName: string, version: string) {
  const persistence = getPersistence();
  const [packageVersion, decisions, reports, llmRiskReviews, overrides, auditEvents] = await Promise.all([
    persistence.getPackageVersion(packageName, version),
    persistence.listPolicyDecisions({ packageName, version, limit: 20 }),
    persistence.listAnalysisReports({ packageName, version, limit: 20 }),
    persistence.listLlmRiskReviews({ packageName, version, limit: 20 }),
    persistence.listOverrides({ packageName, version, limit: 20 }),
    persistence.listAuditEvents({ targetId: `${packageName}@${version}`, limit: 50 })
  ]);

  return { packageName, version, packageVersion, decisions, reports, llmRiskReviews, overrides, auditEvents };
}

export function hasPackageReviewEvidence(review: Awaited<ReturnType<typeof getPackageReview>>) {
  return Boolean(review.packageVersion) || review.decisions.length > 0 || review.reports.length > 0 || review.llmRiskReviews.length > 0 || review.overrides.length > 0 || review.auditEvents.length > 0;
}

export function countActions(decisions: PolicyDecisionRecord[], action: Override["action"]) {
  return decisions.filter((record) => record.decision.action === action).length;
}

export function decisionActionFromSlug(slug: string): Override["action"] | undefined {
  const actions: Record<string, Override["action"]> = {
    allowed: "allow",
    warned: "warn",
    quarantined: "quarantine",
    blocked: "block"
  };
  return actions[slug];
}

export function decisionListTitle(action: Override["action"]) {
  if (action === "allow") return "Allowed Packages";
  if (action === "warn") return "Warned Packages";
  if (action === "quarantine") return "Quarantined Packages";
  return "Blocked Packages";
}

export async function recordEffectivePolicyConfig(persistence: AnvilPersistence, activeConfig = config) {
  return persistence.putPolicyConfig({
    name: "effective",
    version: activeConfig.policy.version,
    active: true,
    config: {
      runtimeMode: activeConfig.RUNTIME_MODE,
      policy: activeConfig.policy
    }
  });
}

export function analysisReportUrl(record: AnalysisReportRecord) {
  const params = new URLSearchParams();
  if (record.tarballIntegrity) params.set("integrity", record.tarballIntegrity);
  if (record.tarballShasum) params.set("shasum", record.tarballShasum);
  if (record.analyserVersion) params.set("analyser", record.analyserVersion);
  const query = params.toString();
  return `/reports/${encodeURIComponent(record.packageName)}/${encodeURIComponent(record.version)}${query ? `?${query}` : ""}`;
}

export function analysisReportArtifactUrl(record: Pick<AnalysisReportRecord, "packageName" | "version" | "tarballIntegrity" | "tarballShasum" | "analyserVersion"> | AnalysisReportRecord["report"]) {
  const params = new URLSearchParams();
  if (record.tarballIntegrity) params.set("integrity", record.tarballIntegrity);
  if (record.tarballShasum) params.set("shasum", record.tarballShasum);
  if (record.analyserVersion) params.set("analyser", record.analyserVersion);
  const query = params.toString();
  return `/api/reports/${encodeURIComponent(record.packageName)}/${encodeURIComponent(record.version)}/artifact${query ? `?${query}` : ""}`;
}

export function analysisReportComparisonUrl(left: AnalysisReportRecord, right: AnalysisReportRecord) {
  const params = new URLSearchParams();
  if (left.tarballIntegrity ?? left.report.tarballIntegrity) params.set("leftIntegrity", left.tarballIntegrity ?? left.report.tarballIntegrity ?? "");
  if (left.tarballShasum ?? left.report.tarballShasum) params.set("leftShasum", left.tarballShasum ?? left.report.tarballShasum ?? "");
  params.set("leftAnalyser", left.analyserVersion ?? left.report.analyserVersion);
  if (right.tarballIntegrity ?? right.report.tarballIntegrity) params.set("rightIntegrity", right.tarballIntegrity ?? right.report.tarballIntegrity ?? "");
  if (right.tarballShasum ?? right.report.tarballShasum) params.set("rightShasum", right.tarballShasum ?? right.report.tarballShasum ?? "");
  params.set("rightAnalyser", right.analyserVersion ?? right.report.analyserVersion);
  return `/packages/${encodeURIComponent(right.packageName)}/${encodeURIComponent(right.version)}/reports/compare?${params.toString()}`;
}
