import semver from "semver";
import { gunzipSync } from "node:zlib";
import type { AnalysisReport, PackageVersionMetadata, PolicyReason } from "@anvilstack/shared";

const lifecycleScripts = new Set(["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]);
type DependencyGroup = "runtime" | "dev" | "optional" | "peer";

export function analyseManifestChange(
  target: PackageVersionMetadata,
  previous?: PackageVersionMetadata | PackageVersionMetadata[],
  options: { analyserVersion: string; policyVersion: string } = {
    analyserVersion: "manifest-2026-05-21.1",
    policyVersion: "unknown"
  }
): AnalysisReport {
  const signals: PolicyReason[] = [];
  const previousVersions = normalizePreviousVersions(previous);
  const primaryPrevious = previousVersions[0];
  const targetLifecycle = pickLifecycleScripts(target.scripts);
  const previousLifecycle = pickLifecycleScripts(primaryPrevious?.scripts);
  const release = releaseContext(primaryPrevious?.version, target.version);
  const baseline = baselineContext(previousVersions);

  for (const [scriptName, script] of Object.entries(targetLifecycle)) {
    if (!previousLifecycle[scriptName]) {
      signals.push({
        code: "NEW_INSTALL_SCRIPT",
        message: `Lifecycle script '${scriptName}' was introduced.`,
        severity: "high",
        evidence: { scriptName, script, impact: "install-time", expectedForRelease: false, releaseType: release.type, ...baseline, history: lifecycleScriptHistory(scriptName, previousVersions) }
      });
    } else if (previousLifecycle[scriptName] !== script) {
      signals.push({
        code: "INSTALL_SCRIPT_CHANGED",
        message: `Lifecycle script '${scriptName}' changed.`,
        severity: "medium",
        evidence: { scriptName, impact: "install-time", expectedForRelease: false, releaseType: release.type, ...baseline, history: lifecycleScriptHistory(scriptName, previousVersions) }
      });
    }
  }

  for (const finding of detectSuspiciousScriptPatterns(targetLifecycle)) {
    signals.push(finding);
  }

  const dependencyDiff = diffManifestDependencies(target, primaryPrevious);
  if (primaryPrevious) {
    signals.push(...detectDependencyChangeSignals(dependencyDiff, previousVersions, release.type));
  }

  if (primaryPrevious && isPatchVersionBump(primaryPrevious.version, target.version) && Object.keys(dependencyDiff.added).length > 0) {
    signals.push({
      code: "NEW_DEPENDENCY_IN_PATCH_VERSION",
      message: "Patch version added new runtime dependencies.",
      severity: "medium",
      evidence: { added: dependencyDiff.added, impact: "runtime", expectedForRelease: false, releaseType: release.type, ...baseline, history: dependencyHistory(dependencyDiff.added, previousVersions, "dependencies") }
    });
  }

  if (primaryPrevious && isPatchVersionBump(primaryPrevious.version, target.version) && Object.keys(dependencyDiff.optional.added).length > 0) {
    signals.push({
      code: "OPTIONAL_DEPENDENCY_ADDED",
      message: "Patch version added optional dependencies.",
      severity: "medium",
      evidence: { added: dependencyDiff.optional.added, impact: "install-time-or-runtime", expectedForRelease: false, releaseType: release.type, ...baseline, history: dependencyHistory(dependencyDiff.optional.added, previousVersions, "optionalDependencies") }
    });
  }

  if (primaryPrevious) {
    signals.push(...detectManifestMetadataChanges(target, primaryPrevious, previousVersions, release.type));
  }

  return {
    packageName: target.name,
    version: target.version,
    analyserVersion: options.analyserVersion,
    policyVersion: options.policyVersion,
    score: signals.reduce((total, signal) => total + (signal.severity === "high" ? 70 : signal.severity === "medium" ? 35 : 10), 0),
    signals,
    dependencyDiff,
    manifestDiff: {
      release,
      lifecycleScripts: {
        previous: previousLifecycle,
        target: targetLifecycle
      },
      metadata: diffManifestMetadata(target, primaryPrevious),
      baselines: previousVersions.map((version) => ({
        version: version.version,
        release: releaseContext(version.version, target.version),
        lifecycleScripts: {
          previous: pickLifecycleScripts(version.scripts),
          target: targetLifecycle
        },
        dependencyDiff: diffManifestDependencies(target, version),
        metadata: diffManifestMetadata(target, version)
      }))
    },
    createdAt: new Date().toISOString()
  };
}

export type TarballFile = {
  path: string;
  rawPath: string;
  size: number;
  mode: number;
  type: "file" | "directory" | "symlink" | "other";
  linkTarget?: string;
  content?: Uint8Array;
};

export type FileFinding = {
  path: string;
  code: PolicyReason["code"];
  reason: string;
  severity: PolicyReason["severity"];
  evidence?: Record<string, unknown>;
};

export function parseNpmTarball(tarball: Uint8Array): TarballFile[] {
  const data = gunzipSync(tarball);
  const files: TarballFile[] = [];
  let offset = 0;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const rawPath = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawEntryPath = prefix ? `${prefix}/${rawPath}` : rawPath;
    const path = normalizeTarPath(rawEntryPath);
    const mode = readTarOctal(header, 100, 8);
    const size = readTarOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const linkTarget = readTarString(header, 157, 100) || undefined;
    const contentOffset = offset + 512;
    const nextOffset = contentOffset + Math.ceil(size / 512) * 512;

    if (path) {
      files.push({
        path,
        rawPath: rawEntryPath,
        size,
        mode,
        type: tarType(typeFlag),
        linkTarget,
        content: typeFlag === "0" || typeFlag === "\0" ? data.subarray(contentOffset, contentOffset + size) : undefined
      });
    }

    offset = nextOffset;
  }

  return files;
}

export function analyseFileTree(
  targetFiles: TarballFile[],
  baselineFiles: TarballFile[][] = [],
  options: { lifecycleScripts?: Record<string, string> } = {}
): { signals: PolicyReason[]; fileFindings: FileFinding[] } {
  const baselinePaths = new Set(baselineFiles.flatMap((files) => files.map((file) => file.path)));
  const baselineByPath = baselineFileStats(baselineFiles);
  const installPaths = installPathCandidates(options.lifecycleScripts);
  const targetFileEntries = targetFiles.filter((file) => file.type === "file");
  const findings: FileFinding[] = [...analysePackedPackageManifest(targetFileEntries, baselineFiles)];

  for (const entry of targetFiles) {
    if (isUnsafeTarPath(entry.rawPath)) {
      findings.push({
        path: entry.path,
        code: "UNSAFE_TARBALL_PATH",
        reason: "Tarball entry uses an unsafe path that could escape package extraction.",
        severity: "high",
        evidence: { rawPath: entry.rawPath, entryType: entry.type }
      });
    }

    if (entry.type === "symlink") {
      const linkTarget = entry.linkTarget ?? "";
      const unsafe = isUnsafeLinkTarget(linkTarget);
      findings.push({
        path: entry.path,
        code: unsafe ? "UNSAFE_TARBALL_SYMLINK" : "SUSPICIOUS_FILE_ADDED",
        reason: unsafe ? "Tarball contains a symlink pointing outside the package." : "Tarball contains a symlink.",
        severity: unsafe ? "high" : "medium",
        evidence: { linkTarget, unsafe }
      });
    }
  }

  for (const file of targetFileEntries) {
    const isNew = !baselinePaths.has(file.path);
    const content = file.content ?? new Uint8Array();
    const baseline = baselineByPath.get(file.path);

    if (baseline && isLargeSizeDelta(file.size, baseline.maxSize)) {
      findings.push({
        path: file.path,
        code: "LARGE_FILE_SIZE_DELTA",
        reason: `File size grew sharply compared with previous package versions (${baseline.maxSize} bytes to ${file.size} bytes).`,
        severity: "medium",
        evidence: {
          previousMaxSize: baseline.maxSize,
          targetSize: file.size,
          deltaBytes: file.size - baseline.maxSize,
          ratio: Number((file.size / baseline.maxSize).toFixed(2))
        }
      });
    }

    if (isNew && looksBinary(content)) {
      findings.push({
        path: file.path,
        code: "UNEXPECTED_BINARY_FILE",
        reason: "New binary-looking file appears in the package tarball.",
        severity: "high",
        evidence: { size: file.size, mode: fileMode(file.mode), newFile: true }
      });
    }

    if (isNew && isExecutable(file)) {
      findings.push({
        path: file.path,
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "New executable file appears in the package tarball.",
        severity: "medium",
        evidence: { size: file.size, mode: fileMode(file.mode), newFile: true }
      });
    }

    if (!isNew && baseline && !baseline.executable && isExecutable(file)) {
      findings.push({
        path: file.path,
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "Existing file became executable in the package tarball.",
        severity: "medium",
        evidence: { size: file.size, previousModes: baseline.modes.map(fileMode), mode: fileMode(file.mode), executableChanged: true }
      });
    }

    if (isNew && isHiddenPath(file.path)) {
      findings.push({
        path: file.path,
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "New hidden file appears in the package tarball.",
        severity: "medium",
        evidence: { newFile: true, pathType: "hidden" }
      });
    }

    if (isNew && isUnusualPath(file.path)) {
      findings.push({
        path: file.path,
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "New file appears under an unusual package path.",
        severity: "medium",
        evidence: { newFile: true, pathType: "unusual" }
      });
    }

    if (looksCredentialLike(file.path)) {
      findings.push({
        path: file.path,
        code: "SUSPICIOUS_FILE_ADDED",
        reason: "Package contains a credential-looking file.",
        severity: "high",
        evidence: { pathType: "credential" }
      });
    }

    if (isTextLike(file.path, content)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(content);
      if (isInstallPathFile(file.path, installPaths)) {
        findings.push(...detectSuspiciousCodePatterns(file.path, text));
      }
      if (isNew && looksMinified(file.path, text)) {
        findings.push({
          path: file.path,
          code: "OBFUSCATED_CODE_DETECTED",
          reason: "New minified JavaScript file appears in the package tarball.",
          severity: "medium",
          evidence: { size: file.size, newFile: true, longestLine: longestLineLength(text) }
        });
      }
      if (containsEncodedBlob(text)) {
        findings.push({
          path: file.path,
          code: "OBFUSCATED_CODE_DETECTED",
          reason: "File contains a large encoded blob.",
          severity: "high",
          evidence: { size: file.size }
        });
      }
    }
  }

  const signals = findings.map((finding) => ({
    code: finding.code,
    message: finding.reason,
    severity: finding.severity,
    evidence: { path: finding.path, ...finding.evidence }
  }));

  return { signals, fileFindings: findings };
}

export function mergeAnalysisReports(report: AnalysisReport, fileAnalysis: { signals: PolicyReason[]; fileFindings: FileFinding[] }): AnalysisReport {
  const signals = [...report.signals, ...fileAnalysis.signals];
  return {
    ...report,
    analyserVersion: "static-2026-05-21.1",
    signals,
    score: signals.reduce((total, signal) => total + (signal.severity === "critical" ? 95 : signal.severity === "high" ? 70 : signal.severity === "medium" ? 35 : signal.severity === "low" ? 10 : 0), 0),
    fileFindings: fileAnalysis.fileFindings
  };
}

export function pickLifecycleScripts(scripts?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(scripts ?? {}).filter(([name]) => lifecycleScripts.has(name)));
}

