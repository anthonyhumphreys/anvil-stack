#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

type ReadTextFile = (path: string) => Promise<string>;

type PolicyAction = "allow" | "warn" | "quarantine" | "block";

type PolicyReason = {
  code: string;
  message: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  evidence?: Record<string, unknown>;
};

type PolicyDecision = {
  action: PolicyAction;
  score: number;
  reasons: PolicyReason[];
  explanation: string;
  expiresAt?: string;
};

type Override = {
  packageName: string;
  version?: string;
  action: PolicyAction;
  reason: string;
  approvedBy?: string;
  expiresAt?: string;
};

type AnalysisReport = {
  packageName: string;
  version: string;
  analyserVersion: string;
  policyVersion: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  score: number;
  signals: PolicyReason[];
  dependencyDiff?: Record<string, unknown>;
  fileFindings?: Array<{ path: string; code: string; reason: string; severity: PolicyReason["severity"]; evidence?: Record<string, unknown> }>;
  createdAt: string;
};

type LlmRiskReview = {
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  summary: string;
  suspectedRiskTypes: string[];
  recommendedAction: PolicyAction;
};

type PopularPackage = {
  name: string;
  weeklyDownloads?: number;
  aliases?: string[];
};

type PopularPackageIndex = {
  generatedAt?: string;
  source: string;
  popularPackages: PopularPackage[];
  knownConfusions: Record<string, string>;
};

export type CliDependencies = {
  fetch: typeof fetch;
  readFile: ReadTextFile;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
};

export type PackageTarget = {
  packageName: string;
  version: string;
};

export async function run(argv: string[], dependencies: CliDependencies = defaultDependencies()): Promise<number> {
  if (argv[0] === "--") argv = argv.slice(1);
  const [command, ...args] = argv;

  try {
    if (command === "doctor") return await doctor(dependencies);
    if (command === "explain") return await explain(args, dependencies);
    if (command === "scan") return await scan(args, dependencies);
    if (command === "warm") return await warm(args, dependencies);
    if (command === "smoke") return await smoke(args, dependencies);
    if (command === "approve") return await approve(args, dependencies);
    if (command === "revoke") return await revoke(args, dependencies);
    if (command === "llm-review") return await llmReview(args, dependencies);
    if (command === "queue" && args[0] === "status") return await queueStatus(args.slice(1), dependencies);
    if (command === "overrides") return await overrides(args, dependencies);
    if (command === "audit-events") return await auditEvents(args, dependencies);
    if (command === "reports" && args[0] === "compare") return await analysisReportCompare(args.slice(1), dependencies);
    if (command === "reports") return await analysisReport(args, dependencies);
    if (command === "popular-index" && args[0] === "show") return await popularIndexShow(args.slice(1), dependencies);
    if (command === "popular-index" && args[0] === "upload") return await popularIndexUpload(args.slice(1), dependencies);
    if (command === "node-base" && args[0] === "reports") return await nodeBaseReports(args.slice(1), dependencies);
    if (command === "node-base" && args[0] === "report") return await nodeBaseReport(args.slice(1), dependencies);
    if (command === "policy" && args[0] === "test") return await policyTest(args.slice(1), dependencies);

    dependencies.stdout.write(usage());
    return command ? 1 : 0;
  } catch (error) {
    dependencies.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function parseTarget(target: string): PackageTarget {
  const atIndex = target.startsWith("@") ? target.lastIndexOf("@") : target.indexOf("@");
  if (atIndex <= 0) return { packageName: target, version: "latest" };
  return { packageName: target.slice(0, atIndex), version: target.slice(atIndex + 1) };
}

export async function parseLockfile(path: string, read: ReadTextFile = (filePath) => readFile(filePath, "utf8")): Promise<PackageTarget[]> {
  const content = await read(path);
  if (basename(path) === "package-lock.json") return parsePackageLock(content);
  if (basename(path) === "pnpm-lock.yaml") return parsePnpmLock(content);
  if (basename(path) === "yarn.lock") return parseYarnLock(content);
  if (basename(path) === "package.json") return parsePackageJson(content);
  throw new Error(`Unsupported file type: ${path}`);
}

function parsePackageLock(content: string): PackageTarget[] {
  const parsed = JSON.parse(content) as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, PackageLockDependency>;
  };
  const targets = new Map<string, PackageTarget>();

  for (const [path, metadata] of Object.entries(parsed.packages ?? {})) {
    if (!path.startsWith("node_modules/") || !metadata.version) continue;
    const packageName = packageNameFromNodeModulesPath(path);
    if (!packageName) continue;
    targets.set(`${packageName}@${metadata.version}`, { packageName, version: metadata.version });
  }

  collectPackageLockDependencies(parsed.dependencies, targets);

  return [...targets.values()].sort(compareTargets);
}

type PackageLockDependency = {
  version?: string;
  dependencies?: Record<string, PackageLockDependency>;
};

function packageNameFromNodeModulesPath(path: string): string | undefined {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index === -1) return undefined;
  return path.slice(index + marker.length);
}

function collectPackageLockDependencies(dependencies: Record<string, PackageLockDependency> | undefined, targets: Map<string, PackageTarget>) {
  for (const [packageName, metadata] of Object.entries(dependencies ?? {})) {
    if (metadata.version) targets.set(`${packageName}@${metadata.version}`, { packageName, version: metadata.version });
    collectPackageLockDependencies(metadata.dependencies, targets);
  }
}

function parsePnpmLock(content: string): PackageTarget[] {
  const targets = new Map<string, PackageTarget>();
  const importersIndex = content.indexOf("\nimporters:");
  const packagesSection = importersIndex >= 0 ? content.slice(0, importersIndex) : content;
  const packageLine = /^ {2}(\S.+):\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = packageLine.exec(packagesSection))) {
    const target = parsePnpmPackageKey(match[1] ?? "");
    if (!target) continue;
    targets.set(`${target.packageName}@${target.version}`, target);
  }

  return [...targets.values()].sort(compareTargets);
}

function parsePnpmPackageKey(rawKey: string): PackageTarget | undefined {
  let key = rawKey.trim();
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) key = key.slice(1, -1);
  if (key.startsWith("/")) key = key.slice(1);
  key = key.split("(")[0] ?? key;

  const alias = key.match(/^((?:@[^/\s]+\/)?[^@\s]+)@npm:((?:@[^/\s]+\/)?[^@\s]+)@(.+)$/);
  if (alias) return cleanPnpmTarget(alias[2], alias[3]);

  const atIndex = key.startsWith("@") ? key.lastIndexOf("@") : key.indexOf("@");
  if (atIndex <= 0) return undefined;
  return cleanPnpmTarget(key.slice(0, atIndex), key.slice(atIndex + 1));
}

