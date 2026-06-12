import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { AnalysisReport, LlmRiskReview, Override, PolicyAction, PolicyDecision, PolicyReason } from "@anvilstack/shared";
import type {
  AnalysisReportRecord,
  AnalysisReportIdentity,
  AnvilPersistence,
  AuditEventInput,
  AuditEventRecord,
  LlmRiskReviewIdentity,
  LlmRiskReviewInput,
  LlmRiskReviewRecord,
  NodeBaseReportInput,
  NodeBaseReportRecord,
  NodeBaseReportRisk,
  OverrideRecord,
  PackageVersionInput,
  PackageVersionRecord,
  PolicyConfigInput,
  PolicyConfigRecord,
  PolicyDecisionIdentity,
  PolicyDecisionRecord
} from "./index.js";
import * as schema from "./schema.js";

export class PostgresPersistence implements AnvilPersistence {
  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase<typeof schema>;
  private llmRiskReviewSchemaReady?: Promise<void>;
  private analysisReportIdentitySchemaReady?: Promise<void>;
  private policyDecisionIdentitySchemaReady?: Promise<void>;
  private nodeBaseReportSchemaReady?: Promise<void>;
  private policyConfigSchemaReady?: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    this.db = drizzle(this.pool, { schema });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<void> {
    await this.pool.query("select 1");
  }

  async getMetadata(packageName: string): Promise<unknown | undefined> {
    return (await this.getMetadataRecord(packageName))?.metadata;
  }

  async getMetadataRecord(packageName: string): Promise<{ packageName: string; metadata: unknown; updatedAt?: string } | undefined> {
    const [row] = await this.db.select().from(schema.packages).where(eq(schema.packages.name, packageName)).limit(1);
    if (!row) return undefined;
    return {
      packageName,
      metadata: row.metadataJson,
      updatedAt: row.updatedAt.toISOString()
    };
  }

  async putMetadata(packageName: string, metadata: unknown): Promise<void> {
    await this.db
      .insert(schema.packages)
      .values({
        name: packageName,
        scope: packageName.startsWith("@") ? packageName.split("/")[0] : null,
        metadataJson: metadata,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: schema.packages.name,
        set: {
          metadataJson: metadata,
          updatedAt: new Date()
        }
      });
  }