export function diffDependencies(
  target: Record<string, string> = {},
  previous: Record<string, string> = {}
): { added: Record<string, string>; removed: Record<string, string>; changed: Record<string, { previous: string; target: string }> } {
  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  const changed: Record<string, { previous: string; target: string }> = {};

  for (const [name, version] of Object.entries(target)) {
    if (!previous[name]) added[name] = version;
    else if (previous[name] !== version) changed[name] = { previous: previous[name], target: version };
  }
  for (const [name, version] of Object.entries(previous)) {
    if (!target[name]) removed[name] = version;
  }

  return { added, removed, changed };
}

function diffManifestDependencies(target: PackageVersionMetadata, previous?: PackageVersionMetadata) {
  return {
    ...diffDependencies(target.dependencies, previous?.dependencies),
    runtime: diffDependencies(target.dependencies, previous?.dependencies),
    dev: diffDependencies(target.devDependencies, previous?.devDependencies),
    optional: diffDependencies(target.optionalDependencies, previous?.optionalDependencies),
    peer: diffDependencies(target.peerDependencies, previous?.peerDependencies)
  };
}

function analysePackedPackageManifest(targetFileEntries: TarballFile[], baselineFiles: TarballFile[][]): FileFinding[] {
  const targetManifest = targetFileEntries.find(isPackageManifest);
  const baselineManifests = baselineFiles.map((files) => files.find(isPackageManifest));
  const primaryBaseline = baselineManifests[0];

  if (!targetManifest) {
    return [
      {
        path: "package.json",
        code: "PACKAGE_MANIFEST_CHANGED",
        reason: "Package tarball is missing package.json.",
        severity: "high",
        evidence: { changeType: "removed", compareDepth: baselineFiles.length }
      }
    ];
  }

  const targetParsed = parseJsonObject(targetManifest.content);
  if (!targetParsed) {
    return [
      {
        path: targetManifest.path,
        code: "PACKAGE_MANIFEST_CHANGED",
        reason: "Packed package.json is not valid JSON.",
        severity: "high",
        evidence: { changeType: "invalid", size: targetManifest.size }
      }
    ];
  }

  const previousParsed = primaryBaseline ? parseJsonObject(primaryBaseline.content) : undefined;
  if (!previousParsed) return [];
  if (stableJson(targetParsed) === stableJson(previousParsed)) return [];

  return [
    {
      path: targetManifest.path,
      code: "PACKAGE_MANIFEST_CHANGED",
      reason: "Packed package.json changed compared with the previous package version.",
      severity: "medium",
      evidence: {
        changeType: "changed",
        changedKeys: changedManifestKeys(targetParsed, previousParsed),
        compareDepth: baselineFiles.length,
        missingBaselineManifests: baselineManifests.filter((manifest) => !manifest).length
      }
    }
  ];
}

