import type { AnalysisReport, LlmRiskReview, Override, PolicyDecision } from "@anvilstack/shared";
import type { AnvilConfig } from "@anvilstack/config";
import { PostgresPersistence } from "./postgres.js";

export { PostgresPersistence } from "./postgres.js";
export * as persistenceSchema from "./schema.js";

export interface AnvilPersistence {
  healthCheck?(): Promise<void>;
  getMetadata(packageName: string): Promise<unknown | undefined>;
  getMetadataRecord(packageName: string): Promise<PackageMetadataRecord | undefined>;
  putMetadata(packageName: string, metadata: unknown): Promise<void>;
  putPackageVersion(version: PackageVersionInput): Promise<void>;
  getPackageVersion(packageName: string, version: string): Promise<PackageVersionRecord | undefined>;
  listPackageVersions(options?: { packageName?: string; limit?: number }): Promise<PackageVersionRecord[]>;
  getPolicyDecision(packageName: string, version: string, policyVersion: string, identity?: PolicyDecisionIdentity): Promise<PolicyDecision | undefined>;
  putPolicyDecision(packageName: string, version: string, policyVersion: string, decision: PolicyDecision, identity?: PolicyDecisionIdentity): Promise<void>;
  deletePolicyDecision(packageName: string, version: string, policyVersion: string): Promise<void>;
  deletePolicyDecisionsForPackage(packageName: string, policyVersion: string): Promise<void>;
  listPolicyDecisions(options?: { actions?: PolicyDecision["action"][]; packageName?: string; version?: string; limit?: number }): Promise<PolicyDecisionRecord[]>;
  getOverride(packageName: string, version: string): Promise<Override | undefined>;
  putOverride(override: Override): Promise<void>;
  revokeOverride(packageName: string, version: string | undefined, revokedBy?: string): Promise<OverrideRecord | undefined>;
  listOverrides(options?: { packageName?: string; version?: string; limit?: number }): Promise<OverrideRecord[]>;
  putAnalysisReport(report: AnalysisReport): Promise<void>;
  getAnalysisReport(packageName: string, version: string, identity?: AnalysisReportIdentity): Promise<AnalysisReport | undefined>;
  listAnalysisReports(options?: { packageName?: string; version?: string; limit?: number }): Promise<AnalysisReportRecord[]>;
  putLlmRiskReview(review: LlmRiskReviewInput): Promise<void>;
  listLlmRiskReviews(options?: { packageName?: string; version?: string; limit?: number; identity?: LlmRiskReviewIdentity }): Promise<LlmRiskReviewRecord[]>;
  putNodeBaseReport(report: NodeBaseReportInput): Promise<NodeBaseReportRecord>;
  getNodeBaseReport(id: string): Promise<NodeBaseReportRecord | undefined>;
  listNodeBaseReports(options?: { reportType?: string; risk?: NodeBaseReportRisk; limit?: number }): Promise<NodeBaseReportRecord[]>;
  putPolicyConfig(config: PolicyConfigInput): Promise<PolicyConfigRecord>;
  getActivePolicyConfig(name: string): Promise<PolicyConfigRecord | undefined>;
  listPolicyConfigs(options?: { name?: string; active?: boolean; limit?: number }): Promise<PolicyConfigRecord[]>;
  putAuditEvent(event: AuditEventInput): Promise<void>;
  listAuditEvents(options?: { targetId?: string; limit?: number }): Promise<AuditEventRecord[]>;
}

export type AnvilPersistenceWithClose = AnvilPersistence & { close?: () => Promise<void> };

export type PolicyDecisionRecord = {
  packageName: string;
  version: string;
  policyVersion: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
  decision: PolicyDecision;
  createdAt?: string;
};

export type PolicyDecisionIdentity = {
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
};

export type AnalysisReportIdentity = PolicyDecisionIdentity;
export type LlmRiskReviewIdentity = PolicyDecisionIdentity;

export type AnalysisReportRecord = {
  packageName: string;
  version: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
  report: AnalysisReport;
  createdAt?: string;
};

export type PackageVersionInput = {
  packageName: string;
  version: string;
  publishedAt?: string;
  tarballUrl?: string;
  integrity?: string;
  shasum?: string;
  weeklyDownloads?: number;
  cachedTarballKey?: string;
};

export type PackageMetadataRecord = {
  packageName: string;
  metadata: unknown;
  updatedAt?: string;
};