  async putPackageVersion(version: PackageVersionInput): Promise<void> {
    const packageId = await this.upsertPackage(version.packageName);
    const values = {
      packageId,
      packageName: version.packageName,
      version: version.version,
      publishedAt: version.publishedAt ? new Date(version.publishedAt) : null,
      tarballUrl: version.tarballUrl ?? null,
      integrity: version.integrity ?? null,
      shasum: version.shasum ?? null,
      weeklyDownloads: version.weeklyDownloads ?? null,
      cachedTarballKey: version.cachedTarballKey ?? null,
      updatedAt: new Date()
    };

    await this.db
      .insert(schema.packageVersions)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.packageVersions.packageName, schema.packageVersions.version],
        set: {
          publishedAt: sql`coalesce(excluded.published_at, ${schema.packageVersions.publishedAt})`,
          tarballUrl: sql`coalesce(excluded.tarball_url, ${schema.packageVersions.tarballUrl})`,
          integrity: sql`coalesce(excluded.integrity, ${schema.packageVersions.integrity})`,
          shasum: sql`coalesce(excluded.shasum, ${schema.packageVersions.shasum})`,
          weeklyDownloads: sql`coalesce(excluded.weekly_downloads, ${schema.packageVersions.weeklyDownloads})`,
          cachedTarballKey: sql`coalesce(excluded.cached_tarball_key, ${schema.packageVersions.cachedTarballKey})`,
          updatedAt: values.updatedAt
        }
      });
  }

  async getPackageVersion(packageName: string, version: string): Promise<PackageVersionRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.packageVersions)
      .where(and(eq(schema.packageVersions.packageName, packageName), eq(schema.packageVersions.version, version)))
      .limit(1);

    return row ? toPackageVersionRecord(row) : undefined;
  }

  async listPackageVersions(options: { packageName?: string; limit?: number } = {}): Promise<PackageVersionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.packageVersions)
      .where(options.packageName ? eq(schema.packageVersions.packageName, options.packageName) : undefined)
      .orderBy(desc(schema.packageVersions.updatedAt))
      .limit(options.limit ?? 50);

    return rows.map(toPackageVersionRecord);
  }

  async getPolicyDecision(packageName: string, version: string, policyVersion: string, identity: PolicyDecisionIdentity = {}): Promise<PolicyDecision | undefined> {
    await this.ensurePolicyDecisionIdentitySchema();
    const identityKey = policyDecisionIdentityKey(identity);
    const identityConditions = [
      eq(schema.policyDecisions.decisionIdentityKey, identityKey),
      identity.tarballIntegrity !== undefined ? eq(schema.policyDecisions.tarballIntegrity, identity.tarballIntegrity) : isNull(schema.policyDecisions.tarballIntegrity),
      identity.tarballShasum !== undefined ? eq(schema.policyDecisions.tarballShasum, identity.tarballShasum) : isNull(schema.policyDecisions.tarballShasum),
      identity.analyserVersion !== undefined ? eq(schema.policyDecisions.analyserVersion, identity.analyserVersion) : isNull(schema.policyDecisions.analyserVersion)
    ];
    const [row] = await this.db
      .select()
      .from(schema.policyDecisions)
      .where(
        and(
          eq(schema.policyDecisions.packageName, packageName),
          eq(schema.policyDecisions.version, version),
          eq(schema.policyDecisions.policyVersion, policyVersion),
          or(isNull(schema.policyDecisions.expiresAt), sql`${schema.policyDecisions.expiresAt} > now()`),
          ...identityConditions
        )
      )
      .limit(1);

    if (!row) return undefined;

    return {
      action: row.action as PolicyAction,
      score: row.score,
      reasons: row.reasonsJson as PolicyReason[],
      explanation: row.explanation,
      expiresAt: row.expiresAt?.toISOString()
    };
  }

  async putPolicyDecision(packageName: string, version: string, policyVersion: string, decision: PolicyDecision, identity: PolicyDecisionIdentity = {}): Promise<void> {
    await this.ensurePolicyDecisionIdentitySchema();
    const identityKey = policyDecisionIdentityKey(identity);
    await this.db
      .insert(schema.policyDecisions)
      .values({
        packageName,
        version,
        action: decision.action,
        score: decision.score,
        reasonsJson: decision.reasons,
        explanation: decision.explanation,
        policyVersion,
        decisionIdentityKey: identityKey,
        tarballIntegrity: identity.tarballIntegrity ?? null,
        tarballShasum: identity.tarballShasum ?? null,
        analyserVersion: identity.analyserVersion ?? null,
        expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null
      })
      .onConflictDoUpdate({
        target: [
          schema.policyDecisions.packageName,
          schema.policyDecisions.version,
          schema.policyDecisions.policyVersion,
          schema.policyDecisions.decisionIdentityKey
        ],
        set: {
          action: decision.action,
          score: decision.score,
          reasonsJson: decision.reasons,
          explanation: decision.explanation,
          decisionIdentityKey: identityKey,
          tarballIntegrity: identity.tarballIntegrity ?? null,
          tarballShasum: identity.tarballShasum ?? null,
          analyserVersion: identity.analyserVersion ?? null,
          expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null,
          createdAt: new Date()
        }
      });
  }

  async deletePolicyDecision(packageName: string, version: string, policyVersion: string): Promise<void> {
    await this.db
      .delete(schema.policyDecisions)
      .where(
        and(
          eq(schema.policyDecisions.packageName, packageName),
          eq(schema.policyDecisions.version, version),
          eq(schema.policyDecisions.policyVersion, policyVersion)
        )
      );
  }

  async deletePolicyDecisionsForPackage(packageName: string, policyVersion: string): Promise<void> {
    await this.db
      .delete(schema.policyDecisions)
      .where(and(eq(schema.policyDecisions.packageName, packageName), eq(schema.policyDecisions.policyVersion, policyVersion)));
  }

  async listPolicyDecisions(options: { actions?: PolicyDecision["action"][]; packageName?: string; version?: string; limit?: number } = {}): Promise<PolicyDecisionRecord[]> {
    await this.ensurePolicyDecisionIdentitySchema();
    const conditions = [
      options.actions?.length ? inArray(schema.policyDecisions.action, options.actions) : undefined,
      options.packageName ? eq(schema.policyDecisions.packageName, options.packageName) : undefined,
      options.version ? eq(schema.policyDecisions.version, options.version) : undefined
    ].filter((condition): condition is SQL => Boolean(condition));
    const rows = await this.db
      .select()
      .from(schema.policyDecisions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.policyDecisions.createdAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({
      packageName: row.packageName,
      version: row.version,
      policyVersion: row.policyVersion,
      tarballIntegrity: row.tarballIntegrity ?? undefined,
      tarballShasum: row.tarballShasum ?? undefined,
      analyserVersion: row.analyserVersion ?? undefined,
      decision: {
        action: row.action as PolicyAction,
        score: row.score,
        reasons: row.reasonsJson as PolicyReason[],
        explanation: row.explanation,
        expiresAt: row.expiresAt?.toISOString()
      },
      createdAt: row.createdAt.toISOString()
    }));
  }

  async getOverride(packageName: string, version: string): Promise<Override | undefined> {
    const now = new Date();
    const [row] = await this.db
      .select()
      .from(schema.overrides)
      .where(
        and(
          eq(schema.overrides.packageName, packageName),
          or(eq(schema.overrides.version, version), isNull(schema.overrides.version)),
          isNull(schema.overrides.revokedAt),
          or(isNull(schema.overrides.expiresAt), sql`${schema.overrides.expiresAt} > ${now}`)
        )
      )
      .orderBy(desc(schema.overrides.createdAt))
      .limit(1);

    if (!row) return undefined;

    return {
      packageName: row.packageName,
      version: row.version ?? undefined,
      action: row.action as PolicyAction,
      reason: row.reason,
      approvedBy: row.approvedBy ?? undefined,
      expiresAt: row.expiresAt?.toISOString()
    };
  }

  async putOverride(override: Override): Promise<void> {
    await this.db.insert(schema.overrides).values({
      packageName: override.packageName,
      version: override.version ?? null,
      action: override.action,
      reason: override.reason,
      approvedBy: override.approvedBy,
      expiresAt: override.expiresAt ? new Date(override.expiresAt) : null
    });
  }

  async revokeOverride(packageName: string, version: string | undefined, revokedBy?: string): Promise<OverrideRecord | undefined> {
    const [row] = await this.db
      .update(schema.overrides)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.overrides.packageName, packageName), version ? eq(schema.overrides.version, version) : isNull(schema.overrides.version), isNull(schema.overrides.revokedAt)))
      .returning();

    if (!row) return undefined;
    return {
      override: {
        packageName: row.packageName,
        version: row.version ?? undefined,
        action: row.action as PolicyAction,
        reason: row.reason,
        approvedBy: row.approvedBy ?? revokedBy,
        expiresAt: row.expiresAt?.toISOString()
      },
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString()
    };
  }


  async listOverrides(options: { packageName?: string; version?: string; limit?: number } = {}): Promise<OverrideRecord[]> {
    const conditions = [
      options.packageName ? eq(schema.overrides.packageName, options.packageName) : undefined,
      options.version ? or(eq(schema.overrides.version, options.version), isNull(schema.overrides.version)) : undefined
    ].filter((condition): condition is SQL => Boolean(condition));
    const rows = await this.db
      .select()
      .from(schema.overrides)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.overrides.createdAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({
      override: {
        packageName: row.packageName,
        version: row.version ?? undefined,
        action: row.action as PolicyAction,
        reason: row.reason,
        approvedBy: row.approvedBy ?? undefined,
        expiresAt: row.expiresAt?.toISOString()
      },
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString()
    }));
  }

  async putAnalysisReport(report: AnalysisReport): Promise<void> {
    await this.ensureAnalysisReportIdentitySchema();
    const identityKey = analysisReportIdentityKey(report);
    await this.db
      .insert(schema.analysisReports)
      .values({
        packageName: report.packageName,
        version: report.version,
        analyserVersion: report.analyserVersion,
        policyVersion: report.policyVersion,
        reportIdentityKey: identityKey,
        tarballIntegrity: report.tarballIntegrity ?? null,
        tarballShasum: report.tarballShasum ?? null,
        score: report.score,
        signalsJson: report.signals,
        manifestDiffJson: report.manifestDiff,
        dependencyDiffJson: report.dependencyDiff,
        fileDiffJson: report.fileFindings,
        reportJson: report
      })
      .onConflictDoUpdate({
        target: [
          schema.analysisReports.packageName,
          schema.analysisReports.version,
          schema.analysisReports.policyVersion,
          schema.analysisReports.reportIdentityKey
        ],
        set: {
          analyserVersion: report.analyserVersion,
          tarballIntegrity: report.tarballIntegrity ?? null,
          tarballShasum: report.tarballShasum ?? null,
          score: report.score,
          signalsJson: report.signals,
          manifestDiffJson: report.manifestDiff,
          dependencyDiffJson: report.dependencyDiff,
          fileDiffJson: report.fileFindings,
          reportJson: report,
          createdAt: new Date()
        }
      });
  }

  async getAnalysisReport(packageName: string, version: string, identity: AnalysisReportIdentity = {}): Promise<AnalysisReport | undefined> {
    await this.ensureAnalysisReportIdentitySchema();
    const conditions = [
      eq(schema.analysisReports.packageName, packageName),
      eq(schema.analysisReports.version, version),
      identity.tarballIntegrity ? eq(schema.analysisReports.tarballIntegrity, identity.tarballIntegrity) : undefined,
      identity.tarballShasum ? eq(schema.analysisReports.tarballShasum, identity.tarballShasum) : undefined,
      identity.analyserVersion ? eq(schema.analysisReports.analyserVersion, identity.analyserVersion) : undefined
    ].filter((condition): condition is SQL => Boolean(condition));
    const [row] = await this.db
      .select()
      .from(schema.analysisReports)
      .where(and(...conditions))
      .orderBy(desc(schema.analysisReports.createdAt))
      .limit(1);

    return (row?.reportJson as AnalysisReport | undefined) ?? undefined;
  }

  async listAnalysisReports(options: { packageName?: string; version?: string; limit?: number } = {}): Promise<AnalysisReportRecord[]> {
    await this.ensureAnalysisReportIdentitySchema();
    const conditions = [
      options.packageName ? eq(schema.analysisReports.packageName, options.packageName) : undefined,
      options.version ? eq(schema.analysisReports.version, options.version) : undefined
    ].filter((condition): condition is SQL => Boolean(condition));
    const rows = await this.db
      .select()
      .from(schema.analysisReports)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.analysisReports.createdAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({
      packageName: row.packageName,
      version: row.version,
      tarballIntegrity: row.tarballIntegrity ?? undefined,
      tarballShasum: row.tarballShasum ?? undefined,
      analyserVersion: row.analyserVersion,
      report: row.reportJson as AnalysisReport,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async putLlmRiskReview(review: LlmRiskReviewInput): Promise<void> {
    await this.ensureLlmRiskReviewSchema();
    await this.db.insert(schema.llmRiskReviews).values({
      packageName: review.packageName,
      version: review.version,
      tarballIntegrity: review.tarballIntegrity ?? null,
      tarballShasum: review.tarballShasum ?? null,
      analyserVersion: review.analyserVersion ?? null,
      provider: review.provider,
      model: review.model,
      riskLevel: review.review.riskLevel,
      confidence: review.review.confidence,
      reviewJson: review.review
    });
  }

  async listLlmRiskReviews(options: { packageName?: string; version?: string; limit?: number; identity?: LlmRiskReviewIdentity } = {}): Promise<LlmRiskReviewRecord[]> {
    await this.ensureLlmRiskReviewSchema();
    const conditions = [
      options.packageName ? eq(schema.llmRiskReviews.packageName, options.packageName) : undefined,
      options.version ? eq(schema.llmRiskReviews.version, options.version) : undefined,
      options.identity?.tarballIntegrity ? eq(schema.llmRiskReviews.tarballIntegrity, options.identity.tarballIntegrity) : undefined,
      options.identity?.tarballShasum ? eq(schema.llmRiskReviews.tarballShasum, options.identity.tarballShasum) : undefined,
      options.identity?.analyserVersion ? eq(schema.llmRiskReviews.analyserVersion, options.identity.analyserVersion) : undefined
    ].filter((condition): condition is SQL => Boolean(condition));
    const rows = await this.db
      .select()
      .from(schema.llmRiskReviews)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(schema.llmRiskReviews.createdAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({
      packageName: row.packageName,
      version: row.version,
      tarballIntegrity: row.tarballIntegrity ?? undefined,
      tarballShasum: row.tarballShasum ?? undefined,
      analyserVersion: row.analyserVersion ?? undefined,
      provider: row.provider,
      model: row.model,
      review: row.reviewJson as LlmRiskReview,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async putNodeBaseReport(report: NodeBaseReportInput): Promise<NodeBaseReportRecord> {
    await this.ensureNodeBaseReportSchema();
    const [row] = await this.db
      .insert(schema.nodeBaseReports)
      .values({
        source: report.source,
        projectName: report.projectName ?? null,
        reportType: report.reportType,
        summaryJson: report.summary ?? summaryFromReport(report.report) ?? null,
        reportJson: report.report
      })
      .returning();

    if (!row) throw new Error("Failed to persist Node Base report");
    return toNodeBaseReportRecord(row);
  }

  async getNodeBaseReport(id: string): Promise<NodeBaseReportRecord | undefined> {
    await this.ensureNodeBaseReportSchema();
    const [row] = await this.db.select().from(schema.nodeBaseReports).where(eq(schema.nodeBaseReports.id, id)).limit(1);
    return row ? toNodeBaseReportRecord(row) : undefined;
  }

  async listNodeBaseReports(options: { reportType?: string; risk?: NodeBaseReportRisk; limit?: number } = {}): Promise<NodeBaseReportRecord[]> {
    await this.ensureNodeBaseReportSchema();
    const filters = [
      options.reportType ? eq(schema.nodeBaseReports.reportType, options.reportType) : undefined,
      nodeBaseRiskFilter(options.risk)
    ].filter((filter): filter is SQL => Boolean(filter));
    const rows = await this.db
      .select()
      .from(schema.nodeBaseReports)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.nodeBaseReports.createdAt))
      .limit(options.limit ?? 50);

    return rows.map(toNodeBaseReportRecord);
  }

  async putPolicyConfig(config: PolicyConfigInput): Promise<PolicyConfigRecord> {
    await this.ensurePolicyConfigSchema();
    if (config.active) {
      await this.db.update(schema.policyConfigs).set({ active: false }).where(eq(schema.policyConfigs.name, config.name));
    }

    const [row] = await this.db
      .insert(schema.policyConfigs)
      .values({
        name: config.name,
        version: config.version,
        configJson: config.config,
        active: config.active ?? false
      })
      .onConflictDoUpdate({
        target: [schema.policyConfigs.name, schema.policyConfigs.version],
        set: {
          configJson: config.config,
          active: config.active ?? false,
          createdAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to persist policy config");
    return toPolicyConfigRecord(row);
  }

  async getActivePolicyConfig(name: string): Promise<PolicyConfigRecord | undefined> {
    await this.ensurePolicyConfigSchema();
    const [row] = await this.db
      .select()
      .from(schema.policyConfigs)
      .where(and(eq(schema.policyConfigs.name, name), eq(schema.policyConfigs.active, true)))
      .orderBy(desc(schema.policyConfigs.createdAt))
      .limit(1);

    return row ? toPolicyConfigRecord(row) : undefined;
  }

  async listPolicyConfigs(options: { name?: string; active?: boolean; limit?: number } = {}): Promise<PolicyConfigRecord[]> {
    await this.ensurePolicyConfigSchema();
    const filters = [
      options.name ? eq(schema.policyConfigs.name, options.name) : undefined,
      options.active !== undefined ? eq(schema.policyConfigs.active, options.active) : undefined
    ].filter((filter): filter is SQL => Boolean(filter));
    const rows = await this.db
      .select()
      .from(schema.policyConfigs)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.policyConfigs.createdAt))
      .limit(options.limit ?? 50);

    return rows.map(toPolicyConfigRecord);
  }

  async putAuditEvent(event: AuditEventInput): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      actor: event.actor,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetId,
      metadataJson: event.metadata
    });
  }

  async listAuditEvents(options: { targetId?: string; limit?: number } = {}): Promise<AuditEventRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(options.targetId ? eq(schema.auditEvents.targetId, options.targetId) : undefined)
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(options.limit ?? 50);

    return rows.map((row) => ({
      id: row.id,
      actor: row.actor ?? undefined,
      eventType: row.eventType,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: (row.metadataJson as Record<string, unknown> | null) ?? undefined,
      createdAt: row.createdAt.toISOString()
    }));
  }

  private async ensureLlmRiskReviewSchema(): Promise<void> {
    this.llmRiskReviewSchemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS llm_risk_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        package_name text NOT NULL,
        version text NOT NULL,
        tarball_integrity text,
        tarball_shasum text,
        analyser_version text,
        provider text NOT NULL,
        model text NOT NULL,
        risk_level text NOT NULL,
        confidence text NOT NULL,
        review_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS tarball_integrity text;
      ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS tarball_shasum text;
      ALTER TABLE llm_risk_reviews ADD COLUMN IF NOT EXISTS analyser_version text;
      CREATE INDEX IF NOT EXISTS llm_risk_reviews_lookup_idx ON llm_risk_reviews(package_name, version);
      CREATE INDEX IF NOT EXISTS llm_risk_reviews_identity_idx ON llm_risk_reviews(package_name, version, tarball_integrity, tarball_shasum, analyser_version);
      CREATE INDEX IF NOT EXISTS llm_risk_reviews_provider_idx ON llm_risk_reviews(provider, model);
    `).then(() => undefined);
    await this.llmRiskReviewSchemaReady;
  }

  private async ensureAnalysisReportIdentitySchema(): Promise<void> {
    this.analysisReportIdentitySchemaReady ??= this.pool.query(`
      ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS report_identity_key text NOT NULL DEFAULT 'legacy';
      ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS tarball_integrity text;
      ALTER TABLE analysis_reports ADD COLUMN IF NOT EXISTS tarball_shasum text;
      UPDATE analysis_reports
        SET report_identity_key = coalesce(tarball_integrity, '') || '|' || coalesce(tarball_shasum, '') || '|' || coalesce(analyser_version, '')
        WHERE report_identity_key = 'legacy';
      ALTER TABLE analysis_reports ALTER COLUMN report_identity_key SET DEFAULT '||';
      DELETE FROM analysis_reports a
        USING analysis_reports b
        WHERE a.package_name = b.package_name
          AND a.version = b.version
          AND a.policy_version = b.policy_version
          AND a.report_identity_key = b.report_identity_key
          AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id));
      CREATE UNIQUE INDEX IF NOT EXISTS analysis_reports_identity_idx
        ON analysis_reports(package_name, version, policy_version, report_identity_key);
    `).then(() => undefined);
    await this.analysisReportIdentitySchemaReady;
  }

  private async ensurePolicyDecisionIdentitySchema(): Promise<void> {
    this.policyDecisionIdentitySchemaReady ??= this.pool.query(`
      ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS tarball_integrity text;
      ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS tarball_shasum text;
      ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS analyser_version text;
      ALTER TABLE policy_decisions ADD COLUMN IF NOT EXISTS decision_identity_key text NOT NULL DEFAULT 'legacy';
      UPDATE policy_decisions
        SET decision_identity_key = coalesce(tarball_integrity, '') || '|' || coalesce(tarball_shasum, '') || '|' || coalesce(analyser_version, '')
        WHERE decision_identity_key = 'legacy';
      ALTER TABLE policy_decisions ALTER COLUMN decision_identity_key SET DEFAULT '||';
      ALTER TABLE policy_decisions DROP CONSTRAINT IF EXISTS policy_decisions_package_name_version_policy_version_key;
      DROP INDEX IF EXISTS policy_decisions_lookup_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS policy_decisions_lookup_idx
        ON policy_decisions(package_name, version, policy_version, decision_identity_key);
      CREATE INDEX IF NOT EXISTS policy_decisions_package_version_idx
        ON policy_decisions(package_name, version, policy_version);
    `).then(() => undefined);
    await this.policyDecisionIdentitySchemaReady;
  }

  private async ensureNodeBaseReportSchema(): Promise<void> {
    this.nodeBaseReportSchemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS node_base_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        source text NOT NULL,
        project_name text,
        report_type text NOT NULL,
        summary_json jsonb,
        report_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS node_base_reports_created_idx ON node_base_reports(created_at);
      CREATE INDEX IF NOT EXISTS node_base_reports_type_idx ON node_base_reports(report_type);
    `).then(() => undefined);
    await this.nodeBaseReportSchemaReady;
  }

  private async ensurePolicyConfigSchema(): Promise<void> {
    this.policyConfigSchemaReady ??= this.pool.query(`
      CREATE TABLE IF NOT EXISTS policy_configs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        version text NOT NULL,
        config_json jsonb NOT NULL,
        active boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS policy_configs_name_version_idx ON policy_configs(name, version);
      CREATE INDEX IF NOT EXISTS policy_configs_active_idx ON policy_configs(name, active);
    `).then(() => undefined);
    await this.policyConfigSchemaReady;
  }

  private async upsertPackage(packageName: string): Promise<string> {
    const [row] = await this.db
      .insert(schema.packages)
      .values({
        name: packageName,
        scope: packageName.startsWith("@") ? packageName.split("/")[0] : null,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: schema.packages.name,
        set: { updatedAt: new Date() }
      })
      .returning({ id: schema.packages.id });

    if (!row) throw new Error(`Failed to upsert package ${packageName}`);
    return row.id;
  }
}