function isPackageManifest(file: TarballFile | undefined): file is TarballFile {
  return file?.type === "file" && file.path === "package.json";
}

function parseJsonObject(content: Uint8Array | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(content)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function changedManifestKeys(target: Record<string, unknown>, previous: Record<string, unknown>) {
  return [...new Set([...Object.keys(target), ...Object.keys(previous)])]
    .filter((key) => stableJson(target[key]) !== stableJson(previous[key]))
    .sort((left, right) => left.localeCompare(right));
}

type DependencyDiff = ReturnType<typeof diffManifestDependencies>;

function detectDependencyChangeSignals(dependencyDiff: DependencyDiff, previousVersions: PackageVersionMetadata[], releaseType: string): PolicyReason[] {
  const signals: PolicyReason[] = [];
  for (const group of ["runtime", "dev", "optional", "peer"] as const) {
    const diff = dependencyDiff[group];
    const changed = changedDependencyTargets(diff);
    if (Object.keys(changed).length === 0) continue;
    signals.push({
      code: dependencyChangeCode(group),
      message: dependencyChangeMessage(group),
      severity: dependencyChangeSeverity(group, diff),
      evidence: {
        ...diff,
        impact: dependencyChangeImpact(group),
        expectedForRelease: dependencyChangeExpectedForRelease(group, releaseType),
        releaseType,
        ...baselineContext(previousVersions),
        history: dependencyHistory(changed, previousVersions, dependencyHistoryField(group))
      }
    });
  }
  return signals;
}

function dependencyChangeCode(group: DependencyGroup): PolicyReason["code"] {
  if (group === "runtime") return "RUNTIME_DEPENDENCY_CHANGED";
  if (group === "dev") return "DEV_DEPENDENCY_CHANGED";
  if (group === "optional") return "OPTIONAL_DEPENDENCY_CHANGED";
  return "PEER_DEPENDENCY_CHANGED";
}

function dependencyChangeMessage(group: DependencyGroup) {
  if (group === "runtime") return "Runtime dependency set changed.";
  if (group === "dev") return "Development dependency set changed.";
  if (group === "optional") return "Optional dependency set changed.";
  return "Peer dependency contract changed.";
}

function dependencyChangeSeverity(group: DependencyGroup, diff: { added: Record<string, string>; removed: Record<string, string>; changed: Record<string, { previous: string; target: string }> }): PolicyReason["severity"] {
  if (group === "dev") return "low";
  if (group === "peer") return "low";
  if (Object.keys(diff.added).length > 0 || Object.keys(diff.changed).length > 0) return "medium";
  return "low";
}

function dependencyChangeImpact(group: DependencyGroup) {
  if (group === "runtime") return "runtime";
  if (group === "dev") return "development-or-build-time";
  if (group === "optional") return "install-time-or-runtime";
  return "runtime-contract";
}

function dependencyChangeExpectedForRelease(group: DependencyGroup, releaseType: string) {
  if (group === "peer") return releaseType === "major";
  if (group === "dev") return true;
  return releaseType !== "patch";
}

function dependencyHistoryField(group: DependencyGroup): "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies" {
  if (group === "runtime") return "dependencies";
  if (group === "dev") return "devDependencies";
  if (group === "optional") return "optionalDependencies";
  return "peerDependencies";
}

function detectManifestMetadataChanges(target: PackageVersionMetadata, previous: PackageVersionMetadata, previousVersions: PackageVersionMetadata[], releaseType: string): PolicyReason[] {
  const signals: PolicyReason[] = [];
  const metadataDiff = diffManifestMetadata(target, previous);
  const baseline = baselineContext(previousVersions);

  if (metadataDiff.repository.changed) {
    signals.push({
      code: "REPOSITORY_CHANGED",
      message: "Repository metadata changed.",
      severity: "medium",
      evidence: { ...metadataDiff.repository, impact: "metadata", expectedForRelease: releaseType !== "patch", releaseType, ...baseline, history: metadataHistory("repository", previousVersions) }
    });
  }

  if (metadataDiff.bin.changed) {
    signals.push({
      code: "BIN_FIELD_CHANGED",
      message: "Package binary entry points changed.",
      severity: "medium",
      evidence: { ...metadataDiff.bin, impact: "runtime-entrypoint", expectedForRelease: releaseType !== "patch", releaseType, ...baseline, history: metadataHistory("bin", previousVersions) }
    });
  }

  for (const key of ["license", "files", "maintainers"] as const) {
    if (!metadataDiff[key].changed) continue;
    signals.push({
      code: "MANIFEST_FIELD_CHANGED",
      message: `Package ${key} metadata changed.`,
      severity: key === "license" ? "low" : "medium",
      evidence: {
        field: key,
        ...metadataDiff[key],
        impact: key === "files" ? "published-files" : "metadata",
        expectedForRelease: releaseType !== "patch" || key === "license",
        releaseType,
        ...baseline,
        history: metadataHistory(key, previousVersions)
      }
    });
  }

  return signals;
}

function normalizePreviousVersions(previous: PackageVersionMetadata | PackageVersionMetadata[] | undefined) {
  if (!previous) return [];
  return Array.isArray(previous) ? previous : [previous];
}

function baselineContext(previousVersions: PackageVersionMetadata[]) {
  return {
    comparedVersions: previousVersions.map((version) => version.version),
    compareDepth: previousVersions.length
  };
}

function lifecycleScriptHistory(scriptName: string, previousVersions: PackageVersionMetadata[]) {
  return previousVersions.map((version) => ({
    version: version.version,
    script: pickLifecycleScripts(version.scripts)[scriptName]
  }));
}

function dependencyHistory(
  dependencies: Record<string, unknown>,
  previousVersions: PackageVersionMetadata[],
  field: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"
) {
  return Object.fromEntries(
    Object.keys(dependencies).map((name) => [
      name,
      previousVersions.map((version) => ({
        version: version.version,
        spec: version[field]?.[name]
      }))
    ])
  );
}

function changedDependencyTargets(diff: { added: Record<string, string>; removed: Record<string, string>; changed: Record<string, { previous: string; target: string }> }) {
  return {
    ...diff.added,
    ...diff.removed,
    ...Object.fromEntries(Object.entries(diff.changed).map(([name, change]) => [name, change.target]))
  };
}

function metadataHistory(field: "repository" | "license" | "maintainers" | "bin" | "files", previousVersions: PackageVersionMetadata[]) {
  return previousVersions.map((version) => ({
    version: version.version,
    value: version[field]
  }));
}

function diffManifestMetadata(target: PackageVersionMetadata, previous?: PackageVersionMetadata) {
  return {
    repository: changedField(previous?.repository, target.repository),
    license: changedField(previous?.license, target.license),
    maintainers: changedField(previous?.maintainers, target.maintainers),
    bin: changedField(previous?.bin, target.bin),
    files: changedField(previous?.files, target.files)
  };
}

function releaseContext(previousVersion: string | undefined, targetVersion: string) {
  const type = previousVersion ? semver.diff(previousVersion, targetVersion) ?? "unknown" : "no-baseline";
  return {
    previous: previousVersion,
    target: targetVersion,
    type
  };
}

function changedField(previous: unknown, target: unknown) {
  return {
    previous,
    target,
    changed: stableJson(previous) !== stableJson(target)
  };
}

function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortJson(nested)]));
}