function cleanPnpmTarget(packageName: string | undefined, version: string | undefined): PackageTarget | undefined {
  if (!packageName || !version) return undefined;
  if (version.startsWith("link:") || version.startsWith("file:") || version.startsWith("workspace:")) return undefined;
  return { packageName, version };
}

function parseYarnLock(content: string): PackageTarget[] {
  const targets = new Map<string, PackageTarget>();
  let currentDescriptors: string[] = [];
  let currentVersion: string | undefined;

  const flush = () => {
    if (!currentVersion) return;
    for (const descriptor of currentDescriptors) {
      const packageName = packageNameFromYarnDescriptor(descriptor);
      if (!packageName) continue;
      targets.set(`${packageName}@${currentVersion}`, { packageName, version: currentVersion });
    }
  };

  for (const line of content.split(/\r?\n/)) {
    if (isYarnLockEntryLine(line)) {
      flush();
      currentDescriptors = splitYarnDescriptors(line.slice(0, -1));
      currentVersion = undefined;
      continue;
    }

    const version = line.match(/^\s+version:?\s+"?([^"\s]+)"?\s*$/)?.[1];
    if (version && !isWorkspaceOrFileVersion(version)) currentVersion = version;
  }

  flush();
  return [...targets.values()].sort(compareTargets);
}

function isYarnLockEntryLine(line: string) {
  return Boolean(line) && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#") && line.endsWith(":");
}

function splitYarnDescriptors(raw: string): string[] {
  const descriptors: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (const char of raw) {
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (char === "," && !quote) {
      if (current.trim()) descriptors.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) descriptors.push(current.trim());
  return descriptors;
}

function packageNameFromYarnDescriptor(descriptor: string): string | undefined {
  const key = descriptor.trim();
  if (!key || key === "__metadata") return undefined;
  const npmAlias = key.match(/^((?:@[^/\s]+\/)?[^@\s]+)@npm:((?:@[^/\s]+\/)?[^@\s]+)@.+$/);
  if (npmAlias) return npmAlias[2];
  const npmProtocol = key.match(/^((?:@[^/\s]+\/)?[^@\s]+)@npm:.+$/);
  if (npmProtocol) return npmProtocol[1];
  if (key.includes("@workspace:") || key.includes("@file:") || key.includes("@link:")) return undefined;

  const atIndex = key.startsWith("@") ? key.lastIndexOf("@") : key.indexOf("@");
  if (atIndex <= 0) return undefined;
  return key.slice(0, atIndex);
}

function isWorkspaceOrFileVersion(version: string) {
  return version.startsWith("workspace:") || version.startsWith("file:") || version.startsWith("link:");
}

function parsePackageJson(content: string): PackageTarget[] {
  const parsed = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const targets = new Map<string, PackageTarget>();

  for (const dependencies of [parsed.dependencies, parsed.devDependencies, parsed.optionalDependencies, parsed.peerDependencies]) {
    for (const [packageName, versionRange] of Object.entries(dependencies ?? {})) {
      const target = packageJsonDependencyTarget(packageName, versionRange);
      if (!target) continue;
      targets.set(target.packageName, target);
    }
  }

  return [...targets.values()].sort(compareTargets);
}

function packageJsonDependencyTarget(packageName: string, versionRange: string): PackageTarget | undefined {
  if (versionRange.startsWith("file:") || versionRange.startsWith("link:") || versionRange.startsWith("workspace:")) return undefined;
  const npmAlias = versionRange.match(/^npm:((?:@[^/\s]+\/)?[^@\s]+)(?:@.+)?$/);
  return { packageName: npmAlias?.[1] ?? packageName, version: "latest" };
}

async function doctor(dependencies: CliDependencies): Promise<number> {
  const registryUrl = registryBaseUrl(dependencies.env);
  const [health, readyResponse, policy] = await Promise.all([
    requestJson<{ ok: boolean }>(dependencies, `${registryUrl}/-/health`),
    requestJsonWithStatus<ReadinessResponse>(dependencies, `${registryUrl}/-/ready`),
    requestJson<{ runtimeMode: string }>(dependencies, `${registryUrl}/-/anvil/policy`)
  ]);
  const ready = readyResponse.body;

  dependencies.stdout.write(`Anvil gateway: ${health.ok && ready.ok ? "ok" : "not ready"}\n`);
  dependencies.stdout.write(`Registry: ${registryUrl}\n`);
  dependencies.stdout.write(`Runtime mode: ${policy.runtimeMode}\n`);
  dependencies.stdout.write(`Upstream: ${ready.upstream ?? "(unknown)"}\n`);
  if (ready.checks?.length) {
    dependencies.stdout.write("Readiness checks:\n");
    for (const check of ready.checks) {
      dependencies.stdout.write(`- ${check.component}: ${check.ok ? "ok" : `failed${check.error ? ` (${check.error})` : ""}`}\n`);
    }
  }
  return health.ok && ready.ok ? 0 : 1;
}

async function explain(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil explain package@version");
  const result = await explainTarget(parseTarget(targetArg), dependencies);
  printDecision(result, dependencies);
  return result.decision.action === "block" ? 1 : 0;
}

async function scan(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = firstPositionalArg(args);
  if (!path) throw new Error("Usage: anvil scan package-lock.json|pnpm-lock.yaml|yarn.lock [--queue-analysis]");
  const shouldQueueAnalysis = hasFlag(args, "--queue-analysis");
  const targets = await parseLockfile(path, dependencies.readFile);
  const results = await Promise.all(targets.map((target) => explainTarget(target, dependencies)));
  const risky = results.filter((result) => result.decision.action !== "allow");
  const analysisTargets = results
    .filter((result) => result.decision.action !== "allow" || !result.analysisReport)
    .map((result) => ({ packageName: result.packageName, version: result.version }));

  dependencies.stdout.write(`Scanned ${results.length} package versions from ${path}.\n`);
  if (shouldQueueAnalysis) {
    const queued = await enqueueAnalysisTargets(analysisTargets, dependencies, registryBaseUrl(dependencies.env));
    dependencies.stdout.write(`Queued analysis for ${queued} risky or unreviewed package versions from ${path}.\n`);
  }
  if (risky.length === 0) {
    dependencies.stdout.write("No blocked, quarantined, or warned packages found.\n");
    return 0;
  }

  for (const result of risky) printDecision(result, dependencies);
  return risky.some((result) => result.decision.action === "block" || result.decision.action === "quarantine") ? 1 : 0;
}

async function warm(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0];
  if (!path) throw new Error("Usage: anvil warm package-lock.json|pnpm-lock.yaml|yarn.lock");
  const targets = await parseLockfile(path, dependencies.readFile);
  const packages = [...new Set(targets.map((target) => target.packageName))].sort();
  const registryUrl = registryBaseUrl(dependencies.env);

  await Promise.all(packages.map((packageName) => requestJson(dependencies, `${registryUrl}/${encodePackagePath(packageName)}`)));
  const queued = await enqueueAnalysisTargets(targets, dependencies, registryUrl);
  dependencies.stdout.write(`Warmed metadata and policy decisions for ${packages.length} packages from ${path}.\n`);
  dependencies.stdout.write(`Queued analysis for ${queued} package versions from ${path}.\n`);
  return 0;
}

