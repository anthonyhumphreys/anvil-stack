import { createGunzip } from "node:zlib";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { AnvilConfig } from "@anvilstack/config";
import { loadConfig } from "@anvilstack/config";
import { detectNameSquatting, loadActivePopularPackageIndex } from "@anvilstack/name-squatting";
import {
  calculatePackageAgeDays,
  decodeRoutePackageName,
  type DownloadStatsClient,
  NpmDownloadsClient,
  NpmRegistryClient,
  NpmRegistryRouter,
  resolveVersionFromTarballName,
  resolveMetadataVersion,
  rewriteMetadataTarballs,
  filterMetadataVersions,
  toVersionMetadata,
  type NpmPackageMetadata
} from "@anvilstack/npm-registry";
import { createObjectStore, type ObjectStore } from "@anvilstack/object-store";
import { createPersistence, type AnvilPersistence } from "@anvilstack/persistence";
import { evaluatePolicy } from "@anvilstack/policy-engine";
import { createJobQueue, type JobQueue } from "@anvilstack/queue";
import {
  buildAnvilError,
  buildPolicyDecisionAuditEvent,
  isDecisionBlockingInstall,
  nodeBaseReportSubmissionSchema,
  overrideCreateRequestSchema,
  overrideRevokeRequestSchema,
  packageTargetRequestSchema,
  resolveOverrideExpiry,
  type AnalysisJob,
  type PackageTargetRequest,
  type PolicyDecision
} from "@anvilstack/shared";

const metadataPolicyAnalyserVersion = "metadata-policy-2026-05-20.1";
const installPolicyAnalyserVersion = "install-policy-2026-05-21.1";
type ReadinessComponent = "persistence" | "objectStore" | "queue";

export type GatewayDependencies = {
  config?: AnvilConfig;
  persistence?: AnvilPersistence;
  objectStore?: ObjectStore;
  queue?: JobQueue;
  registry?: Pick<NpmRegistryClient, "fetchMetadata" | "fetchTarball">;
  downloadStats?: DownloadStatsClient;
  fetch?: typeof fetch;
};