export type PackageVersionRecord = PackageVersionInput & {
  createdAt?: string;
  updatedAt?: string;
};

export type LlmRiskReviewInput = {
  packageName: string;
  version: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
  provider: string;
  model: string;
  review: LlmRiskReview;
};

export type LlmRiskReviewRecord = LlmRiskReviewInput & {
  createdAt?: string;
};

export type NodeBaseReportInput = {
  source: string;
  projectName?: string;
  reportType: "dependency" | "ioc" | "lifecycle" | "network" | string;
  summary?: Record<string, unknown>;
  report: unknown;
};

export type NodeBaseReportRecord = NodeBaseReportInput & {
  id?: string;
  createdAt?: string;
};

export type NodeBaseReportRisk = "high" | "medium" | "risky";

export type PolicyConfigInput = {
  name: string;
  version: string;
  config: unknown;
  active?: boolean;
};

export type PolicyConfigRecord = PolicyConfigInput & {
  id?: string;
  active: boolean;
  createdAt?: string;
};

export type OverrideRecord = {
  override: Override;
  createdAt?: string;
  revokedAt?: string;
};

export type AuditEventInput = {
  actor?: string;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
};

export type AuditEventRecord = AuditEventInput & {
  id?: string;
  createdAt?: string;
};

export class MemoryPersistence implements AnvilPersistence {
  private readonly metadata = new Map<string, PackageMetadataRecord>();
  private readonly packageVersions = new Map<string, PackageVersionRecord>();
  private readonly decisions = new Map<string, PolicyDecisionRecord>();
  private readonly overrides = new Map<string, OverrideRecord>();
  private readonly reports = new Map<string, AnalysisReportRecord>();
  private readonly llmRiskReviews: LlmRiskReviewRecord[] = [];
  private readonly nodeBaseReports: NodeBaseReportRecord[] = [];
  private readonly policyConfigs = new Map<string, PolicyConfigRecord>();
  private readonly auditEvents: AuditEventRecord[] = [];

  async healthCheck(): Promise<void> {}

  async getMetadata(packageName: string): Promise<unknown | undefined> {
    return this.metadata.get(packageName)?.metadata;
  }

  async getMetadataRecord(packageName: string): Promise<PackageMetadataRecord | undefined> {
    return this.metadata.get(packageName);
  }

  async putMetadata(packageName: string, metadata: unknown): Promise<void> {
    this.metadata.set(packageName, {
      packageName,
      metadata,
      updatedAt: new Date().toISOString()
    });
  }