async function smoke(args: string[], dependencies: CliDependencies): Promise<number> {
  const packageName = args[0] ?? dependencies.env.ANVIL_SMOKE_PACKAGE ?? "is-number";
  const registryUrl = registryBaseUrl(dependencies.env);
  const adminUrl = dependencies.env.ANVIL_ADMIN_URL?.replace(/\/+$/, "");

  dependencies.stdout.write(`Smoke package: ${packageName}\n`);

  const [health, ready] = await Promise.all([
    requestJson<{ ok: boolean }>(dependencies, `${registryUrl}/-/health`),
    requestJson<{ ok: boolean; checks?: Array<{ component: string; ok: boolean }> }>(dependencies, `${registryUrl}/-/ready`)
  ]);
  if (!health.ok || !ready.ok) throw new Error("Gateway is not healthy and ready.");
  dependencies.stdout.write("Gateway health/readiness: ok\n");

  const metadata = await requestJson<SmokePackageMetadata>(dependencies, `${registryUrl}/${encodePackagePath(packageName)}`);
  const version = metadata["dist-tags"]?.latest;
  if (!version) throw new Error(`Metadata for ${packageName} did not include a latest dist-tag.`);
  const versionMetadata = metadata.versions?.[version];
  const tarballUrl = versionMetadata?.dist?.tarball;
  if (!tarballUrl) throw new Error(`Metadata for ${packageName}@${version} did not include a tarball URL.`);
  if (!isGatewayTarballUrl(tarballUrl, registryUrl, packageName)) throw new Error(`Tarball URL was not rewritten through Anvil: ${tarballUrl}`);
  dependencies.stdout.write(`Metadata proxy/rewrite: ok (${packageName}@${version})\n`);

  const tarball = await requestBytes(dependencies, tarballUrl);
  if (tarball.byteLength === 0) throw new Error(`Tarball response for ${packageName}@${version} was empty.`);
  dependencies.stdout.write(`Tarball proxy/cache path: ok (${tarball.byteLength} bytes)\n`);

  if (adminUrl) {
    const adminHealth = await requestJson<{ ok: boolean }>(dependencies, `${adminUrl}/-/health`);
    if (!adminHealth.ok) throw new Error("Admin service health check failed.");
    dependencies.stdout.write("Admin health: ok\n");
  }

  dependencies.stdout.write("Anvil smoke check passed.\n");
  return 0;
}

async function approve(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error('Usage: anvil approve package@version --reason "intentional dependency" [--approved-by reviewer] [--expires-at 2026-06-20T00:00:00Z]');
  const reason = readFlag(args, "--reason");
  if (!reason) throw new Error("Approval requires --reason.");
  const action = readFlag(args, "--action") as "allow" | "warn" | "quarantine" | "block" | undefined;
  const approvedBy = readFlag(args, "--approved-by") ?? "anvil-cli";
  const expiresAt = readFlag(args, "--expires-at");
  const target = parseTarget(targetArg);
  const registryUrl = registryBaseUrl(dependencies.env);

  await requestJson(dependencies, `${registryUrl}/-/anvil/override`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...adminAuthHeader(dependencies.env)
    },
    body: JSON.stringify({ ...target, reason, action: action ?? "allow", approvedBy, ...(expiresAt ? { expiresAt } : {}) })
  });
  dependencies.stdout.write(`Approved override for ${target.packageName}@${target.version}.\n`);
  return 0;
}

async function revoke(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil revoke package@version [--revoked-by reviewer]");
  const revokedBy = readFlag(args, "--revoked-by") ?? "anvil-cli";
  const target = parseTarget(targetArg);
  const registryUrl = registryBaseUrl(dependencies.env);

  await requestJson(dependencies, `${registryUrl}/-/anvil/override/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...adminAuthHeader(dependencies.env)
    },
    body: JSON.stringify({ ...target, revokedBy })
  });
  dependencies.stdout.write(`Revoked override for ${target.packageName}@${target.version}.\n`);
  return 0;
}

async function llmReview(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = args[0];
  if (!targetArg) throw new Error("Usage: anvil llm-review package@version [--requested-by reviewer] [--priority high]");
  const target = parseTarget(targetArg);
  const requestedBy = readFlag(args, "--requested-by") ?? "anvil-cli";
  const priority = readFlag(args, "--priority");
  const registryUrl = registryBaseUrl(dependencies.env);
  const result = await requestJson<{ queued: number; jobs: Array<{ packageName: string; version: string }> }>(dependencies, `${registryUrl}/-/anvil/llm-review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...adminAuthHeader(dependencies.env)
    },
    body: JSON.stringify({ ...target, requestedBy, ...(priority ? { priority } : {}) })
  });

  dependencies.stdout.write(`Queued LLM review for ${target.packageName}@${target.version}.\n`);
  dependencies.stdout.write(`Jobs queued: ${result.queued}\n`);
  return 0;
}

async function queueStatus(_args: string[], dependencies: CliDependencies): Promise<number> {
  const registryUrl = registryBaseUrl(dependencies.env);
  const result = await requestJson<{ queue: AnalysisQueueStats }>(dependencies, `${registryUrl}/-/anvil/queue`, {
    headers: adminAuthHeader(dependencies.env)
  });
  printQueueStatus(result.queue, dependencies);
  return 0;
}

async function overrides(args: string[], dependencies: CliDependencies): Promise<number> {
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams({ limit: readFlag(args, "--limit") ?? "20" });
  const targetArg = readFlag(args, "--target");
  if (targetArg) {
    const target = parseTarget(targetArg);
    params.set("packageName", target.packageName);
    if (target.version !== "latest") params.set("version", target.version);
  }
  addOptionalParam(params, "packageName", readFlag(args, "--package"));
  addOptionalParam(params, "version", readFlag(args, "--version"));

  const result = await requestJson<{ overrides: OverrideRecord[] }>(dependencies, `${adminUrl}/api/overrides?${params.toString()}`, {
    headers: adminAuthHeader(dependencies.env)
  });
  dependencies.stdout.write(`Overrides: ${result.overrides.length}\n`);
  if (result.overrides.length === 0) {
    dependencies.stdout.write("No overrides found.\n");
    return 0;
  }
  for (const record of result.overrides) dependencies.stdout.write(formatOverrideLine(record));
  return 0;
}