type PackageVersionRow = typeof schema.packageVersions.$inferSelect;
type NodeBaseReportRow = typeof schema.nodeBaseReports.$inferSelect;
type PolicyConfigRow = typeof schema.policyConfigs.$inferSelect;

function toPackageVersionRecord(row: PackageVersionRow): PackageVersionRecord {
  return {
    packageName: row.packageName,
    version: row.version,
    publishedAt: row.publishedAt?.toISOString(),
    tarballUrl: row.tarballUrl ?? undefined,
    integrity: row.integrity ?? undefined,
    shasum: row.shasum ?? undefined,
    weeklyDownloads: row.weeklyDownloads ?? undefined,
    cachedTarballKey: row.cachedTarballKey ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toNodeBaseReportRecord(row: NodeBaseReportRow): NodeBaseReportRecord {
  return {
    id: row.id,
    source: row.source,
    projectName: row.projectName ?? undefined,
    reportType: row.reportType,
    summary: (row.summaryJson as Record<string, unknown> | null) ?? undefined,
    report: row.reportJson,
    createdAt: row.createdAt.toISOString()
  };
}

function toPolicyConfigRecord(row: PolicyConfigRow): PolicyConfigRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    config: row.configJson,
    active: row.active,
    createdAt: row.createdAt.toISOString()
  };
}