export function buildGateway(dependencies: GatewayDependencies = {}): FastifyInstance {
  const config = dependencies.config ?? loadConfig();
  const persistence = dependencies.persistence ?? createPersistence(config);
  const objectStore = dependencies.objectStore ?? createObjectStore(config);
  const queue = dependencies.queue ?? createJobQueue(config);
  const popularPackageIndex = loadActivePopularPackageIndex({
    objectStore,
    objectKey: config.POPULAR_PACKAGE_INDEX_OBJECT_KEY,
    indexPath: config.POPULAR_PACKAGE_INDEX_PATH
  });
  const registry =
    dependencies.registry ??
    new NpmRegistryRouter(config.UPSTREAM_NPM_REGISTRIES);
  const downloadStats = dependencies.downloadStats ?? new NpmDownloadsClient({ baseUrl: config.NPM_DOWNLOADS_API });
  const upstreamFetch = dependencies.fetch ?? fetch;

  const app = Fastify({ logger: { name: "anvil-gateway" } });

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!isNpmSecurityAuditPath(request.url) || request.headers["content-encoding"] !== "gzip") return payload;

    const gunzip = createGunzip() as ReturnType<typeof createGunzip> & { receivedEncodedLength?: number };
    gunzip.receivedEncodedLength = 0;
    payload.on("data", (chunk: Buffer) => {
      gunzip.receivedEncodedLength = (gunzip.receivedEncodedLength ?? 0) + chunk.length;
    });
    delete request.headers["content-encoding"];
    return payload.pipe(gunzip);
  });

  app.get("/-/health", async () => ({ ok: true, service: "anvil-gateway" }));
  app.get("/-/ready", async (_request, reply) => {
    const checks = await readinessChecks();
    const ok = checks.every((check) => check.ok);
    const upstreamRegistries = upstreamRegistrySummaries(config);
    if (!ok) return reply.code(503).send({ ok, upstream: config.UPSTREAM_NPM_REGISTRY, upstreamRegistries, checks });
    return { ok, upstream: config.UPSTREAM_NPM_REGISTRY, upstreamRegistries, checks };
  });
  app.get("/-/anvil/policy", async () => ({ runtimeMode: config.RUNTIME_MODE, policy: config.policy, policyConfig: await recordEffectivePolicyConfig() }));
  app.get("/-/anvil/queue", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    return { queue: await queue.getStats() };
  });
  app.post<{ Body: unknown }>("/-/npm/v1/security/advisories/bulk", async (request, reply) => {
    return proxyNpmSecurityRequest("/-/npm/v1/security/advisories/bulk", request.body, reply);
  });
  app.post<{ Body: unknown }>("/-/npm/v1/security/audits/quick", async (request, reply) => {
    return proxyNpmSecurityRequest("/-/npm/v1/security/audits/quick", request.body, reply);
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/analyze", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }

    const parsed = packageTargetRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_ANALYZE_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;
    const targets = analysisTargetsFromBody(body);
    if (targets.length === 0) return reply.code(400).send({ error: "ANVIL_ANALYZE_REQUIRES_TARGETS" });

    const reason = body.reason ?? "manual_review";
    const priority = body.priority ?? "normal";
    const createdAt = new Date().toISOString();
    const jobs = targets.map((target) => ({
      packageName: target.packageName,
      version: target.version,
      requestedBy: body.requestedBy ?? "anvil-gateway",
      reason,
      priority,
      createdAt
    }));

    await Promise.all(jobs.map((job) => queue.enqueueAnalysisJob(job)));
    await Promise.all(
      jobs.map((job) =>
        persistence.putAuditEvent({
          actor: job.requestedBy,
          eventType: "analysis.enqueued",
          targetType: "package",
          targetId: `${job.packageName}@${job.version}`,
          metadata: { source: "gateway", reason: job.reason, priority: job.priority }
        })
      )
    );

    return reply.code(202).send({ ok: true, queued: jobs.length, jobs });
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/llm-review", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    if (!config.policy.llmReview.enabled) {
      return reply.code(409).send({ error: "ANVIL_LLM_REVIEW_DISABLED" });
    }

    const parsed = packageTargetRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_LLM_REVIEW_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;
    const targets = analysisTargetsFromBody(body);
    if (targets.length === 0) return reply.code(400).send({ error: "ANVIL_LLM_REVIEW_REQUIRES_TARGETS" });

    const priority = body.priority ?? "high";
    const createdAt = new Date().toISOString();
    const jobs = targets.map((target) => ({
      packageName: target.packageName,
      version: target.version,
      requestedBy: body.requestedBy ?? "anvil-gateway",
      reason: "manual_review" as const,
      priority,
      runLlmReview: true,
      createdAt
    }));

    await Promise.all(jobs.map((job) => queue.enqueueAnalysisJob(job)));
    await Promise.all(
      jobs.map((job) =>
        persistence.putAuditEvent({
          actor: job.requestedBy,
          eventType: "llm_review.enqueued",
          targetType: "package",
          targetId: `${job.packageName}@${job.version}`,
          metadata: { source: "gateway", priority: job.priority }
        })
      )
    );

    return reply.code(202).send({ ok: true, queued: jobs.length, jobs });
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/explain", async (request, reply) => {
    const parsed = packageTargetRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_EXPLAIN_INVALID", issues: validationIssues(parsed.error) });
    }
    const targets = analysisTargetsFromBody(parsed.data);
    const target = targets[0];
    if (!target) return reply.code(400).send({ error: "ANVIL_EXPLAIN_REQUIRES_TARGET" });

    const result = await explainVersion(target.packageName, target.version);
    if (!result) return reply.code(404).send({ error: "ANVIL_VERSION_NOT_FOUND" });
    return result;
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/override", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    const parsed = overrideCreateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_OVERRIDE_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;

    const expiresAt = resolveOverrideExpiry(body.expiresAt, config.policy.overrides.defaultExpiryDays);
    if (expiresAt === null) return reply.code(400).send({ error: "ANVIL_OVERRIDE_EXPIRES_AT_INVALID" });

    const override = {
      packageName: body.packageName,
      version: body.version,
      action: body.action,
      reason: body.reason,
      approvedBy: body.approvedBy ?? "local-admin",
      expiresAt
    };
    await persistence.putOverride(override);
    if (override.version) await persistence.deletePolicyDecision(override.packageName, override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: override.approvedBy,
      eventType: "override.created",
      targetType: "package",
      targetId: `${override.packageName}${override.version ? `@${override.version}` : ""}`,
      metadata: { source: "gateway", action: override.action, reason: override.reason, expiresAt: override.expiresAt }
    });

    return reply.code(201).send({ ok: true });
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/override/revoke", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    const parsed = overrideRevokeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "ANVIL_OVERRIDE_REVOKE_INVALID", issues: validationIssues(parsed.error) });
    }
    const body = parsed.data;

    const revoked = await persistence.revokeOverride(body.packageName, body.version, body.revokedBy ?? "local-admin");
    if (!revoked) return reply.code(404).send({ error: "ANVIL_OVERRIDE_NOT_FOUND" });

    if (revoked.override.version) await persistence.deletePolicyDecision(revoked.override.packageName, revoked.override.version, config.policy.version);
    else await persistence.deletePolicyDecisionsForPackage(revoked.override.packageName, config.policy.version);
    await persistence.putAuditEvent({
      actor: body.revokedBy ?? "local-admin",
      eventType: "override.revoked",
      targetType: "package",
      targetId: `${revoked.override.packageName}${revoked.override.version ? `@${revoked.override.version}` : ""}`,
      metadata: { source: "gateway", action: revoked.override.action, reason: revoked.override.reason }
    });

    return { ok: true };
  });

  app.post<{
    Body: unknown;
  }>("/-/anvil/node-base/reports", async (request, reply) => {
    if (config.ADMIN_TOKEN && request.headers.authorization !== `Bearer ${config.ADMIN_TOKEN}`) {
      return reply.code(401).send({ error: "ANVIL_ADMIN_TOKEN_REQUIRED" });
    }
    const parsed = nodeBaseReportSubmissionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "ANVIL_NODE_BASE_REPORT_INVALID",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const body = parsed.data;
    const embeddedSummary = body.report.summary;
    const summary = body.summary ?? (embeddedSummary && typeof embeddedSummary === "object" && !Array.isArray(embeddedSummary) ? (embeddedSummary as Record<string, unknown>) : undefined);

    const record = await persistence.putNodeBaseReport({
      source: body.source || "anvil-node-base",
      projectName: body.projectName,
      reportType: body.reportType,
      summary,
      report: body.report
    });
    await persistence.putAuditEvent({
      actor: body.source || "anvil-node-base",
      eventType: "node_base_report.submitted",
      targetType: "node_base_report",
      targetId: record.id ?? `${record.source}:${record.createdAt ?? ""}`,
      metadata: { reportType: record.reportType, projectName: record.projectName }
    });

    return reply.code(201).send({ ok: true, report: record });
  });

  app.get<{ Params: { packageName: string } }>("/:packageName", async (request) => {
    return handleMetadataRequest(request.params.packageName);
  });

  app.get<{ Params: { scope: string; packageName: string } }>("/@:scope/:packageName", async (request) => {
    return handleMetadataRequest(decodeRoutePackageName(request.params.scope, request.params.packageName));
  });

  app.get<{ Params: { scope: string; packageName: string } }>("/:scope/:packageName", async (request, reply) => {
    const packageName = decodeSplitEncodedScopedPackageName(request.params.scope, request.params.packageName);
    if (!packageName) return reply.code(404).send({ error: "ANVIL_ROUTE_NOT_FOUND" });
    return handleMetadataRequest(packageName);
  });

  app.get<{ Params: { packageName: string; tarballName: string } }>("/:packageName/-/:tarballName", async (request, reply) => {
    return handleTarballRequest(request.params.packageName, request.params.tarballName, reply);
  });

  app.get<{ Params: { scope: string; packageName: string; tarballName: string } }>(
    "/@:scope/:packageName/-/:tarballName",
    async (request, reply) => {
      return handleTarballRequest(decodeRoutePackageName(request.params.scope, request.params.packageName), request.params.tarballName, reply);
    }
  );

  app.get<{ Params: { scope: string; packageName: string; tarballName: string } }>(
    "/:scope/:packageName/-/:tarballName",
    async (request, reply) => {
      const packageName = decodeSplitEncodedScopedPackageName(request.params.scope, request.params.packageName);
      if (!packageName) return reply.code(404).send({ error: "ANVIL_ROUTE_NOT_FOUND" });
      return handleTarballRequest(packageName, request.params.tarballName, reply);
    }
  );

  async function handleMetadataRequest(packageName: string) {
    const metadata = await fetchMetadata(packageName);
    const decisions = new Map<string, PolicyDecision>();
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);

    const installRelevantVersions = metadataInstallRelevantVersions(metadata);
    for (const version of Object.keys(metadata.versions ?? {})) {
      const decision = await evaluateAndCache(metadata, version, "metadata_request", weeklyDownloads, {
        enqueueMetadataAnalysis: installRelevantVersions.has(version)
      });
      decisions.set(version, decision);
    }

    const filtered = filterMetadataVersions(metadata, decisions, {
      hideQuarantined: config.policy.hideQuarantinedMetadata || config.RUNTIME_MODE !== "development"
    });

    return rewriteMetadataTarballs(filtered, config.PUBLIC_BASE_URL);
  }

  async function handleTarballRequest(packageName: string, tarballName: string, reply: FastifyReply) {
    const metadata = await fetchMetadata(packageName);
    const version = resolveVersionFromTarballName(metadata, tarballName);
    if (!version) return reply.code(404).send({ error: "ANVIL_TARBALL_VERSION_NOT_FOUND", package: packageName, tarballName });
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);

    const decision = await evaluateAndCache(metadata, version, "tarball_request", weeklyDownloads);
    if (isDecisionBlockingInstall(decision, config.RUNTIME_MODE)) {
      return reply.code(decision.action === "quarantine" ? 423 : 403).send(buildAnvilError(packageName, version, decision));
    }

    const versionMetadata = toVersionMetadata(metadata, version);
    if (!versionMetadata?.tarballUrl) return reply.code(502).send({ error: "ANVIL_UPSTREAM_TARBALL_MISSING", package: packageName, version });

    const cacheIdentity = versionMetadata.integrity ?? versionMetadata.shasum;
    const cacheKey = cacheIdentity ? tarballCacheKey(packageName, version, cacheIdentity) : undefined;
    if (cacheKey) {
      const cached = await objectStore.get(cacheKey);
      if (cached) {
        reply.header("content-type", "application/octet-stream");
        reply.header("x-anvil-cache", "hit");
        return reply.send(Buffer.from(cached));
      }
    }

    const tarball = await registry.fetchTarball(versionMetadata.tarballUrl);
    if (cacheKey) {
      await objectStore.put(cacheKey, tarball);
      await persistence.putPackageVersion({ packageName, version, cachedTarballKey: cacheKey });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("x-anvil-cache", cacheKey ? "miss" : "bypass");
    return reply.send(Buffer.from(tarball));
  }

  async function fetchMetadata(packageName: string): Promise<NpmPackageMetadata> {
    const cached = await persistence.getMetadataRecord(packageName);
    if (cached && isFreshMetadata(cached.updatedAt, config.NPM_METADATA_CACHE_TTL_SECONDS)) return cached.metadata as NpmPackageMetadata;
    const metadata = await registry.fetchMetadata(packageName);
    await persistence.putMetadata(packageName, metadata);
    return metadata;
  }

  async function persistPackageVersions(metadata: NpmPackageMetadata, weeklyDownloads?: number) {
    await Promise.all(
      Object.keys(metadata.versions ?? {}).map(async (version) => {
        const versionMetadata = toVersionMetadata(metadata, version);
        if (!versionMetadata) return;
        await persistence.putPackageVersion({
          packageName: metadata.name,
          version,
          publishedAt: versionMetadata.publishedAt,
          tarballUrl: versionMetadata.tarballUrl,
          integrity: versionMetadata.integrity,
          shasum: versionMetadata.shasum,
          weeklyDownloads
        });
      })
    );
  }

  async function explainVersion(packageName: string, requestedVersion: string) {
    const metadata = await fetchMetadata(packageName);
    const version = resolveMetadataVersion(metadata, requestedVersion);
    if (!version || !metadata.versions?.[version]) return undefined;
    const weeklyDownloads = await safeWeeklyDownloads(packageName);
    await persistPackageVersions(metadata, weeklyDownloads);
    const decision = await evaluateAndCache(metadata, version, "metadata_request", weeklyDownloads);
    const versionMetadata = toVersionMetadata(metadata, version);
    const analysisIdentity = {
      tarballIntegrity: versionMetadata?.integrity,
      tarballShasum: versionMetadata?.shasum
    };
    const analysisReport = await persistence.getAnalysisReport(packageName, version, analysisIdentity);
    const [llmRiskReviews, override] = await Promise.all([
      persistence.listLlmRiskReviews({ packageName, version, limit: 5, identity: { ...analysisIdentity, analyserVersion: analysisReport?.analyserVersion } }),
      persistence.getOverride(packageName, version)
    ]);

    return {
      packageName,
      version,
      decision,
      analysisReport,
      llmRiskReviews,
      override
    };
  }

  async function evaluateAndCache(
    metadata: NpmPackageMetadata,
    version: string,
    reason: "metadata_request" | "tarball_request",
    weeklyDownloads?: number,
    options: { enqueueMetadataAnalysis?: boolean } = {}
  ) {
    const packageName = metadata.name;
    const versionMetadata = toVersionMetadata(metadata, version);
    const analysisIdentity = {
      tarballIntegrity: versionMetadata?.integrity,
      tarballShasum: versionMetadata?.shasum
    };
    const analysisReport = await persistence.getAnalysisReport(packageName, version, analysisIdentity);
    const latestLlmReview = config.policy.llmReview.enabled
      ? await persistence.listLlmRiskReviews({
          packageName,
          version,
          limit: 1,
          identity: { ...analysisIdentity, analyserVersion: analysisReport?.analyserVersion }
        })
      : [];
    const analysisRequired = shouldRequireAnalysisBeforeInstall(reason, analysisReport);
    const decisionIdentity = {
      tarballIntegrity: versionMetadata?.integrity,
      tarballShasum: versionMetadata?.shasum,
      analyserVersion: analysisReport?.analyserVersion ?? (analysisRequired ? installPolicyAnalyserVersion : metadataPolicyAnalyserVersion)
    };
    const existing = await persistence.getPolicyDecision(packageName, version, config.policy.version, decisionIdentity);
    if (existing) {
      if (reason === "tarball_request" && !analysisReport && existing.action === "allow") {
        await enqueueAnalysisJobIfNeeded(packageName, version, reason, "normal", decisionIdentity);
      }
      return existing;
    }

    const similarPackages = detectNameSquatting(packageName, await popularPackageIndex).map((signal) => ({
      name: signal.candidate,
      similarity: signal.similarity,
      weeklyDownloads: signal.weeklyDownloads,
      reasons: signal.reasons,
      suggestedPackage: signal.suggestedPackage
    }));
    const evaluatedAt = new Date().toISOString();
    const packageAgeDays = calculatePackageAgeDays(versionMetadata?.publishedAt, new Date(evaluatedAt));

    const decision = evaluatePolicy({
      packageName,
      version,
      runtimeMode: config.RUNTIME_MODE,
      evaluatedAt,
      metadata: { name: packageName, distTags: metadata["dist-tags"], publishedAt: metadata.time?.created },
      versionMetadata,
      packageAgeDays,
      weeklyDownloads,
      similarPackages,
      override: await persistence.getOverride(packageName, version),
      analysisRequired,
      analysisReport,
      llmRiskReview: latestLlmReview[0]?.review,
      policy: config.policy
    });

    await persistence.putPolicyDecision(packageName, version, config.policy.version, decision, decisionIdentity);
    await persistence.putAuditEvent(buildPolicyDecisionAuditEvent({
      actor: "anvil-gateway",
      source: reason,
      packageName,
      version,
      policyVersion: config.policy.version,
      decision,
      identity: decisionIdentity
    }));

    const shouldEnqueueAnalysis =
      reason === "tarball_request"
        ? decision.action !== "allow" || !analysisReport
        : Boolean(options.enqueueMetadataAnalysis && decision.action !== "allow");
    if (shouldEnqueueAnalysis) {
      await enqueueAnalysisJobIfNeeded(packageName, version, reason, decision.action === "block" ? "high" : "normal", decisionIdentity);
    }

    return decision;
  }

  function shouldRequireAnalysisBeforeInstall(reason: "metadata_request" | "tarball_request", analysisReport: unknown) {
    return reason === "tarball_request" && !analysisReport && config.RUNTIME_MODE !== "development";
  }

  async function enqueueAnalysisJobIfNeeded(
    packageName: string,
    version: string,
    reason: "metadata_request" | "tarball_request",
    priority: AnalysisJob["priority"],
    identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }
  ) {
    if (reason === "tarball_request" && (await hasRecentAnalysisEnqueue(packageName, version, reason, identity))) return;
    await queue.enqueueAnalysisJob({
      packageName,
      version,
      reason,
      priority,
      createdAt: new Date().toISOString()
    });
    if (reason === "tarball_request") {
      await persistence.putAuditEvent({
        actor: "anvil-gateway",
        eventType: "analysis.enqueued",
        targetType: "package",
        targetId: `${packageName}@${version}`,
        metadata: { source: "gateway-auto", reason, priority, ...identity }
      });
    }
  }

  async function hasRecentAnalysisEnqueue(
    packageName: string,
    version: string,
    reason: "metadata_request" | "tarball_request",
    identity: { tarballIntegrity?: string; tarballShasum?: string; analyserVersion?: string }
  ) {
    const events = await persistence.listAuditEvents({ targetId: `${packageName}@${version}`, limit: 25 });
    return events.some((event) => {
      const metadata = event.metadata ?? {};
      return (
        event.eventType === "analysis.enqueued" &&
        metadata.source === "gateway-auto" &&
        metadata.reason === reason &&
        metadata.tarballIntegrity === identity.tarballIntegrity &&
        metadata.tarballShasum === identity.tarballShasum &&
        metadata.analyserVersion === identity.analyserVersion
      );
    });
  }

  async function safeWeeklyDownloads(packageName: string): Promise<number | undefined> {
    try {
      return await downloadStats.getWeeklyDownloads(packageName);
    } catch (error) {
      app.log.warn({ packageName, error }, "Failed to fetch npm download stats");
      return undefined;
    }
  }

  async function readinessChecks(): Promise<Array<{ component: ReadinessComponent; ok: boolean; error?: string }>> {
    const checks: Array<{ component: ReadinessComponent; run?: () => Promise<void> }> = [
      { component: "persistence", run: persistence.healthCheck?.bind(persistence) },
      { component: "objectStore", run: objectStore.healthCheck?.bind(objectStore) },
      { component: "queue", run: queue.healthCheck?.bind(queue) }
    ];

    return Promise.all(
      checks.map(async (check) => {
        try {
          await check.run?.();
          return { component: check.component, ok: true };
        } catch (error) {
          return { component: check.component, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })
    );
  }

  async function recordEffectivePolicyConfig() {
    return persistence.putPolicyConfig({
      name: "effective",
      version: config.policy.version,
      active: true,
      config: {
        runtimeMode: config.RUNTIME_MODE,
        policy: config.policy
      }
    });
  }

  async function proxyNpmSecurityRequest(path: string, body: unknown, reply: FastifyReply) {
    const upstream = npmSecurityAuditUpstream(config);
    const response = await upstreamFetch(`${trimTrailingSlash(upstream.baseUrl)}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(upstream.authToken ? { authorization: `Bearer ${upstream.authToken}` } : {})
      },
      body: JSON.stringify(body ?? {})
    });
    const contentType = response.headers.get("content-type");
    if (contentType) reply.header("content-type", contentType);
    reply.code(response.status);

    const text = await response.text();
    if (!text) return reply.send();
    if (contentType?.includes("application/json")) {
      try {
        return reply.send(JSON.parse(text) as unknown);
      } catch {
        return reply.send(text);
      }
    }
    return reply.send(text);
  }

  return app;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isNpmSecurityAuditPath(path: string) {
  return path === "/-/npm/v1/security/advisories/bulk" || path === "/-/npm/v1/security/audits/quick";
}

function tarballCacheKey(packageName: string, version: string, integrity: string) {
  const safeName = packageName.replace(/^@/, "").replace(/[\/:]/g, "__");
  const safeIntegrity = integrity.replace(/[\/:+=]/g, "_");
  return `tarballs/${safeName}/${version}/${safeIntegrity}.tgz`;
}

function decodeSplitEncodedScopedPackageName(scopeSegment: string, packageName: string): string | undefined {
  const scope = safeDecodeURIComponent(scopeSegment);
  if (!scope.startsWith("@") || scope.length === 1) return undefined;
  return `${scope}/${packageName}`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isFreshMetadata(updatedAt: string | undefined, ttlSeconds: number) {
  if (ttlSeconds === 0) return false;
  if (!updatedAt) return true;
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  return Date.now() - updatedAtMs <= ttlSeconds * 1000;
}

function upstreamRegistrySummaries(config: AnvilConfig) {
  return config.UPSTREAM_NPM_REGISTRIES.map(({ name, baseUrl, scopes }) => ({ name, baseUrl, scopes: scopes ?? [] }));
}

function npmSecurityAuditUpstream(config: AnvilConfig) {
  const configuredBaseUrl = trimTrailingSlash(config.UPSTREAM_NPM_REGISTRY);
  return (
    config.UPSTREAM_NPM_REGISTRIES.find((registry) => trimTrailingSlash(registry.baseUrl) === configuredBaseUrl) ??
    config.UPSTREAM_NPM_REGISTRIES.find((registry) => !registry.scopes?.length) ??
    config.UPSTREAM_NPM_REGISTRIES[0]!
  );
}

function analysisTargetsFromBody(body: PackageTargetRequest) {
  const targets = body.targets?.length ? body.targets : body.packageName ? [{ packageName: body.packageName, version: body.version }] : [];
  const seen = new Set<string>();
  return targets
    .map((target) => ({
      packageName: target.packageName?.trim(),
      version: target.version?.trim() || "latest"
    }))
    .filter((target): target is { packageName: string; version: string } => Boolean(target.packageName))
    .filter((target) => {
      const key = `${target.packageName}@${target.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function metadataInstallRelevantVersions(metadata: NpmPackageMetadata) {
  const versions = new Set<string>();
  for (const version of Object.values(metadata["dist-tags"] ?? {})) {
    if (typeof version === "string" && version) versions.add(version);
  }
  return versions;
}

function validationIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}