  async putPackageVersion(version: PackageVersionInput): Promise<void> {
    const key = packageVersionKey(version.packageName, version.version);
    const existing = this.packageVersions.get(key);
    this.packageVersions.set(key, {
      ...existing,
      ...definedValues(version),
      packageName: version.packageName,
      version: version.version,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  async getPackageVersion(packageName: string, version: string): Promise<PackageVersionRecord | undefined> {
    return this.packageVersions.get(packageVersionKey(packageName, version));
  }

  async listPackageVersions(options: { packageName?: string; limit?: number } = {}): Promise<PackageVersionRecord[]> {
    return [...this.packageVersions.values()]
      .filter((record) => !options.packageName || record.packageName === options.packageName)
      .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async getPolicyDecision(packageName: string, version: string, policyVersion: string, identity: PolicyDecisionIdentity = {}): Promise<PolicyDecision | undefined> {
    const record = this.decisions.get(decisionKey(packageName, version, policyVersion, identity));
    if (!record || isExpiredDecision(record.decision)) return undefined;
    return record.decision;
  }

  async putPolicyDecision(packageName: string, version: string, policyVersion: string, decision: PolicyDecision, identity: PolicyDecisionIdentity = {}): Promise<void> {
    this.decisions.set(decisionKey(packageName, version, policyVersion, identity), {
      packageName,
      version,
      policyVersion,
      ...identity,
      decision,
      createdAt: new Date().toISOString()
    });
  }

  async deletePolicyDecision(packageName: string, version: string, policyVersion: string): Promise<void> {
    for (const record of this.decisions.values()) {
      if (record.packageName === packageName && record.version === version && record.policyVersion === policyVersion) {
        this.decisions.delete(decisionKey(record.packageName, record.version, record.policyVersion, record));
      }
    }
  }

  async deletePolicyDecisionsForPackage(packageName: string, policyVersion: string): Promise<void> {
    for (const record of this.decisions.values()) {
      if (record.packageName === packageName && record.policyVersion === policyVersion) {
        this.decisions.delete(decisionKey(record.packageName, record.version, record.policyVersion, record));
      }
    }
  }

  async listPolicyDecisions(options: { actions?: PolicyDecision["action"][]; packageName?: string; version?: string; limit?: number } = {}): Promise<PolicyDecisionRecord[]> {
    return [...this.decisions.values()]
      .filter((record) => !options.actions?.length || options.actions.includes(record.decision.action))
      .filter((record) => !options.packageName || record.packageName === options.packageName)
      .filter((record) => !options.version || record.version === options.version)
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async getOverride(packageName: string, version: string): Promise<Override | undefined> {
    return [this.overrides.get(`${packageName}@${version}`), this.overrides.get(packageName)]
      .filter((record): record is OverrideRecord => Boolean(record))
      .find((record) => !record.revokedAt && (!record.override.expiresAt || Date.parse(record.override.expiresAt) > Date.now()))?.override;
  }

  async putOverride(override: Override): Promise<void> {
    this.overrides.set(override.version ? `${override.packageName}@${override.version}` : override.packageName, {
      override,
      createdAt: new Date().toISOString()
    });
  }

  async revokeOverride(packageName: string, version: string | undefined, revokedBy?: string): Promise<OverrideRecord | undefined> {
    const key = version ? `${packageName}@${version}` : packageName;
    const record = this.overrides.get(key);
    if (!record || record.revokedAt) return undefined;
    const revokedRecord = {
      ...record,
      revokedAt: new Date().toISOString(),
      override: {
        ...record.override,
        approvedBy: record.override.approvedBy ?? revokedBy
      }
    };
    this.overrides.set(key, revokedRecord);
    return revokedRecord;
  }

  async listOverrides(options: { packageName?: string; version?: string; limit?: number } = {}): Promise<OverrideRecord[]> {
    return [...this.overrides.values()]
      .filter((record) => !options.packageName || record.override.packageName === options.packageName)
      .filter((record) => !options.version || record.override.version === options.version || record.override.version === undefined)
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async putAnalysisReport(report: AnalysisReport): Promise<void> {
    this.reports.set(analysisReportKey(report.packageName, report.version, report), {
      packageName: report.packageName,
      version: report.version,
      tarballIntegrity: report.tarballIntegrity,
      tarballShasum: report.tarballShasum,
      analyserVersion: report.analyserVersion,
      report,
      createdAt: new Date().toISOString()
    });
  }

  async getAnalysisReport(packageName: string, version: string, identity: AnalysisReportIdentity = {}): Promise<AnalysisReport | undefined> {
    const records = [...this.reports.values()]
      .filter((record) => record.packageName === packageName && record.version === version)
      .filter((record) => identityMatches(record, identity))
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    return records[0]?.report;
  }

  async listAnalysisReports(options: { packageName?: string; version?: string; limit?: number } = {}): Promise<AnalysisReportRecord[]> {
    return [...this.reports.values()]
      .filter((record) => !options.packageName || record.packageName === options.packageName)
      .filter((record) => !options.version || record.version === options.version)
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async putLlmRiskReview(review: LlmRiskReviewInput): Promise<void> {
    this.llmRiskReviews.push({
      ...review,
      createdAt: new Date().toISOString()
    });
  }

  async listLlmRiskReviews(options: { packageName?: string; version?: string; limit?: number; identity?: LlmRiskReviewIdentity } = {}): Promise<LlmRiskReviewRecord[]> {
    return [...this.llmRiskReviews]
      .filter((record) => !options.packageName || record.packageName === options.packageName)
      .filter((record) => !options.version || record.version === options.version)
      .filter((record) => !options.identity || identityMatches(record, options.identity))
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async putNodeBaseReport(report: NodeBaseReportInput): Promise<NodeBaseReportRecord> {
    const normalizedSummary = report.summary ?? summaryFromReport(report.report);
    const record = {
      ...report,
      summary: normalizedSummary,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.nodeBaseReports.push(record);
    return record;
  }

  async getNodeBaseReport(id: string): Promise<NodeBaseReportRecord | undefined> {
    return this.nodeBaseReports.find((record) => record.id === id);
  }

  async listNodeBaseReports(options: { reportType?: string; risk?: NodeBaseReportRisk; limit?: number } = {}): Promise<NodeBaseReportRecord[]> {
    return [...this.nodeBaseReports]
      .filter((record) => !options.reportType || record.reportType === options.reportType)
      .filter((record) => nodeBaseRiskMatches(record, options.risk))
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async putPolicyConfig(config: PolicyConfigInput): Promise<PolicyConfigRecord> {
    if (config.active) {
      for (const [key, record] of this.policyConfigs.entries()) {
        if (record.name === config.name) this.policyConfigs.set(key, { ...record, active: false });
      }
    }
    const key = policyConfigKey(config.name, config.version);
    const existing = this.policyConfigs.get(key);
    const record = {
      ...config,
      active: config.active ?? false,
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };
    this.policyConfigs.set(key, record);
    return record;
  }

  async getActivePolicyConfig(name: string): Promise<PolicyConfigRecord | undefined> {
    return (await this.listPolicyConfigs({ name, active: true, limit: 1 }))[0];
  }

  async listPolicyConfigs(options: { name?: string; active?: boolean; limit?: number } = {}): Promise<PolicyConfigRecord[]> {
    return [...this.policyConfigs.values()]
      .filter((record) => !options.name || record.name === options.name)
      .filter((record) => options.active === undefined || record.active === options.active)
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }

  async putAuditEvent(event: AuditEventInput): Promise<void> {
    this.auditEvents.push({
      ...event,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    });
  }

  async listAuditEvents(options: { targetId?: string; limit?: number } = {}): Promise<AuditEventRecord[]> {
    return [...this.auditEvents]
      .filter((record) => !options.targetId || record.targetId === options.targetId)
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
      .slice(0, options.limit ?? 50);
  }
}

function decisionKey(packageName: string, version: string, policyVersion: string, identity: PolicyDecisionIdentity = {}) {
  return `${packageName}@${version}:${policyVersion}:${identity.tarballIntegrity ?? ""}:${identity.tarballShasum ?? ""}:${identity.analyserVersion ?? ""}`;
}

function analysisReportKey(packageName: string, version: string, identity: AnalysisReportIdentity = {}) {
  return `${packageName}@${version}:${identity.tarballIntegrity ?? ""}:${identity.tarballShasum ?? ""}:${identity.analyserVersion ?? ""}`;
}

function identityMatches(
  record: Pick<AnalysisReportRecord, "tarballIntegrity" | "tarballShasum" | "analyserVersion">,
  identity: AnalysisReportIdentity
) {
  return (
    (identity.tarballIntegrity === undefined || record.tarballIntegrity === identity.tarballIntegrity) &&
    (identity.tarballShasum === undefined || record.tarballShasum === identity.tarballShasum) &&
    (identity.analyserVersion === undefined || record.analyserVersion === identity.analyserVersion)
  );
}

function isExpiredDecision(decision: PolicyDecision) {
  return Boolean(decision.expiresAt && Date.parse(decision.expiresAt) <= Date.now());
}

function packageVersionKey(packageName: string, version: string) {
  return `${packageName}@${version}`;
}

function definedValues<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function summaryFromReport(report: unknown): Record<string, unknown> | undefined {
  if (!isRecord(report) || !isRecord(report.summary)) return undefined;
  return report.summary;
}

function nodeBaseRiskMatches(record: NodeBaseReportRecord, risk: NodeBaseReportRisk | undefined) {
  if (!risk) return true;
  const { high, medium } = nodeBaseRiskCounts(record.summary ?? summaryFromReport(record.report));
  if (risk === "high") return high > 0;
  if (risk === "medium") return high === 0 && medium > 0;
  return high > 0 || medium > 0;
}

function nodeBaseRiskCounts(summary: Record<string, unknown> | undefined) {
  return {
    high: aliasedSummaryCount(summary, "high", "highConfidenceFindings"),
    medium: aliasedSummaryCount(summary, "medium", "mediumConfidenceFindings")
  };
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function aliasedSummaryCount(summary: Record<string, unknown> | undefined, primaryKey: string, compatibilityKey: string) {
  return Math.max(numberValue(summary?.[primaryKey]), numberValue(summary?.[compatibilityKey]));
}

function policyConfigKey(name: string, version: string) {
  return `${name}@${version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createPersistence(config: AnvilConfig): AnvilPersistence {
  if (config.PERSISTENCE_DRIVER === "postgres") {
    if (!config.DATABASE_URL) {
      throw new Error("DATABASE_URL is required when PERSISTENCE_DRIVER=postgres");
    }
    return new PostgresPersistence(config.DATABASE_URL);
  }

  return new MemoryPersistence();
}