function detectSuspiciousScriptPatterns(scripts: Record<string, string>): PolicyReason[] {
  const findings: PolicyReason[] = [];
  const joined = Object.values(scripts).join("\n");

  if (/(child_process|execSync|spawnSync|\bexec\(|\bspawn\()/i.test(joined)) {
    findings.push({
      code: "USES_CHILD_PROCESS",
      message: "Install script references child process execution.",
      severity: "high"
    });
  }
  if (/(curl|wget)[^|;&]+[|]\s*(bash|sh)|http\.request|https\.request|\bfetch\(|net\.connect|dns\.lookup/i.test(joined)) {
    findings.push({
      code: "NETWORK_ACCESS_IN_INSTALL_PATH",
      message: "Install script appears to use network access.",
      severity: "high"
    });
  }
  if (/(process\.env|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(joined)) {
    findings.push({
      code: "USES_PROCESS_ENV",
      message: "Install script references environment variables or common secret names.",
      severity: "high"
    });
  }
  if (
    /(fs\.(readFileSync|readdirSync)|require\(["']fs["']\)|from\s+["']fs["']|os\.homedir|require\(["']os["']\)|from\s+["']os["']|\.npmrc|\.ssh|\.aws|\.config\/gcloud|\.azure|\.git\/config|\.git-credentials|id_rsa|id_ed25519|known_hosts|\.env(?:\.local)?)/i.test(joined)
  ) {
    findings.push({
      code: "SENSITIVE_FILE_ACCESS_IN_INSTALL_PATH",
      message: "Install script references filesystem or home-directory access patterns often used to inspect credentials.",
      severity: "high"
    });
  }
  if (/(eval\(|new Function|Buffer\.from\(.+base64|base64\s+-d)/i.test(joined)) {
    findings.push({
      code: "OBFUSCATED_CODE_DETECTED",
      message: "Install script contains obfuscation-like execution patterns.",
      severity: "high"
    });
  }

  return findings;
}

function detectSuspiciousCodePatterns(path: string, text: string): FileFinding[] {
  const findings: FileFinding[] = [];

  if (/(require\(["']child_process["']\)|from\s+["']child_process["']|child_process['"]?\)?\.(exec|execSync|spawn|spawnSync)|child_process\.(exec|execSync|spawn|spawnSync)|\bexec\(|\bspawn\()/i.test(text)) {
    findings.push({
      path,
      code: "USES_CHILD_PROCESS",
      reason: "File references child process execution.",
      severity: "high",
      evidence: { installPath: true, pattern: "child_process" }
    });
  }
  if (/(http\.request|https\.request|\bfetch\(|net\.connect|dns\.lookup|curl\s+https?:|wget\s+https?:)/i.test(text)) {
    findings.push({
      path,
      code: "NETWORK_ACCESS_IN_INSTALL_PATH",
      reason: "File references network access APIs or download commands.",
      severity: "high",
      evidence: { installPath: true, pattern: "network" }
    });
  }
  if (/(process\.env|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(text)) {
    findings.push({
      path,
      code: "USES_PROCESS_ENV",
      reason: "File references environment variables or common secret names.",
      severity: "high",
      evidence: { installPath: true, pattern: "environment" }
    });
  }
  if (
    /(fs\.(readFileSync|readdirSync)|require\(["']fs["']\)|from\s+["']fs["']|os\.homedir|require\(["']os["']\)|from\s+["']os["']|\.npmrc|\.ssh|\.aws|\.config\/gcloud|\.azure|\.git\/config|\.git-credentials|id_rsa|id_ed25519|known_hosts|\.env(?:\.local)?)/i.test(text)
  ) {
    findings.push({
      path,
      code: "SENSITIVE_FILE_ACCESS_IN_INSTALL_PATH",
      reason: "File references filesystem or home-directory access patterns often used to inspect credentials.",
      severity: "high",
      evidence: { installPath: true, pattern: "sensitive-file-access" }
    });
  }
  if (/(eval\(|new Function|Buffer\.from\([^)]{20,}base64|atob\()/i.test(text)) {
    findings.push({
      path,
      code: "OBFUSCATED_CODE_DETECTED",
      reason: "File contains obfuscation-like execution patterns.",
      severity: "high",
      evidence: { installPath: true, pattern: "obfuscation" }
    });
  }

  return findings;
}

function readTarString(header: Buffer, start: number, length: number): string {
  const end = header.indexOf(0, start);
  const sliceEnd = end === -1 || end > start + length ? start + length : end;
  return header.subarray(start, sliceEnd).toString("utf8").trim();
}

function readTarOctal(header: Buffer, start: number, length: number): number {
  const raw = readTarString(header, start, length).replace(/\0/g, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isUnsafeTarPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => part === "..");
}

function isUnsafeLinkTarget(target: string): boolean {
  if (!target) return false;
  const normalized = target.replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => part === "..");
}

function normalizeTarPath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^package\/+/, "");
}

function tarType(typeFlag: string): TarballFile["type"] {
  if (typeFlag === "0" || typeFlag === "\0") return "file";
  if (typeFlag === "5") return "directory";
  if (typeFlag === "2") return "symlink";
  return "other";
}

function looksBinary(content: Uint8Array): boolean {
  if (content.length === 0) return false;
  const sample = content.subarray(0, Math.min(content.length, 8_192));
  if (sample.includes(0)) return true;
  const suspiciousBytes = sample.filter((byte) => byte < 7 || (byte > 14 && byte < 32)).length;
  return suspiciousBytes / sample.length > 0.08;
}

function isExecutable(file: TarballFile): boolean {
  return (file.mode & 0o111) !== 0;
}

function fileMode(mode: number) {
  return `0o${mode.toString(8)}`;
}

function baselineFileStats(baselineFiles: TarballFile[][]) {
  const stats = new Map<string, { executable: boolean; maxSize: number; modes: number[] }>();
  for (const file of baselineFiles.flat()) {
    if (file.type !== "file") continue;
    const current = stats.get(file.path);
    stats.set(file.path, {
      executable: Boolean(current?.executable || isExecutable(file)),
      maxSize: Math.max(current?.maxSize ?? 0, file.size),
      modes: [...new Set([...(current?.modes ?? []), file.mode])].sort((left, right) => left - right)
    });
  }
  return stats;
}

function isLargeSizeDelta(targetSize: number, previousMaxSize: number) {
  if (previousMaxSize <= 0) return targetSize > 500_000;
  return targetSize - previousMaxSize > 500_000 && targetSize / previousMaxSize >= 3;
}

function installPathCandidates(scripts: Record<string, string> = {}) {
  const paths = new Set<string>(["install.js", "postinstall.js", "preinstall.js", "prepare.js", "scripts/install.js", "scripts/postinstall.js", "scripts/preinstall.js"]);
  for (const script of Object.values(scripts)) {
    for (const candidate of script.matchAll(/(?:node|sh|bash|tsx|ts-node)\s+((?:\.\/)?[A-Za-z0-9._/@-]+(?:\.[cm]?[jt]s|\.sh|\.bash)?)/g)) {
      const path = candidate[1]?.replace(/^\.\//, "");
      if (path) paths.add(path);
    }
  }
  return paths;
}

function isInstallPathFile(path: string, installPaths: Set<string>) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (installPaths.has(normalized)) return true;
  return /(^|\/)(preinstall|install|postinstall|prepare)(\.[cm]?[jt]s|\.sh|\.bash)$/i.test(normalized) || /^scripts\/(preinstall|install|postinstall|prepare)\b/i.test(normalized);
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") && ![".", ".."].includes(part));
}

function isUnusualPath(path: string): boolean {
  return /(^|\/)(preinstall|postinstall|install-hooks|scripts\/install|tmp|temp|\.github\/workflows)(\/|$)/i.test(path);
}

function looksCredentialLike(path: string): boolean {
  return /(^|\/)(\.env|\.npmrc|\.git\/config|\.git-credentials|id_rsa|id_dsa|id_ed25519|known_hosts|\.aws\/credentials|\.config\/gcloud|\.azure|credentials|token|secret|private-key)(\.|$|\/)/i.test(path);
}

function isTextLike(path: string, content: Uint8Array): boolean {
  return /\.(js|mjs|cjs|ts|json|sh|bash|cmd|ps1|py|rb|pl|txt|md|yaml|yml)$/i.test(path) || !looksBinary(content);
}

function looksMinified(path: string, text: string): boolean {
  if (!/\.m?js$/i.test(path)) return false;
  return text.length > 4_000 && longestLineLength(text) > 2_000;
}

function longestLineLength(text: string) {
  return Math.max(...text.split(/\r?\n/).map((line) => line.length));
}

function containsEncodedBlob(text: string): boolean {
  return /[A-Za-z0-9+/]{512,}={0,2}/.test(text);
}

function isPatchVersionBump(previous: string, target: string): boolean {
  const previousVersion = semver.parse(previous);
  const targetVersion = semver.parse(target);
  if (!previousVersion || !targetVersion) return false;
  return previousVersion.major === targetVersion.major && previousVersion.minor === targetVersion.minor && targetVersion.patch > previousVersion.patch;
}
