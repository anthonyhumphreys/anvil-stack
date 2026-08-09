import semver from "semver";
import type { PackageVersionMetadata, PolicyDecision } from "@anvilstack/shared";

export type NpmPackageMetadata = {
  name: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions?: Record<string, NpmVersionMetadata>;
};

export type NpmVersionMetadata = {
  name: string;
  version: string;
  private?: boolean;
  dist?: {
    tarball?: string;
    integrity?: string;
    shasum?: string;
    attestations?: unknown;
    provenance?: unknown;
  };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: unknown;
  files?: unknown;
  repository?: unknown;
  license?: string;
  maintainers?: unknown;
  provenance?: unknown;
};

export type UpstreamRegistryConfig = {
  name: string;
  baseUrl: string;
  scopes?: string[];
  authToken?: string;
  authTokenSecretName?: string;
};

export type NpmDownloadsClientConfig = {
  baseUrl: string;
  cacheTtlMs?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type DownloadStatsClient = {
  getWeeklyDownloads(packageName: string): Promise<number | undefined>;
};

export class NpmRegistryClient {
  constructor(private readonly config: UpstreamRegistryConfig) {}

  async fetchMetadata(packageName: string): Promise<NpmPackageMetadata> {
    const url = `${trimTrailingSlash(this.config.baseUrl)}/${encodePackagePath(packageName)}`;
    const response = await fetch(url, {
      headers: this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : undefined
    });

    if (!response.ok) {
      throw new Error(`Upstream metadata fetch failed for ${packageName}: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as NpmPackageMetadata;
  }

  async fetchTarball(tarballUrl: string): Promise<Uint8Array> {
    const response = await fetch(tarballUrl, {
      headers: this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : undefined
    });

    if (!response.ok) {
      throw new Error(`Upstream tarball fetch failed: ${response.status} ${response.statusText}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}

export class NpmRegistryRouter {
  private readonly clients: Array<{ config: UpstreamRegistryConfig; client: NpmRegistryClient }>;

  constructor(configs: UpstreamRegistryConfig[]) {
    if (configs.length === 0) throw new Error("At least one upstream npm registry is required.");
    this.clients = configs.map((config) => ({ config, client: new NpmRegistryClient(config) }));
  }

  async fetchMetadata(packageName: string): Promise<NpmPackageMetadata> {
    return this.clientForPackage(packageName).fetchMetadata(packageName);
  }

  async fetchTarball(tarballUrl: string): Promise<Uint8Array> {
    return this.clientForTarballUrl(tarballUrl).fetchTarball(tarballUrl);
  }

  resolveRegistryName(packageName: string): string {
    return this.registryForPackage(packageName).config.name;
  }

  private clientForPackage(packageName: string): NpmRegistryClient {
    return this.registryForPackage(packageName).client;
  }

  private registryForPackage(packageName: string) {
    const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
    const scoped = scope ? this.clients.find(({ config }) => config.scopes?.includes(scope)) : undefined;
    return scoped ?? this.clients.find(({ config }) => !config.scopes?.length) ?? this.clients[0]!;
  }

  private clientForTarballUrl(tarballUrl: string): NpmRegistryClient {
    const matching = this.clients.find(({ config }) => isRegistryUrl(tarballUrl, config.baseUrl));
    return matching?.client ?? this.clients[0]!.client;
  }
}

export class NpmDownloadsClient implements DownloadStatsClient {
  private readonly cache = new Map<string, { value: number | undefined; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<number | undefined>>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly cacheTtlMs: number;
  private readonly maxConcurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private activeRequests = 0;
  private readonly waitingForSlot: Array<() => void> = [];

  constructor(private readonly config: NpmDownloadsClientConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.cacheTtlMs = config.cacheTtlMs ?? 15 * 60 * 1000;
    this.maxConcurrency = Math.max(1, config.maxConcurrency ?? 4);
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, config.retryBaseDelayMs ?? 100);
  }

  async getWeeklyDownloads(packageName: string): Promise<number | undefined> {
    const cached = this.cache.get(packageName);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const current = this.inFlight.get(packageName);
    if (current) return current;

    const request = this.fetchWeeklyDownloads(packageName).finally(() => this.inFlight.delete(packageName));
    this.inFlight.set(packageName, request);
    return request;
  }

  private async fetchWeeklyDownloads(packageName: string): Promise<number | undefined> {
    const url = `${trimTrailingSlash(this.config.baseUrl)}/point/last-week/${encodeURIComponent(packageName)}`;
    let response: Response | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        response = await this.withRequestSlot(() => this.fetch(url));
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      if (lastError) {
        if (attempt === this.maxAttempts) throw lastError;
        await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      if (!response) throw new Error(`npm downloads fetch failed for ${packageName}: no response`);
      if (response.ok || response.status === 404 || !isRetryableDownloadStatsStatus(response.status) || attempt === this.maxAttempts) break;
      await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
    }

    if (!response) throw new Error(`npm downloads fetch failed for ${packageName}: no response`);
    if (response.status === 404) return this.cacheValue(packageName, undefined);
    if (!response.ok) {
      throw new Error(`npm downloads fetch failed for ${packageName}: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { downloads?: unknown };
    return this.cacheValue(packageName, typeof body.downloads === "number" ? body.downloads : undefined);
  }

  private cacheValue(packageName: string, value: number | undefined): number | undefined {
    this.cache.set(packageName, { value, expiresAt: this.now() + this.cacheTtlMs });
    return value;
  }

  private async withRequestSlot<T>(request: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= this.maxConcurrency) await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
    this.activeRequests += 1;
    try {
      return await request();
    } finally {
      this.activeRequests -= 1;
      this.waitingForSlot.shift()?.();
    }
  }
}

function isRetryableDownloadStatsStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function encodePackagePath(packageName: string): string {
  if (!packageName.startsWith("@")) return encodeURIComponent(packageName);
  const [scope, name] = packageName.split("/");
  if (!scope || !name) throw new Error(`Invalid scoped package name: ${packageName}`);
  return `${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
}

export function decodeRoutePackageName(scopeOrName: string, maybeName?: string): string {
  if (maybeName) return `@${scopeOrName}/${maybeName}`;
  return scopeOrName;
}

export function toVersionMetadata(metadata: NpmPackageMetadata, version: string): PackageVersionMetadata | undefined {
  const versionMetadata = metadata.versions?.[version];
  if (!versionMetadata) return undefined;

  return {
    name: versionMetadata.name,
    version: versionMetadata.version,
    private: versionMetadata.private,
    publishedAt: metadata.time?.[version],
    tarballUrl: versionMetadata.dist?.tarball,
    integrity: versionMetadata.dist?.integrity,
    shasum: versionMetadata.dist?.shasum,
    scripts: versionMetadata.scripts,
    dependencies: versionMetadata.dependencies,
    devDependencies: versionMetadata.devDependencies,
    optionalDependencies: versionMetadata.optionalDependencies,
    peerDependencies: versionMetadata.peerDependencies,
    bin: versionMetadata.bin,
    files: versionMetadata.files,
    repository: versionMetadata.repository,
    license: versionMetadata.license,
    maintainers: versionMetadata.maintainers,
    provenance: extractProvenance(versionMetadata)
  };
}

export function extractProvenance(versionMetadata: NpmVersionMetadata): NonNullable<PackageVersionMetadata["provenance"]> {
  const attestationUrl = getObjectString(versionMetadata.dist?.attestations, "url");
  if (versionMetadata.dist?.attestations) {
    return {
      present: true,
      source: "dist.attestations",
      attestationUrl,
      raw: versionMetadata.dist.attestations
    };
  }

  if (versionMetadata.dist?.provenance) {
    return {
      present: true,
      source: "dist.provenance",
      raw: versionMetadata.dist.provenance
    };
  }

  if (versionMetadata.provenance) {
    return {
      present: true,
      source: "version.provenance",
      raw: versionMetadata.provenance
    };
  }

  return { present: false };
}

function getObjectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function calculatePackageAgeDays(publishedAt?: string, now = new Date()): number | undefined {
  if (!publishedAt) return undefined;
  const publishedTime = Date.parse(publishedAt);
  if (Number.isNaN(publishedTime)) return undefined;
  return Math.max(0, (now.getTime() - publishedTime) / 86_400_000);
}

export function rewriteMetadataTarballs(metadata: NpmPackageMetadata, publicBaseUrl: string): NpmPackageMetadata {
  const rewritten: NpmPackageMetadata = structuredClone(metadata);
  for (const versionMetadata of Object.values(rewritten.versions ?? {})) {
    if (!versionMetadata.dist?.tarball) continue;
    versionMetadata.dist.tarball = tarballProxyUrl(publicBaseUrl, rewritten.name, versionMetadata.dist.tarball);
  }
  return rewritten;
}

export function filterMetadataVersions(
  metadata: NpmPackageMetadata,
  decisions: Map<string, PolicyDecision>,
  options: { hideQuarantined: boolean }
): NpmPackageMetadata {
  const filtered: NpmPackageMetadata = structuredClone(metadata);
  const versions = filtered.versions ?? {};

  for (const [version, decision] of decisions) {
    if (decision.action === "block" || (options.hideQuarantined && decision.action === "quarantine")) {
      delete versions[version];
      if (filtered.time) delete filtered.time[version];
    }
  }

  filtered.versions = versions;
  filtered["dist-tags"] = rewriteDistTags(filtered["dist-tags"] ?? {}, Object.keys(versions));

  return filtered;
}

export function rewriteDistTags(distTags: Record<string, string>, allowedVersions: string[]): Record<string, string> {
  const rewritten = { ...distTags };
  const newestAllowed = semver.rsort(allowedVersions.filter((version) => semver.valid(version)))[0];

  for (const [tag, version] of Object.entries(distTags)) {
    if (allowedVersions.includes(version)) continue;
    if (newestAllowed) rewritten[tag] = newestAllowed;
    else delete rewritten[tag];
  }

  if (!rewritten.latest && newestAllowed) rewritten.latest = newestAllowed;
  return rewritten;
}

export function resolveMetadataVersion(metadata: NpmPackageMetadata, requestedVersion: string): string | undefined {
  if (metadata.versions?.[requestedVersion]) return requestedVersion;
  return metadata["dist-tags"]?.[requestedVersion];
}

export function resolveVersionFromTarballName(metadata: NpmPackageMetadata, tarballName: string): string | undefined {
  const normalized = tarballName.split("/").pop();
  return Object.entries(metadata.versions ?? {}).find(([, versionMetadata]) => {
    const upstreamTarballName = versionMetadata.dist?.tarball?.split("/").pop();
    return upstreamTarballName === normalized;
  })?.[0];
}

export function tarballProxyUrl(publicBaseUrl: string, packageName: string, upstreamTarballUrl: string): string {
  const tarballName = upstreamTarballUrl.split("/").pop();
  if (!tarballName) throw new Error(`Cannot resolve tarball name from ${upstreamTarballUrl}`);
  const base = trimTrailingSlash(publicBaseUrl);
  if (!packageName.startsWith("@")) return `${base}/${encodeURIComponent(packageName)}/-/${encodeURIComponent(tarballName)}`;
  const [scope, name] = packageName.slice(1).split("/");
  return `${base}/@${encodeURIComponent(scope ?? "")}/${encodeURIComponent(name ?? "")}/-/${encodeURIComponent(tarballName)}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isRegistryUrl(candidate: string, baseUrl: string): boolean {
  try {
    const candidateUrl = new URL(candidate);
    const base = trimTrailingSlash(baseUrl);
    const baseUrlObject = new URL(`${base}/`);
    return candidateUrl.origin === baseUrlObject.origin && candidateUrl.pathname.startsWith(baseUrlObject.pathname);
  } catch {
    return false;
  }
}