function summaryFromReport(report: unknown): Record<string, unknown> | undefined {
  if (!isRecord(report) || !isRecord(report.summary)) return undefined;
  return report.summary;
}

function nodeBaseRiskFilter(risk: NodeBaseReportRisk | undefined): SQL | undefined {
  if (!risk) return undefined;
  const high = nodeBaseRiskCountSql("high", "highConfidenceFindings");
  const medium = nodeBaseRiskCountSql("medium", "mediumConfidenceFindings");
  if (risk === "high") return sql`${high} > 0`;
  if (risk === "medium") return sql`${high} = 0 and ${medium} > 0`;
  return sql`(${high} > 0 or ${medium} > 0)`;
}

function nodeBaseRiskCountSql(summaryKey: string, compatibilityKey: string): SQL<number> {
  const primary = nodeBaseSummaryNumberSql(summaryKey);
  const compatibility = nodeBaseSummaryNumberSql(compatibilityKey);
  return sql<number>`greatest(${primary}, ${compatibility})`;
}

function nodeBaseSummaryNumberSql(summaryKey: string): SQL<number> {
  const value = sql`${schema.nodeBaseReports.summaryJson}->>${summaryKey}`;
  return sql<number>`case when ${value} ~ '^[0-9]+$' then (${value})::int else 0 end`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function policyDecisionIdentityKey(identity: PolicyDecisionIdentity = {}) {
  return [identity.tarballIntegrity ?? "", identity.tarballShasum ?? "", identity.analyserVersion ?? ""].join("|");
}

function analysisReportIdentityKey(identity: AnalysisReportIdentity = {}) {
  return [identity.tarballIntegrity ?? "", identity.tarballShasum ?? "", identity.analyserVersion ?? ""].join("|");
}