async function auditEvents(args: string[], dependencies: CliDependencies): Promise<number> {
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams({ limit: readFlag(args, "--limit") ?? "20" });
  addOptionalParam(params, "targetId", readFlag(args, "--target"));

  const result = await requestJson<{ auditEvents: AuditEventRecord[] }>(dependencies, `${adminUrl}/api/audit-events?${params.toString()}`, {
    headers: adminAuthHeader(dependencies.env)
  });
  dependencies.stdout.write(`Audit events: ${result.auditEvents.length}\n`);
  if (result.auditEvents.length === 0) {
    dependencies.stdout.write("No audit events found.\n");
    return 0;
  }
  for (const event of result.auditEvents) dependencies.stdout.write(formatAuditEventLine(event));
  return 0;
}

async function popularIndexShow(_args: string[], dependencies: CliDependencies): Promise<number> {
  const adminUrl = adminBaseUrl(dependencies.env);
  const index = await requestJson<PopularPackageIndex>(dependencies, `${adminUrl}/api/popular-package-index`, {
    headers: adminAuthHeader(dependencies.env)
  });
  printPopularPackageIndex(index, dependencies);
  return 0;
}

async function popularIndexUpload(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0];
  if (!path) throw new Error("Usage: anvil popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]");
  const generatedAt = readFlag(args, "--generated-at");
  const uploadedBy = readFlag(args, "--uploaded-by") ?? "anvil-cli";
  const index = parsePopularPackageIndex(JSON.parse(await dependencies.readFile(path)) as unknown, path);
  const adminUrl = adminBaseUrl(dependencies.env);
  const result = await requestJson<{ activeKey: string; datedKey: string; index: PopularPackageIndex }>(dependencies, `${adminUrl}/api/popular-package-index`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...adminAuthHeader(dependencies.env)
    },
    body: JSON.stringify({ ...index, ...(generatedAt ? { generatedAt } : index.generatedAt ? { generatedAt: index.generatedAt } : {}), uploadedBy })
  });

  dependencies.stdout.write(`Uploaded popular package index from ${path}.\n`);
  dependencies.stdout.write(`Active key: ${result.activeKey}\n`);
  dependencies.stdout.write(`Dated key: ${result.datedKey}\n`);
  printPopularPackageIndex(result.index, dependencies);
  return 0;
}

async function policyTest(args: string[], dependencies: CliDependencies): Promise<number> {
  const path = args[0] ?? "package.json";
  const targets = await parseLockfile(path, dependencies.readFile);
  const results = await Promise.all(targets.map((target) => explainTarget(target, dependencies)));
  const risky = results.filter((result) => result.decision.action !== "allow");

  dependencies.stdout.write(`Policy ${dependencies.env.POLICY_VERSION ?? "2026-05-20.1"} loaded in ${dependencies.env.RUNTIME_MODE ?? "development"} mode.\n`);
  dependencies.stdout.write(`Tested ${results.length} dependency names from ${path} using latest resolvable versions.\n`);
  dependencies.stdout.write("Use lockfile scan for exact installed versions.\n");

  if (risky.length === 0) {
    dependencies.stdout.write("No blocked, quarantined, or warned dependencies found.\n");
    return 0;
  }

  for (const result of risky) printDecision(result, dependencies);
  return risky.some((result) => result.decision.action === "block" || result.decision.action === "quarantine") ? 1 : 0;
}

async function analysisReport(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = firstPositionalArg(args);
  if (!targetArg) throw new Error("Usage: anvil reports package@version [--integrity sha512-...] [--shasum ...] [--analyser static-v1]");
  const target = parseTarget(targetArg);
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams();
  addOptionalParam(params, "integrity", readFlag(args, "--integrity"));
  addOptionalParam(params, "shasum", readFlag(args, "--shasum"));
  addOptionalParam(params, "analyser", readFlag(args, "--analyser"));
  const query = params.toString();
  const result = await requestJson<{ report: AnalysisReportRecord }>(
    dependencies,
    `${adminUrl}/api/reports/${encodeURIComponent(target.packageName)}/${encodeURIComponent(target.version)}${query ? `?${query}` : ""}`,
    { headers: adminAuthHeader(dependencies.env) }
  );

  printAnalysisReport(result.report, dependencies);
  return hasHighAnalysisRisk(result.report.report) ? 1 : 0;
}

async function analysisReportCompare(args: string[], dependencies: CliDependencies): Promise<number> {
  const targetArg = firstPositionalArg(args);
  if (!targetArg) {
    throw new Error(
      "Usage: anvil reports compare package@version [--left-integrity sha512-old] [--right-integrity sha512-new] [--left-shasum ...] [--right-shasum ...] [--left-analyser static-v1] [--right-analyser static-v1]"
    );
  }
  const target = parseTarget(targetArg);
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams();
  addOptionalParam(params, "leftIntegrity", readFlag(args, "--left-integrity"));
  addOptionalParam(params, "rightIntegrity", readFlag(args, "--right-integrity"));
  addOptionalParam(params, "leftShasum", readFlag(args, "--left-shasum"));
  addOptionalParam(params, "rightShasum", readFlag(args, "--right-shasum"));
  addOptionalParam(params, "leftAnalyser", readFlag(args, "--left-analyser"));
  addOptionalParam(params, "rightAnalyser", readFlag(args, "--right-analyser"));
  const query = params.toString();
  const result = await requestJson<AnalysisReportComparisonResult>(
    dependencies,
    `${adminUrl}/api/packages/${encodeURIComponent(target.packageName)}/${encodeURIComponent(target.version)}/reports/compare${query ? `?${query}` : ""}`,
    { headers: adminAuthHeader(dependencies.env) }
  );

  printAnalysisReportComparison(result, dependencies);
  return result.comparison.signals.added.some(isHighSeverity) || result.comparison.fileFindings.added.some(isHighSeverity) ? 1 : 0;
}

