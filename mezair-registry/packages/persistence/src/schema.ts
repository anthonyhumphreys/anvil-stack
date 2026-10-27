import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const packages = pgTable(
  "packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scope: text("scope"),
    upstreamRegistry: text("upstream_registry").notNull().default("npmjs"),
    metadataJson: jsonb("metadata_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    nameIdx: uniqueIndex("packages_name_idx").on(table.name)
  })
);

export const packageVersions = pgTable(
  "package_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    tarballUrl: text("tarball_url"),
    integrity: text("integrity"),
    shasum: text("shasum"),
    weeklyDownloads: integer("weekly_downloads"),
    cachedTarballKey: text("cached_tarball_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    packageVersionIdx: uniqueIndex("package_versions_package_version_idx").on(table.packageName, table.version)
  })
);

export const analysisReports = pgTable(
  "analysis_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    analyserVersion: text("analyser_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    reportIdentityKey: text("report_identity_key").notNull().default("||"),
    tarballIntegrity: text("tarball_integrity"),
    tarballShasum: text("tarball_shasum"),
    status: text("status").notNull().default("complete"),
    score: integer("score").notNull(),
    signalsJson: jsonb("signals_json").notNull(),
    manifestDiffJson: jsonb("manifest_diff_json"),
    dependencyDiffJson: jsonb("dependency_diff_json"),
    fileDiffJson: jsonb("file_diff_json"),
    reportJson: jsonb("report_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    analysisLookupIdx: index("analysis_reports_lookup_idx").on(table.packageName, table.version),
    analysisVersionIdx: index("analysis_reports_version_idx").on(table.analyserVersion, table.policyVersion),
    analysisIdentityIdx: uniqueIndex("analysis_reports_identity_idx").on(table.packageName, table.version, table.policyVersion, table.reportIdentityKey)
  })
);

export const llmRiskReviews = pgTable(
  "llm_risk_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    tarballIntegrity: text("tarball_integrity"),
    tarballShasum: text("tarball_shasum"),
    analyserVersion: text("analyser_version"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    riskLevel: text("risk_level").notNull(),
    confidence: text("confidence").notNull(),
    reviewJson: jsonb("review_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    llmReviewLookupIdx: index("llm_risk_reviews_lookup_idx").on(table.packageName, table.version),
    llmReviewIdentityIdx: index("llm_risk_reviews_identity_idx").on(table.packageName, table.version, table.tarballIntegrity, table.tarballShasum, table.analyserVersion),
    llmReviewProviderIdx: index("llm_risk_reviews_provider_idx").on(table.provider, table.model)
  })
);

export const nodeBaseReports = pgTable(
  "node_base_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    projectName: text("project_name"),
    reportType: text("report_type").notNull(),
    summaryJson: jsonb("summary_json"),
    reportJson: jsonb("report_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    nodeBaseReportsCreatedIdx: index("node_base_reports_created_idx").on(table.createdAt),
    nodeBaseReportsTypeIdx: index("node_base_reports_type_idx").on(table.reportType)
  })
);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    action: text("action").notNull(),
    score: integer("score").notNull(),
    reasonsJson: jsonb("reasons_json").notNull(),
    explanation: text("explanation").notNull(),
    policyVersion: text("policy_version").notNull(),
    decisionIdentityKey: text("decision_identity_key").notNull().default("||"),
    tarballIntegrity: text("tarball_integrity"),
    tarballShasum: text("tarball_shasum"),
    analyserVersion: text("analyser_version"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    decisionLookupIdx: uniqueIndex("policy_decisions_lookup_idx").on(table.packageName, table.version, table.policyVersion, table.decisionIdentityKey),
    decisionPackageVersionIdx: index("policy_decisions_package_version_idx").on(table.packageName, table.version, table.policyVersion)
  })
);

export const overrides = pgTable(
  "overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageName: text("package_name").notNull(),
    version: text("version"),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => ({
    overrideLookupIdx: index("overrides_lookup_idx").on(table.packageName, table.version)
  })
);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor"),
  eventType: text("event_type").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const policyConfigs = pgTable(
  "policy_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    version: text("version").notNull(),
    configJson: jsonb("config_json").notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    policyConfigsNameVersionIdx: uniqueIndex("policy_configs_name_version_idx").on(table.name, table.version),
    policyConfigsActiveIdx: index("policy_configs_active_idx").on(table.name, table.active)
  })
);