async function nodeBaseReports(args: string[], dependencies: CliDependencies): Promise<number> {
  const reportType = readFlag(args, "--type");
  const risk = readFlag(args, "--risk");
  const limit = readFlag(args, "--limit") ?? "20";
  const adminUrl = adminBaseUrl(dependencies.env);
  const params = new URLSearchParams({ limit });
  if (reportType) params.set("reportType", reportType);
  if (risk) params.set("risk", risk);
  const result = await requestJson<{ reports: NodeBaseReportRecord[] }>(dependencies, `${adminUrl}/api/node-base/reports?${params.toString()}`, {
    headers: adminAuthHeader(dependencies.env)
  });
  const reports = result.reports ?? [];

  dependencies.stdout.write(`Node Base reports: ${reports.length}${reportType ? ` (${reportType})` : ""}${risk ? ` risk=${risk}` : ""}\n`);
  if (reports.length === 0) {
    dependencies.stdout.write("No Node Base reports found.\n");
    return 0;
  }

  for (const report of reports) {
    dependencies.stdout.write(formatNodeBaseReportLine(report));
  }

  const risky = reports.some((report) => nodeBaseReportRisk(report).high > 0);
  return risky ? 1 : 0;
}

async function nodeBaseReport(args: string[], dependencies: CliDependencies): Promise<number> {
  const id = args[0];
  if (!id) throw new Error("Usage: anvil node-base report <id>");
  const adminUrl = adminBaseUrl(dependencies.env);
  const result = await requestJson<{ report: NodeBaseReportRecord }>(dependencies, `${adminUrl}/api/node-base/reports/${encodeURIComponent(id)}`, {
    headers: adminAuthHeader(dependencies.env)
  });
  printNodeBaseReport(result.report, dependencies);
  return nodeBaseReportRisk(result.report).high > 0 ? 1 : 0;
}

async function explainTarget(target: PackageTarget, dependencies: CliDependencies) {
  const registryUrl = registryBaseUrl(dependencies.env);
  return requestJson<ExplainResult>(dependencies, `${registryUrl}/-/anvil/explain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(target)
  });
}

async function enqueueAnalysisTargets(targets: PackageTarget[], dependencies: CliDependencies, registryUrl: string): Promise<number> {
  if (targets.length === 0) return 0;
  const result = await requestJson<{ queued: number }>(dependencies, `${registryUrl}/-/anvil/analyze`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...adminAuthHeader(dependencies.env)
    },
    body: JSON.stringify({ targets, reason: "lockfile_scan", priority: "normal", requestedBy: "anvil-cli" })
  });
  return result.queued ?? targets.length;
}

function printDecision(result: ExplainResult, dependencies: CliDependencies) {
  dependencies.stdout.write(`\nAnvil ${formatAction(result.decision.action)} ${result.packageName}@${result.version}\n`);
  dependencies.stdout.write(`${result.decision.explanation}\n`);
  if (result.decision.reasons.length > 0) {
    dependencies.stdout.write("Reasons:\n");
    for (const reason of result.decision.reasons) dependencies.stdout.write(`- ${reason.message}\n`);
  }
  const suggestedPackages = suggestedPackagesFromDecision(result.decision);
  if (suggestedPackages.length > 0) {
    dependencies.stdout.write("Suggested package:\n");
    for (const packageName of suggestedPackages) dependencies.stdout.write(`- ${packageName}\n`);
  }
  if (result.analysisReport) printAnalysisSummary(result.analysisReport, dependencies);
  if (result.llmRiskReviews?.length) printLlmRiskReviewSummary(result.llmRiskReviews, dependencies);
  if (result.override) {
    dependencies.stdout.write("Active override:\n");
    dependencies.stdout.write(`- ${result.override.action}: ${result.override.reason}\n`);
  }
  if (result.decision.action === "block" || result.decision.action === "quarantine") {
    dependencies.stdout.write(`Override:\n- anvil approve ${result.packageName}@${result.version} --reason "intentional dependency"\n`);
  }
}

function printPopularPackageIndex(index: PopularPackageIndex, dependencies: CliDependencies) {
  dependencies.stdout.write(`Popular package index: ${index.source}\n`);
  dependencies.stdout.write(`Generated: ${index.generatedAt ?? "unknown"}\n`);
  dependencies.stdout.write(`Packages: ${index.popularPackages.length}\n`);
  dependencies.stdout.write(`Known confusions: ${Object.keys(index.knownConfusions).length}\n`);
  for (const record of index.popularPackages.slice(0, 10)) {
    dependencies.stdout.write(`- ${record.name}${record.weeklyDownloads !== undefined ? ` downloads=${record.weeklyDownloads}` : ""}${record.aliases?.length ? ` aliases=${record.aliases.join(",")}` : ""}\n`);
  }
  if (index.popularPackages.length > 10) dependencies.stdout.write(`- ... ${index.popularPackages.length - 10} more packages\n`);
}

function suggestedPackagesFromDecision(decision: PolicyDecision): string[] {
  const suggestions = decision.reasons
    .map((reason) => reason.evidence?.suggestedPackage)
    .filter((packageName): packageName is string => typeof packageName === "string" && packageName.length > 0);
  return [...new Set(suggestions)];
}

function printAnalysisSummary(report: AnalysisReport, dependencies: CliDependencies) {
  dependencies.stdout.write("Analysis:\n");
  dependencies.stdout.write(`- analyser: ${report.analyserVersion}\n`);
  dependencies.stdout.write(`- score: ${report.score}\n`);
  if (report.signals.length > 0) {
    dependencies.stdout.write(`- signals: ${report.signals.map((signal) => signal.code).join(", ")}\n`);
  }
}

function printAnalysisReport(record: AnalysisReportRecord, dependencies: CliDependencies) {
  const report = record.report;
  dependencies.stdout.write(`Analysis report ${record.packageName}@${record.version}\n`);
  dependencies.stdout.write(`Analyser: ${record.analyserVersion ?? report.analyserVersion}\n`);
  dependencies.stdout.write(`Policy: ${report.policyVersion}\n`);
  dependencies.stdout.write(`Score: ${report.score}\n`);
  if (record.createdAt ?? report.createdAt) dependencies.stdout.write(`Created: ${record.createdAt ?? report.createdAt}\n`);
  const integrity = record.tarballIntegrity ?? report.tarballIntegrity;
  const shasum = record.tarballShasum ?? report.tarballShasum;
  if (integrity || shasum) dependencies.stdout.write(`Identity: ${[integrity ? `integrity=${integrity}` : "", shasum ? `shasum=${shasum}` : ""].filter(Boolean).join(" ")}\n`);
  printSignalList("Signals", report.signals, dependencies);
  printDependencyDiff(report.dependencyDiff, dependencies);
  printFileFindings("File findings", report.fileFindings ?? [], dependencies);
}

function printAnalysisReportComparison(result: AnalysisReportComparisonResult, dependencies: CliDependencies) {
  dependencies.stdout.write(`Analysis report comparison ${result.packageName}@${result.version}\n`);
  dependencies.stdout.write(`Left: ${analysisReportIdentity(result.left)} score=${result.left.report.score}\n`);
  dependencies.stdout.write(`Right: ${analysisReportIdentity(result.right)} score=${result.right.report.score}\n`);
  dependencies.stdout.write(`Score delta: ${result.comparison.scoreDelta}\n`);
  printSignalList("Added signals", result.comparison.signals.added, dependencies);
  printSignalList("Removed signals", result.comparison.signals.removed, dependencies);
  printFileFindings("Added file findings", result.comparison.fileFindings.added, dependencies);
  printFileFindings("Removed file findings", result.comparison.fileFindings.removed, dependencies);
}

function printSignalList(title: string, signals: AnalysisSignal[], dependencies: CliDependencies) {
  if (signals.length === 0) {
    dependencies.stdout.write(`${title}: none\n`);
    return;
  }
  dependencies.stdout.write(`${title}:\n`);
  for (const signal of signals.slice(0, 20)) {
    dependencies.stdout.write(`- ${signal.code} [${signal.severity}] ${signal.message}\n`);
  }
  if (signals.length > 20) dependencies.stdout.write(`- ... ${signals.length - 20} more\n`);
}

function printDependencyDiff(diff: Record<string, unknown> | undefined, dependencies: CliDependencies) {
  const rows = dependencyDiffRows(diff);
  if (rows.length === 0) return;
  dependencies.stdout.write("Dependency changes:\n");
  for (const row of rows.slice(0, 20)) {
    dependencies.stdout.write(`- ${row.group} ${row.change} ${row.name}${row.previous ? ` ${row.previous}` : ""}${row.target ? ` -> ${row.target}` : ""}\n`);
  }
  if (rows.length > 20) dependencies.stdout.write(`- ... ${rows.length - 20} more\n`);
}

function printFileFindings(title: string, findings: AnalysisFileFinding[], dependencies: CliDependencies) {
  if (findings.length === 0) {
    dependencies.stdout.write(`${title}: none\n`);
    return;
  }
  dependencies.stdout.write(`${title}:\n`);
  for (const finding of findings.slice(0, 20)) {
    const evidence = formatEvidence(finding.evidence);
    dependencies.stdout.write(`- ${finding.path} ${finding.code} [${finding.severity}] ${finding.reason}${evidence ? ` evidence=${evidence}` : ""}\n`);
  }
  if (findings.length > 20) dependencies.stdout.write(`- ... ${findings.length - 20} more\n`);
}

function printLlmRiskReviewSummary(reviews: LlmRiskReviewRecord[], dependencies: CliDependencies) {
  const latest = reviews[0];
  if (!latest) return;
  dependencies.stdout.write("LLM review:\n");
  dependencies.stdout.write(`- ${latest.provider}/${latest.model}: ${latest.review.riskLevel} confidence=${latest.review.confidence} recommendation=${latest.review.recommendedAction}\n`);
  dependencies.stdout.write(`- ${latest.review.summary}\n`);
  if (latest.review.suspectedRiskTypes.length > 0) {
    dependencies.stdout.write(`- suspected risks: ${latest.review.suspectedRiskTypes.join(", ")}\n`);
  }
}

function printQueueStatus(queue: AnalysisQueueStats, dependencies: CliDependencies) {
  dependencies.stdout.write(`Analysis queue: ${queue.driver}\n`);
  dependencies.stdout.write(`- waiting: ${queue.waiting}\n`);
  dependencies.stdout.write(`- active: ${queue.active}\n`);
  dependencies.stdout.write(`- delayed: ${queue.delayed}\n`);
  dependencies.stdout.write(`- failed: ${queue.failed}\n`);
  if (queue.completed !== undefined) dependencies.stdout.write(`- completed: ${queue.completed}\n`);
  dependencies.stdout.write(`- total pending: ${queue.totalPending}\n`);
  dependencies.stdout.write(`- checked: ${queue.checkedAt}\n`);
}

function formatOverrideLine(record: OverrideRecord) {
  const override = record.override;
  const status = overrideStatus(record);
  const created = record.createdAt ? ` created=${record.createdAt}` : "";
  const expiry = override.expiresAt ? ` expires=${override.expiresAt}` : "";
  const reviewer = override.approvedBy ? ` by=${override.approvedBy}` : "";
  return `- ${override.packageName}${override.version ? `@${override.version}` : ""} ${override.action} ${status}${reviewer}${expiry}${created}: ${override.reason}\n`;
}

function formatAuditEventLine(event: AuditEventRecord) {
  const actor = event.actor ? ` actor=${event.actor}` : "";
  const created = event.createdAt ? ` created=${event.createdAt}` : "";
  const metadata = event.metadata ? ` ${JSON.stringify(event.metadata)}` : "";
  return `- ${event.eventType} ${event.targetType}:${event.targetId}${actor}${created}${metadata}\n`;
}

function formatNodeBaseReportLine(report: NodeBaseReportRecord) {
  const risk = nodeBaseReportRisk(report);
  const highlights = nodeBaseHighlights(report);
  const project = report.projectName ? ` ${report.projectName}` : "";
  const created = report.createdAt ? ` ${report.createdAt}` : "";
  return `- ${report.id ?? "(no id)"} ${report.reportType}${project}${created} high=${risk.high} medium=${risk.medium}${highlights ? ` ${highlights}` : ""}\n`;
}

function printNodeBaseReport(report: NodeBaseReportRecord, dependencies: CliDependencies) {
  const risk = nodeBaseReportRisk(report);
  const body = isRecord(report.report) ? report.report : {};
  dependencies.stdout.write(`Node Base ${report.reportType} report ${report.id ?? ""}\n`);
  dependencies.stdout.write(`Source: ${report.source}${report.projectName ? ` / ${report.projectName}` : ""}\n`);
  if (report.createdAt) dependencies.stdout.write(`Created: ${report.createdAt}\n`);
  dependencies.stdout.write(`Risk: high=${risk.high} medium=${risk.medium}\n`);
  const highlights = nodeBaseHighlights(report);
  if (highlights) dependencies.stdout.write(`Highlights: ${highlights}\n`);

  const findings = [...arrayField(body.highConfidenceFindings), ...arrayField(body.mediumConfidenceFindings)];
  if (findings.length > 0) {
    dependencies.stdout.write("Findings:\n");
    for (const item of findings.slice(0, 20)) {
      const finding = isRecord(item) ? item : {};
      const location = [finding.source, finding.line].filter(Boolean).join(":");
      dependencies.stdout.write(`- ${finding.code ?? "UNKNOWN"}${location ? ` (${location})` : ""}${finding.evidence ? ` ${finding.evidence}` : ""}\n`);
    }
  }

  const networkSummary = isRecord(body.networkSummary) ? body.networkSummary : undefined;
  const connections = arrayField(networkSummary?.connections);
  if (connections.length > 0) {
    dependencies.stdout.write("Connections:\n");
    for (const item of connections.slice(0, 10)) {
      const connection = isRecord(item) ? item : {};
      const target = [connection.address, connection.port].filter(Boolean).join(":") || "(unknown)";
      dependencies.stdout.write(`- ${target}${connection.family ? ` ${connection.family}` : ""}${connection.line ? ` line ${connection.line}` : ""}\n`);
    }
  }

  const policy = isRecord(body.policy) ? body.policy : undefined;
  const networkPolicy = isRecord(policy?.network) ? policy.network : undefined;
  if (networkPolicy) {
    dependencies.stdout.write("Network policy:\n");
    dependencies.stdout.write(`- allowed ports: ${formatList(networkPolicy.allowedPorts)}\n`);
    dependencies.stdout.write(`- allowed hosts: ${formatList(networkPolicy.allowedHosts)}\n`);
    dependencies.stdout.write(`- blocked hosts: ${formatList(networkPolicy.blockedHosts)}\n`);
    dependencies.stdout.write(`- direct IP severity: ${networkPolicy.directIpSeverity ?? "medium"}\n`);
    dependencies.stdout.write(`- non-standard port severity: ${networkPolicy.nonStandardPortSeverity ?? "medium"}\n`);
  }
}

async function requestJson<T = unknown>(dependencies: CliDependencies, url: string, init?: RequestInit): Promise<T> {
  const response = await dependencies.fetch(url, init);
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body ? String(body.error) : bodyText || response.statusText;
    throw new Error(`Anvil request failed (${response.status}): ${detail}`);
  }

  if (bodyText && body === undefined) throw new Error(`Anvil request returned invalid JSON (${response.status}).`);
  return body as T;
}

async function requestJsonWithStatus<T = unknown>(dependencies: CliDependencies, url: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: T }> {
  const response = await dependencies.fetch(url, init);
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);
  if (bodyText && body === undefined) throw new Error(`Anvil request returned invalid JSON (${response.status}).`);
  return { status: response.status, ok: response.ok, body: body as T };
}

function parseJsonBody(bodyText: string): unknown | undefined {
  if (!bodyText) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

async function requestBytes(dependencies: CliDependencies, url: string): Promise<Uint8Array> {
  const response = await dependencies.fetch(url);
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Anvil request failed (${response.status}): ${bodyText || response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function registryBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.ANVIL_REGISTRY_URL || env.PUBLIC_BASE_URL || "http://localhost:4873").replace(/\/+$/, "");
}

function adminBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.ANVIL_ADMIN_URL || "http://localhost:3000").replace(/\/+$/, "");
}

function adminAuthHeader(env: NodeJS.ProcessEnv): { authorization?: string } {
  const token = env.ANVIL_ADMIN_TOKEN || env.ADMIN_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

type NodeBaseReportRecord = {
  id?: string;
  source: string;
  projectName?: string;
  reportType: string;
  summary?: Record<string, unknown>;
  report: unknown;
  createdAt?: string;
};

type AnalysisSignal = AnalysisReport["signals"][number];

type AnalysisFileFinding = NonNullable<AnalysisReport["fileFindings"]>[number];

type AnalysisReportRecord = {
  packageName: string;
  version: string;
  tarballIntegrity?: string;
  tarballShasum?: string;
  analyserVersion?: string;
  report: AnalysisReport;
  createdAt?: string;
};

type AnalysisReportComparisonResult = {
  packageName: string;
  version: string;
  left: AnalysisReportRecord;
  right: AnalysisReportRecord;
  comparison: {
    scoreDelta: number;
    signals: {
      added: AnalysisSignal[];
      removed: AnalysisSignal[];
      unchanged: AnalysisSignal[];
    };
    fileFindings: {
      added: AnalysisFileFinding[];
      removed: AnalysisFileFinding[];
      unchanged: AnalysisFileFinding[];
    };
  };
};

type OverrideRecord = {
  override: Override;
  createdAt?: string;
  revokedAt?: string;
};

type AuditEventRecord = {
  actor?: string;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

type SmokePackageMetadata = {
  name: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { dist?: { tarball?: string } }>;
};

type ExplainResult = {
  packageName: string;
  version: string;
  decision: PolicyDecision;
  analysisReport?: AnalysisReport;
  llmRiskReviews?: LlmRiskReviewRecord[];
  override?: Override;
};

type LlmRiskReviewRecord = {
  packageName: string;
  version: string;
  provider: string;
  model: string;
  review: LlmRiskReview;
  createdAt?: string;
};

type AnalysisQueueStats = {
  driver: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed?: number;
  totalPending: number;
  checkedAt: string;
};

type ReadinessResponse = {
  ok: boolean;
  upstream?: string;
  checks?: Array<{
    component: string;
    ok: boolean;
    error?: string;
  }>;
};

function isGatewayTarballUrl(tarballUrl: string, registryUrl: string, packageName: string): boolean {
  try {
    const registry = new URL(registryUrl);
    const tarball = new URL(tarballUrl, registry);
    return tarball.origin === registry.origin && decodeUrlPath(tarball.pathname).startsWith(`/${packageName}/-/`);
  } catch {
    return false;
  }
}

function decodeUrlPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function encodePackagePath(packageName: string): string {
  if (!packageName.startsWith("@")) return encodeURIComponent(packageName);
  const [scope, name] = packageName.split("/");
  return `${encodeURIComponent(scope ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function addOptionalParam(params: URLSearchParams, key: string, value: string | undefined) {
  if (value) params.set(key, value);
}

function firstPositionalArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function formatAction(action: PolicyDecision["action"]) {
  if (action === "block") return "blocked";
  if (action === "quarantine") return "quarantined";
  if (action === "warn") return "warned";
  return "allowed";
}

function nodeBaseReportRisk(report: NodeBaseReportRecord) {
  const body = isRecord(report.report) ? report.report : {};
  const summary = report.summary ?? (isRecord(body.summary) ? body.summary : undefined);
  return {
    high: aliasedSummaryCount(summary, "high", "highConfidenceFindings"),
    medium: aliasedSummaryCount(summary, "medium", "mediumConfidenceFindings")
  };
}

function nodeBaseHighlights(report: NodeBaseReportRecord) {
  const body = isRecord(report.report) ? report.report : {};
  const summary = report.summary ?? (isRecord(body.summary) ? body.summary : undefined);
  const parts = [
    countPart(summary, "packagesWithLifecycleScripts", "lifecycle scripts"),
    countPart(summary, "packagesWithFindings", "packages with findings"),
    countPart(summary, "executedProcesses", "execs"),
    countPart(summary, "outboundConnections", "connections"),
    countPart(summary, "sensitiveFileAccesses", "sensitive file accesses")
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

function countPart(summary: Record<string, unknown> | undefined, key: string, label: string) {
  const value = summary?.[key];
  return typeof value === "number" ? `${value} ${label}` : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function aliasedSummaryCount(summary: Record<string, unknown> | undefined, primaryKey: string, compatibilityKey: string) {
  return Math.max(numberValue(summary?.[primaryKey]), numberValue(summary?.[compatibilityKey]));
}

function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function formatList(value: unknown) {
  const items = arrayField(value).map((item) => String(item));
  return items.length > 0 ? items.join(", ") : "(none)";
}

function parsePopularPackageIndex(value: unknown, source = "inline"): PopularPackageIndex {
  if (!isRecord(value)) throw new Error("Popular package index must be a JSON object.");
  const popularPackages = value.popularPackages ?? value.packages;
  if (!Array.isArray(popularPackages)) throw new Error("Popular package index requires a popularPackages array.");
  const knownConfusions = value.knownConfusions ?? value.knownEcosystemConfusions ?? {};
  if (!isRecord(knownConfusions)) throw new Error("Popular package index knownConfusions must be an object.");

  return {
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : undefined,
    source,
    popularPackages: popularPackages.map(parsePopularPackage),
    knownConfusions: Object.fromEntries(
      Object.entries(knownConfusions).map(([requested, suggested]) => {
        if (typeof suggested !== "string" || !suggested) throw new Error(`Known confusion for ${requested} must be a package name.`);
        return [requested.toLowerCase(), suggested];
      })
    )
  };
}

function parsePopularPackage(value: unknown): PopularPackage {
  if (typeof value === "string") return { name: value };
  if (!isRecord(value) || typeof value.name !== "string" || !value.name) throw new Error("Popular package entries require a name.");
  const weeklyDownloads = typeof value.weeklyDownloads === "number" ? value.weeklyDownloads : undefined;
  const aliases = Array.isArray(value.aliases) ? value.aliases.map((alias) => String(alias)).filter(Boolean) : undefined;
  return { name: value.name, ...(weeklyDownloads !== undefined ? { weeklyDownloads } : {}), ...(aliases?.length ? { aliases } : {}) };
}

function dependencyDiffRows(diff: Record<string, unknown> | undefined) {
  const rows = [
    ...dependencyGroupRows("runtime", isRecord(diff?.runtime) ? diff.runtime : diff),
    ...dependencyGroupRows("dev", isRecord(diff?.dev) ? diff.dev : undefined),
    ...dependencyGroupRows("optional", isRecord(diff?.optional) ? diff.optional : undefined),
    ...dependencyGroupRows("peer", isRecord(diff?.peer) ? diff.peer : undefined)
  ];
  return rows.sort((left, right) => `${left.group}:${left.name}`.localeCompare(`${right.group}:${right.name}`));
}

function dependencyGroupRows(group: string, diff: Record<string, unknown> | undefined) {
  const added = isRecord(diff?.added) ? Object.entries(diff.added).map(([name, version]) => ({ group, name, previous: "", target: String(version), change: "added" })) : [];
  const removed = isRecord(diff?.removed) ? Object.entries(diff.removed).map(([name, version]) => ({ group, name, previous: String(version), target: "", change: "removed" })) : [];
  const changed = isRecord(diff?.changed)
    ? Object.entries(diff.changed).map(([name, value]) => {
        const change = isRecord(value) ? value : {};
        return { group, name, previous: String(change.previous ?? ""), target: String(change.target ?? ""), change: "changed" };
      })
    : [];
  return [...added, ...removed, ...changed];
}

function formatEvidence(evidence: Record<string, unknown> | undefined) {
  return evidence ? JSON.stringify(evidence) : "";
}

function analysisReportIdentity(record: AnalysisReportRecord) {
  const report = record.report;
  const identity = [record.tarballIntegrity ?? report.tarballIntegrity, record.tarballShasum ?? report.tarballShasum, record.analyserVersion ?? report.analyserVersion].filter(Boolean);
  return identity.length > 0 ? identity.join(" / ") : "latest";
}

function overrideStatus(record: OverrideRecord) {
  if (record.revokedAt) return "revoked";
  if (record.override.expiresAt && Date.parse(record.override.expiresAt) <= Date.now()) return "expired";
  return "active";
}

function hasHighAnalysisRisk(report: AnalysisReport) {
  return report.signals.some(isHighSeverity) || (report.fileFindings ?? []).some(isHighSeverity);
}

function isHighSeverity(item: { severity: string }) {
  return item.severity === "high" || item.severity === "critical";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compareTargets(a: PackageTarget, b: PackageTarget) {
  return `${a.packageName}@${a.version}`.localeCompare(`${b.packageName}@${b.version}`);
}

function usage() {
  return `Usage:
  anvil doctor
  anvil explain package@version
  anvil scan package-lock.json [--queue-analysis]
  anvil scan pnpm-lock.yaml [--queue-analysis]
  anvil scan yarn.lock [--queue-analysis]
  anvil warm package-lock.json
  anvil warm yarn.lock
  anvil smoke [package]
  anvil approve package@version --reason "intentional dependency" [--approved-by reviewer] [--expires-at 2026-06-20T00:00:00Z]
  anvil revoke package@version [--revoked-by reviewer]
  anvil llm-review package@version [--requested-by reviewer] [--priority high]
  anvil queue status
  anvil overrides [--target package@version] [--package package] [--version version] [--limit 20]
  anvil audit-events [--target package@version] [--limit 20]
  anvil popular-index show
  anvil popular-index upload popular-index.json [--generated-at 2026-05-20T00:00:00Z]
  anvil reports package@version [--integrity sha512-...] [--shasum ...] [--analyser static-v1]
  anvil reports compare package@version [--left-integrity sha512-old] [--right-integrity sha512-new]
  anvil node-base reports [--type dependency|lifecycle|ioc|network] [--risk risky|high|medium] [--limit 20]
  anvil node-base report <id>
  anvil policy test package.json

Admin-gated commands read ANVIL_ADMIN_TOKEN, falling back to ADMIN_TOKEN.
`;
}

function defaultDependencies(): CliDependencies {
  return {
    fetch,
    readFile: (path) => readFile(path, "utf8"),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await run(process.argv.slice(2));
}
