import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@anvilstack/config";
import type { NpmPackageMetadata } from "@anvilstack/npm-registry";
import type { ObjectStore } from "@anvilstack/object-store";
import type { AnalysisReport } from "@anvilstack/shared";
import { MemoryPersistence } from "@anvilstack/persistence";
import { MemoryJobQueue } from "@anvilstack/queue";
import { buildGateway } from "./app.js";

function testConfig(runtimeMode: "development" | "ci" | "production" = "ci") {
  return loadConfig({
    ...process.env,
    RUNTIME_MODE: runtimeMode,
    PUBLIC_BASE_URL: "http://anvil.test",
    PERSISTENCE_DRIVER: "memory"
  });
}

describe("gateway policy enforcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports dependency readiness", async () => {
    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      objectStore: new TestObjectStore(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/-/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      upstreamRegistries: [{ name: "npmjs", baseUrl: "https://registry.npmjs.org", scopes: [] }],
      checks: [
        { component: "persistence", ok: true },
        { component: "objectStore", ok: true },
        { component: "queue", ok: true }
      ]
    });

    await app.close();
  });

  it("returns 503 readiness when a dependency check fails", async () => {
    const objectStore = new TestObjectStore();
    objectStore.failHealthCheck = true;
    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      objectStore,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/-/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      checks: expect.arrayContaining([{ component: "objectStore", ok: false, error: "object store unavailable" }])
    });

    await app.close();
  });

  it("exposes token-gated analysis queue stats", async () => {
    const queue = new MemoryJobQueue();
    await queue.enqueueAnalysisJob({
      packageName: "pkg",
      version: "1.0.0",
      reason: "manual_review",
      priority: "normal",
      createdAt: "2026-05-20T00:00:00.000Z"
    });
    const app = buildGateway({
      config: loadConfig({ ...process.env, RUNTIME_MODE: "development", ADMIN_TOKEN: "secret", PERSISTENCE_DRIVER: "memory" }),
      persistence: new MemoryPersistence(),
      queue,
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const rejected = await app.inject({ method: "GET", url: "/-/anvil/queue" });
    const accepted = await app.inject({ method: "GET", url: "/-/anvil/queue", headers: { authorization: "Bearer secret" } });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      queue: {
        driver: "memory",
        waiting: 1,
        active: 0,
        delayed: 0,
        failed: 0,
        totalPending: 1,
        checkedAt: expect.any(String)
      }
    });

    await app.close();
  });

  it("proxies npm security audit requests to the upstream registry", async () => {
    const upstreamFetch = vi.fn(async (url: string, init?: RequestInit) =>
      Response.json({ ok: true, path: new URL(url).pathname, packages: Object.keys((JSON.parse(String(init?.body)) as Record<string, unknown>) ?? {}) })
    );
    const app = buildGateway({
      config: loadConfig({ ...process.env, RUNTIME_MODE: "development", PERSISTENCE_DRIVER: "memory", UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org/" }),
      persistence: new MemoryPersistence(),
      objectStore: new TestObjectStore(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats(),
      fetch: upstreamFetch as unknown as typeof globalThis.fetch
    });

    const bulkPayload = Buffer.from(JSON.stringify({ "is-number": ["7.0.0"] }));
    const compressedBulkPayload = gzipSync(bulkPayload);
    const bulk = await app.inject({
      method: "POST",
      url: "/-/npm/v1/security/advisories/bulk",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(compressedBulkPayload.length)
      },
      payload: compressedBulkPayload
    });
    const quick = await app.inject({
      method: "POST",
      url: "/-/npm/v1/security/audits/quick",
      payload: { name: "fixture", requires: { "is-number": "7.0.0" } }
    });

    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toMatchObject({ ok: true, path: "/-/npm/v1/security/advisories/bulk", packages: ["is-number"] });
    expect(quick.statusCode).toBe(200);
    expect(quick.json()).toMatchObject({ ok: true, path: "/-/npm/v1/security/audits/quick" });
    expect(upstreamFetch).toHaveBeenNthCalledWith(
      1,
      "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "is-number": ["7.0.0"] })
      })
    );

    await app.close();
  });

  it("passes default upstream auth to npm security audit proxy requests", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({ ok: true }));
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "development",
        PERSISTENCE_DRIVER: "memory",
        UPSTREAM_NPM_REGISTRY: "https://private-registry.example.test",
        UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([
          {
            name: "private",
            baseUrl: "https://private-registry.example.test",
            authTokenSecretName: "PRIVATE_NPM_TOKEN"
          }
        ]),
        PRIVATE_NPM_TOKEN: "private-token"
      }),
      persistence: new MemoryPersistence(),
      objectStore: new TestObjectStore(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats(),
      fetch: upstreamFetch as unknown as typeof globalThis.fetch
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/npm/v1/security/advisories/bulk",
      payload: { "private-pkg": ["1.0.0"] }
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledWith(
      "https://private-registry.example.test/-/npm/v1/security/advisories/bulk",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          authorization: "Bearer private-token"
        }
      })
    );

    await app.close();
  });

  it("exposes and persists the effective policy config", async () => {
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/-/anvil/policy" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runtimeMode: "ci",
      policy: { version: "2026-05-20.1" },
      policyConfig: { name: "effective", version: "2026-05-20.1", active: true }
    });
    expect(await persistence.getActivePolicyConfig("effective")).toMatchObject({ version: "2026-05-20.1", active: true });

    await app.close();
  });

  it("filters blocked versions from metadata and removes unusable dist-tags", async () => {
    const metadata = packageMetadata("fresh-package", new Date().toISOString());
    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/fresh-package" });
    expect(response.statusCode).toBe(200);

    const body = response.json<NpmPackageMetadata>();
    expect(body.versions?.["1.0.0"]).toBeUndefined();
    expect(body["dist-tags"]?.latest).toBeUndefined();

    await app.close();
  });

  it("rewrites latest dist-tag to the newest allowed version", async () => {
    const metadata = packageMetadata("fresh-package", "2020-01-01T00:00:00.000Z");
    metadata["dist-tags"] = { latest: "2.0.0" };
    metadata.time = {
      ...metadata.time,
      "2.0.0": new Date().toISOString()
    };
    metadata.versions = {
      ...metadata.versions,
      "2.0.0": {
        name: "fresh-package",
        version: "2.0.0",
        dist: {
          tarball: "https://registry.npmjs.org/fresh-package/-/fresh-package-2.0.0.tgz",
          integrity: "sha512-new"
        }
      }
    };

    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/fresh-package" });
    expect(response.statusCode).toBe(200);

    const body = response.json<NpmPackageMetadata>();
    expect(body.versions?.["2.0.0"]).toBeUndefined();
    expect(body.versions?.["1.0.0"]).toBeDefined();
    expect(body["dist-tags"]?.latest).toBe("1.0.0");
    expect(body.versions?.["1.0.0"]?.dist?.tarball).toBe(
      "http://anvil.test/fresh-package/-/fresh-package-1.0.0.tgz"
    );

    await app.close();
  });

  it("blocks tarball fetches for policy-denied package versions", async () => {
    const metadata = packageMetadata("fresh-package", new Date().toISOString());
    const fetchTarball = vi.fn();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/fresh-package/-/fresh-package-1.0.0.tgz" });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "ANVIL_PACKAGE_BLOCKED",
      package: "fresh-package",
      version: "1.0.0",
      decision: "block"
    });
    expect(fetchTarball).not.toHaveBeenCalled();

    await app.close();
  });

  it("rewrites scoped package tarball URLs through the gateway", async () => {
    const metadata = packageMetadata("@scope/pkg", "2020-01-01T00:00:00.000Z");
    const app = buildGateway({
      config: testConfig("development"),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/@scope/pkg" });
    const body = response.json<NpmPackageMetadata>();

    expect(response.statusCode).toBe(200);
    expect(body.versions?.["1.0.0"]?.dist?.tarball).toBe("http://anvil.test/@scope/pkg/-/pkg-1.0.0.tgz");

    await app.close();
  });

  it("refreshes stale cached upstream metadata", async () => {
    const staleMetadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    staleMetadata["dist-tags"] = { ...staleMetadata["dist-tags"], latest: "1.0.0" };
    const freshMetadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    freshMetadata.versions = {
      ...freshMetadata.versions,
      "1.0.1": {
        ...freshMetadata.versions?.["1.0.0"],
        name: "stable-package",
        version: "1.0.1",
        dist: {
          tarball: "https://registry.npmjs.org/stable-package/-/stable-package-1.0.1.tgz",
          integrity: "sha512-new",
          shasum: "newsum"
        }
      }
    };
    freshMetadata["dist-tags"] = {
      ...freshMetadata["dist-tags"],
      latest: "1.0.1"
    };
    const persistence = new StaleMetadataPersistence("2000-01-01T00:00:00.000Z");
    await persistence.putMetadata("stable-package", staleMetadata);
    const fetchMetadata = vi.fn(async () => freshMetadata);
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "development",
        PUBLIC_BASE_URL: "http://anvil.test",
        PERSISTENCE_DRIVER: "memory",
        NPM_METADATA_CACHE_TTL_SECONDS: "300"
      }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata,
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/stable-package" });
    const body = response.json<NpmPackageMetadata>();

    expect(response.statusCode).toBe(200);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(body["dist-tags"]?.latest).toBe("1.0.1");
    expect(body.versions?.["1.0.1"]?.dist?.tarball).toBe("http://anvil.test/stable-package/-/stable-package-1.0.1.tgz");
    expect(await persistence.getMetadata("stable-package")).toMatchObject({ "dist-tags": { latest: "1.0.1" } });

    await app.close();
  });

  it("accepts split URL-encoded scoped metadata and tarball paths", async () => {
    const metadata = packageMetadata("@scope/pkg", "2020-01-01T00:00:00.000Z");
    const fetchMetadata = vi.fn(async () => metadata);
    const fetchTarball = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const app = buildGateway({
      config: testConfig("development"),
      persistence: new MemoryPersistence(),
      objectStore: new TestObjectStore(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata,
        fetchTarball
      },
      downloadStats: noDownloadStats()
    });

    const metadataResponse = await app.inject({ method: "GET", url: "/%40scope/pkg" });
    const tarballResponse = await app.inject({ method: "GET", url: "/%40scope/pkg/-/pkg-1.0.0.tgz" });

    expect(metadataResponse.statusCode).toBe(200);
    expect(tarballResponse.statusCode).toBe(200);
    expect(fetchMetadata).toHaveBeenCalledWith("@scope/pkg");
    expect(fetchTarball).toHaveBeenCalledWith("https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz");

    await app.close();
  });

  it("serves cached tarballs without fetching upstream and stores misses", async () => {
    const metadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    const objectStore = new TestObjectStore();
    const fetchTarball = vi.fn(async () => new Uint8Array([7, 8, 9]));
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("development"),
      persistence,
      objectStore,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball
      },
      downloadStats: noDownloadStats()
    });

    const first = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const second = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-anvil-cache"]).toBe("miss");
    expect([...first.rawPayload]).toEqual([7, 8, 9]);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-anvil-cache"]).toBe("hit");
    expect([...second.rawPayload]).toEqual([7, 8, 9]);
    expect(fetchTarball).toHaveBeenCalledTimes(1);
    expect(await persistence.getPackageVersion("stable-package", "1.0.0")).toMatchObject({
      packageName: "stable-package",
      version: "1.0.0",
      cachedTarballKey: "tarballs/stable-package/1.0.0/sha512-test.tgz"
    });

    await app.close();
  });

  it("bypasses tarball object caching when upstream metadata lacks immutable integrity", async () => {
    const metadata = packageMetadata("mutable-package", "2020-01-01T00:00:00.000Z");
    delete metadata.versions?.["1.0.0"]?.dist?.integrity;
    delete metadata.versions?.["1.0.0"]?.dist?.shasum;
    const persistence = new MemoryPersistence();
    let tarballFetchCount = 0;
    const fetchTarball = vi.fn(async () => new Uint8Array([1, ++tarballFetchCount]));
    const app = buildGateway({
      config: testConfig("development"),
      persistence,
      objectStore: new TestObjectStore(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball
      },
      downloadStats: noDownloadStats()
    });

    const first = await app.inject({ method: "GET", url: "/mutable-package/-/mutable-package-1.0.0.tgz" });
    const second = await app.inject({ method: "GET", url: "/mutable-package/-/mutable-package-1.0.0.tgz" });

    expect(first.statusCode).toBe(200);
    expect(first.headers["x-anvil-cache"]).toBe("bypass");
    expect([...first.rawPayload]).toEqual([1, 1]);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-anvil-cache"]).toBe("bypass");
    expect([...second.rawPayload]).toEqual([1, 2]);
    expect(fetchTarball).toHaveBeenCalledTimes(2);
    expect(await persistence.getPackageVersion("mutable-package", "1.0.0")).not.toMatchObject({
      cachedTarballKey: expect.any(String)
    });

    await app.close();
  });

  it("quarantines CI tarball requests until static analysis exists", async () => {
    const metadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    const queue = new MemoryJobQueue();
    const persistence = new MemoryPersistence();
    const fetchTarball = vi.fn();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(response.statusCode).toBe(423);
    expect(response.json()).toMatchObject({
      error: "ANVIL_PACKAGE_QUARANTINED",
      package: "stable-package",
      version: "1.0.0",
      decision: "quarantine",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "ANALYSIS_REQUIRED" })])
    });
    expect(fetchTarball).not.toHaveBeenCalled();
    expect(queuedJobs).toEqual([
      expect.objectContaining({
        packageName: "stable-package",
        version: "1.0.0",
        reason: "tarball_request",
        priority: "normal"
      })
    ]);
    expect(await persistence.getPolicyDecision("stable-package", "1.0.0", testConfig("ci").policy.version, {
      tarballIntegrity: "sha512-test",
      analyserVersion: "install-policy-2026-05-21.1"
    })).toMatchObject({ action: "quarantine" });

    await app.close();
  });

  it("enqueues background analysis for allowed tarball requests without a deep report", async () => {
    const metadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    const queue = new MemoryJobQueue();
    const app = buildGateway({
      config: testConfig("development"),
      persistence: new MemoryPersistence(),
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn(async () => new Uint8Array([1, 2, 3]))
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(response.statusCode).toBe(200);
    expect(queuedJobs).toEqual([
      expect.objectContaining({
        packageName: "stable-package",
        version: "1.0.0",
        reason: "tarball_request",
        priority: "normal"
      })
    ]);

    await app.close();
  });

  it("enqueues deep analysis when tarball requests reuse cached metadata decisions", async () => {
    const metadata = packageMetadata("stable-package", "2020-01-01T00:00:00.000Z");
    const queue = new MemoryJobQueue();
    const app = buildGateway({
      config: testConfig("development"),
      persistence: new MemoryPersistence(),
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn(async () => new Uint8Array([1, 2, 3]))
      },
      downloadStats: noDownloadStats()
    });

    const metadataResponse = await app.inject({ method: "GET", url: "/stable-package" });
    const tarballResponse = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const secondTarballResponse = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(metadataResponse.statusCode).toBe(200);
    expect(tarballResponse.statusCode).toBe(200);
    expect(secondTarballResponse.statusCode).toBe(200);
    expect(queuedJobs).toEqual([
      expect.objectContaining({
        packageName: "stable-package",
        version: "1.0.0",
        reason: "tarball_request",
        priority: "normal"
      })
    ]);

    await app.close();
  });

  it("does not treat stale analysis reports as coverage for changed tarballs", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putAnalysisReport({
      packageName: "stable-package",
      version: "1.0.0",
      analyserVersion: "static-analysis-test",
      policyVersion: testConfig("development").policy.version,
      tarballIntegrity: "sha512-old",
      score: 70,
      signals: [{ code: "UNEXPECTED_BINARY_FILE", message: "Old tarball had a binary.", severity: "high" }],
      createdAt: "2026-05-20T12:00:00.000Z"
    });
    const queue = new MemoryJobQueue();
    const app = buildGateway({
      config: testConfig("development"),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => packageMetadata("stable-package", "2020-01-01T00:00:00.000Z")),
        fetchTarball: vi.fn(async () => new Uint8Array([1, 2, 3]))
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/stable-package/-/stable-package-1.0.0.tgz" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(response.statusCode).toBe(200);
    expect(queuedJobs).toEqual([
      expect.objectContaining({
        packageName: "stable-package",
        version: "1.0.0",
        reason: "tarball_request"
      })
    ]);

    await app.close();
  });

  it("does not reuse cached policy decisions when tarball integrity changes", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putPolicyDecision(
      "stable-package",
      "1.0.0",
      testConfig("ci").policy.version,
      {
        action: "block",
        score: 95,
        reasons: [{ code: "UNEXPECTED_BINARY_FILE", message: "Old tarball was bad.", severity: "critical" }],
        explanation: "old cached block"
      },
      { tarballIntegrity: "sha512-old", analyserVersion: "metadata-policy-2026-05-20.1" }
    );
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => packageMetadata("stable-package", "2020-01-01T00:00:00.000Z")),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/stable-package" });
    const body = response.json<NpmPackageMetadata>();

    expect(response.statusCode).toBe(200);
    expect(body.versions?.["1.0.0"]).toBeDefined();
    expect(await persistence.getPolicyDecision("stable-package", "1.0.0", testConfig("ci").policy.version, {
      tarballIntegrity: "sha512-test",
      analyserVersion: "metadata-policy-2026-05-20.1"
    })).toMatchObject({ action: "allow" });

    await app.close();
  });

  it("writes one audit event for newly computed gateway policy decisions", async () => {
    const metadata = packageMetadata("fresh-package", new Date().toISOString());
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const first = await app.inject({ method: "GET", url: "/fresh-package" });
    const second = await app.inject({ method: "GET", url: "/fresh-package" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await persistence.listAuditEvents()).toEqual([
      expect.objectContaining({
        actor: "anvil-gateway",
        eventType: "policy.decision",
        targetType: "package",
        targetId: "fresh-package@1.0.0",
        metadata: expect.objectContaining({
          source: "metadata_request",
          action: "block",
          policyVersion: testConfig("ci").policy.version,
          analyserVersion: "metadata-policy-2026-05-20.1",
          tarballIntegrity: "sha512-test",
          reasonCodes: expect.arrayContaining(["PACKAGE_TOO_NEW"])
        })
      })
    ]);

    await app.close();
  });

  it("uses npm download stats when enforcing low-adoption name-squatting policy", async () => {
    const metadata = packageMetadata("@tenstack/react-query", "2020-01-01T00:00:00.000Z");
    const queue = new MemoryJobQueue();
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 10)
      }
    });

    const response = await app.inject({ method: "GET", url: "/@tenstack/react-query" });
    const body = response.json<NpmPackageMetadata>();
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(response.statusCode).toBe(200);
    expect(body.versions?.["1.0.0"]).toBeUndefined();
    expect(queuedJobs[0]).toMatchObject({ packageName: "@tenstack/react-query", version: "1.0.0", priority: "high" });
    expect(await persistence.getPackageVersion("@tenstack/react-query", "1.0.0")).toMatchObject({
      packageName: "@tenstack/react-query",
      version: "1.0.0",
      weeklyDownloads: 10,
      tarballUrl: "https://registry.npmjs.org/@tenstack/react-query/-/react-query-1.0.0.tgz"
    });

    await app.close();
  });

  it("limits metadata-triggered deep analysis to install-relevant dist-tag versions", async () => {
    const metadata = packageMetadata("fresh-package", "2026-05-20T00:00:00.000Z");
    metadata["dist-tags"] = { latest: "2.0.0" };
    metadata.time = {
      ...metadata.time,
      "2.0.0": "2026-05-20T00:00:00.000Z"
    };
    metadata.versions = {
      ...metadata.versions,
      "2.0.0": {
        name: "fresh-package",
        version: "2.0.0",
        dist: {
          tarball: "https://registry.npmjs.org/fresh-package/-/fresh-package-2.0.0.tgz",
          integrity: "sha512-new"
        }
      }
    };
    const queue = new MemoryJobQueue();
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({ method: "GET", url: "/fresh-package" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(response.statusCode).toBe(200);
    expect(queuedJobs).toEqual([
      expect.objectContaining({
        packageName: "fresh-package",
        version: "2.0.0",
        reason: "metadata_request"
      })
    ]);
    expect(await persistence.getPolicyDecision("fresh-package", "1.0.0", testConfig("ci").policy.version, {
      tarballIntegrity: "sha512-test",
      analyserVersion: "metadata-policy-2026-05-20.1"
    })).toMatchObject({ action: "quarantine", expiresAt: expect.any(String) });

    await app.close();
  });

  it("loads name-squatting evidence from an object-store popular package index", async () => {
    const objectStore = new TestObjectStore();
    await objectStore.put(
      "popular-index/npm/latest.json",
      new TextEncoder().encode(
        JSON.stringify({
          generatedAt: "2026-05-20T00:00:00.000Z",
          popularPackages: [{ name: "@scope/actual-package", weeklyDownloads: 200_000 }],
          knownConfusions: { "@scope/actua1-package": "@scope/actual-package" }
        })
      )
    );
    const metadata = packageMetadata("@scope/actua1-package", "2020-01-01T00:00:00.000Z");
    const queue = new MemoryJobQueue();
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      objectStore,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball: vi.fn()
      },
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 10)
      }
    });

    const response = await app.inject({ method: "GET", url: "/@scope/actua1-package" });
    const decision = await persistence.getPolicyDecision("@scope/actua1-package", "1.0.0", testConfig("ci").policy.version, {
      tarballIntegrity: "sha512-test",
      analyserVersion: "metadata-policy-2026-05-20.1"
    });

    expect(response.statusCode).toBe(200);
    expect(decision).toMatchObject({
      action: "block",
      reasons: expect.arrayContaining([
        expect.objectContaining({
          code: "SIMILAR_TO_POPULAR_PACKAGE",
          evidence: expect.objectContaining({
            candidate: "@scope/actual-package",
            suggestedPackage: "@scope/actual-package",
            reasons: expect.arrayContaining(["known_ecosystem_confusion"])
          })
        })
      ])
    });

    await app.close();
  });

  it("applies missing provenance policy before tarball download", async () => {
    const metadata = packageMetadata("popular-package", "2020-01-01T00:00:00.000Z");
    const fetchTarball = vi.fn();
    const queue = new MemoryJobQueue();
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(async () => metadata),
        fetchTarball
      },
      downloadStats: {
        getWeeklyDownloads: vi.fn(async () => 250_000)
      }
    });

    const metadataResponse = await app.inject({ method: "GET", url: "/popular-package" });
    const tarballResponse = await app.inject({ method: "GET", url: "/popular-package/-/popular-package-1.0.0.tgz" });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(metadataResponse.statusCode).toBe(200);
    expect(metadataResponse.json<NpmPackageMetadata>().versions?.["1.0.0"]).toBeUndefined();
    expect(tarballResponse.statusCode).toBe(423);
    expect(tarballResponse.json()).toMatchObject({
      error: "ANVIL_PACKAGE_QUARANTINED",
      decision: "quarantine",
      reasons: expect.arrayContaining([expect.objectContaining({ code: "PROVENANCE_MISSING" })])
    });
    expect(fetchTarball).not.toHaveBeenCalled();
    expect(queuedJobs[0]).toMatchObject({ packageName: "popular-package", version: "1.0.0", priority: "normal" });
    expect(await persistence.getPolicyDecision("popular-package", "1.0.0", testConfig("ci").policy.version, {
      tarballIntegrity: "sha512-test",
      analyserVersion: "metadata-policy-2026-05-20.1"
    })).toMatchObject({ action: "quarantine" });

    await app.close();
  });

  it("includes latest analysis and LLM review evidence in explain responses", async () => {
    const persistence = new MemoryPersistence();
    const report = {
      packageName: "stable-package",
      version: "1.0.0",
      analyserVersion: "static-analysis-test",
      policyVersion: testConfig("ci").policy.version,
      tarballIntegrity: "sha512-test",
      score: 25,
      signals: [{ code: "USES_PROCESS_ENV", message: "Package reads process.env in install-path code.", severity: "medium" }],
      createdAt: "2026-05-20T12:00:00.000Z"
    } satisfies AnalysisReport;
    await persistence.putAnalysisReport(report);
    await persistence.putLlmRiskReview({
      packageName: "stable-package",
      version: "1.0.0",
      tarballIntegrity: "sha512-test",
      analyserVersion: "static-analysis-test",
      provider: "test-provider",
      model: "risk-reviewer",
      review: {
        riskLevel: "high",
        confidence: "medium",
        summary: "Install path behavior needs human review.",
        suspectedRiskTypes: ["install_script_abuse"],
        evidence: [{ signal: "USES_PROCESS_ENV", explanation: "Environment access in install-path code.", source: "code_snippet" }],
        recommendedAction: "quarantine"
      }
    });
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "ci",
        PUBLIC_BASE_URL: "http://anvil.test",
        PERSISTENCE_DRIVER: "memory",
        LLM_REVIEW_ENABLED: "true"
      }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => packageMetadata("stable-package", "2020-01-01T00:00:00.000Z")),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { packageName: "stable-package", version: "1.0.0" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      packageName: "stable-package",
      version: "1.0.0",
      decision: {
        action: "quarantine",
        reasons: expect.arrayContaining([expect.objectContaining({ code: "LLM_RISK_REVIEW_FLAGGED" })])
      },
      analysisReport: expect.objectContaining({
        analyserVersion: "static-analysis-test",
        signals: [expect.objectContaining({ code: "USES_PROCESS_ENV" })]
      }),
      llmRiskReviews: [
        expect.objectContaining({
          provider: "test-provider",
          model: "risk-reviewer",
          review: expect.objectContaining({ riskLevel: "high", summary: "Install path behavior needs human review." })
        })
      ]
    });

    await app.close();
  });

  it("resolves explain requests for arbitrary dist-tags", async () => {
    const persistence = new MemoryPersistence();
    const report = {
      packageName: "stable-package",
      version: "1.0.0",
      analyserVersion: "static-analysis-test",
      policyVersion: testConfig("ci").policy.version,
      tarballIntegrity: "sha512-test",
      score: 0,
      signals: [],
      createdAt: "2026-05-20T12:00:00.000Z"
    } satisfies AnalysisReport;
    await persistence.putAnalysisReport(report);
    const app = buildGateway({
      config: loadConfig({ ...process.env, RUNTIME_MODE: "ci", PUBLIC_BASE_URL: "http://anvil.test", PERSISTENCE_DRIVER: "memory" }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => ({ ...packageMetadata("stable-package", "2020-01-01T00:00:00.000Z"), "dist-tags": { latest: "1.0.0", beta: "1.0.0" } })),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { packageName: "stable-package", version: "beta" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ packageName: "stable-package", version: "1.0.0", analysisReport: expect.objectContaining({ analyserVersion: "static-analysis-test" }) });

    await app.close();
  });

  it("does not apply stale LLM review evidence from a different tarball identity", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putLlmRiskReview({
      packageName: "stable-package",
      version: "1.0.0",
      tarballIntegrity: "sha512-old",
      analyserVersion: "static-analysis-test",
      provider: "test-provider",
      model: "risk-reviewer",
      review: {
        riskLevel: "critical",
        confidence: "high",
        summary: "This belongs to an older tarball.",
        suspectedRiskTypes: ["install_script_abuse"],
        evidence: [{ signal: "OLD_TARBALL", explanation: "Old tarball evidence.", source: "metadata" }],
        recommendedAction: "block"
      }
    });
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "ci",
        PUBLIC_BASE_URL: "http://anvil.test",
        PERSISTENCE_DRIVER: "memory",
        LLM_REVIEW_ENABLED: "true"
      }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => packageMetadata("stable-package", "2020-01-01T00:00:00.000Z")),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { packageName: "stable-package", version: "1.0.0" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: {
        action: "allow",
        reasons: expect.not.arrayContaining([expect.objectContaining({ code: "LLM_RISK_REVIEW_FLAGGED" })])
      },
      llmRiskReviews: []
    });

    await app.close();
  });

  it("does not apply stale LLM review evidence from a different analyser version", async () => {
    const persistence = new MemoryPersistence();
    await persistence.putAnalysisReport({
      packageName: "stable-package",
      version: "1.0.0",
      tarballIntegrity: "sha512-test",
      analyserVersion: "static-analysis-v2",
      policyVersion: testConfig("ci").policy.version,
      score: 0,
      signals: [],
      createdAt: "2026-05-21T12:00:00.000Z"
    });
    await persistence.putLlmRiskReview({
      packageName: "stable-package",
      version: "1.0.0",
      tarballIntegrity: "sha512-test",
      analyserVersion: "static-analysis-v1",
      provider: "test-provider",
      model: "risk-reviewer",
      review: {
        riskLevel: "critical",
        confidence: "high",
        summary: "This belongs to an older analysis engine.",
        suspectedRiskTypes: ["install_script_abuse"],
        evidence: [{ signal: "OLD_ANALYSER", explanation: "Old analyser evidence.", source: "metadata" }],
        recommendedAction: "block"
      }
    });
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        RUNTIME_MODE: "ci",
        PUBLIC_BASE_URL: "http://anvil.test",
        PERSISTENCE_DRIVER: "memory",
        LLM_REVIEW_ENABLED: "true"
      }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(async () => packageMetadata("stable-package", "2020-01-01T00:00:00.000Z")),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { packageName: "stable-package", version: "1.0.0" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: {
        action: "allow",
        reasons: expect.not.arrayContaining([expect.objectContaining({ code: "LLM_RISK_REVIEW_FLAGGED" })])
      },
      analysisReport: expect.objectContaining({ analyserVersion: "static-analysis-v2" }),
      llmRiskReviews: []
    });

    await app.close();
  });

  it("rejects malformed explain requests without touching upstream metadata", async () => {
    const fetchMetadata = vi.fn();
    const app = buildGateway({
      config: testConfig("ci"),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata,
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { version: "1.0.0" }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/explain",
      payload: { targets: [null] }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "ANVIL_EXPLAIN_REQUIRES_TARGET" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_EXPLAIN_INVALID" });
    expect(fetchMetadata).not.toHaveBeenCalled();
    await app.close();
  });

  it("enqueues manual analysis jobs for package targets", async () => {
    const persistence = new MemoryPersistence();
    const queue = new MemoryJobQueue();
    const app = buildGateway({
      config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret", PERSISTENCE_DRIVER: "memory" }),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/-/anvil/analyze",
      payload: { targets: [{ packageName: "pkg", version: "1.0.0" }], reason: "lockfile_scan" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/-/anvil/analyze",
      headers: { authorization: "Bearer secret" },
      payload: {
        targets: [
          { packageName: "pkg", version: "1.0.0" },
          { packageName: "pkg", version: "1.0.0" },
          { packageName: "@scope/pkg", version: "2.0.0" }
        ],
        reason: "lockfile_scan",
        requestedBy: "anvil-cli"
      }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/analyze",
      headers: { authorization: "Bearer secret" },
      payload: { targets: [null] }
    });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_ANALYZE_INVALID" });
    expect(accepted.json()).toMatchObject({ ok: true, queued: 2 });
    expect(queuedJobs).toEqual([
      expect.objectContaining({ packageName: "pkg", version: "1.0.0", reason: "lockfile_scan", priority: "normal", requestedBy: "anvil-cli" }),
      expect.objectContaining({ packageName: "@scope/pkg", version: "2.0.0", reason: "lockfile_scan", priority: "normal", requestedBy: "anvil-cli" })
    ]);
    expect(await persistence.listAuditEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "analysis.enqueued", targetId: "pkg@1.0.0" }),
        expect.objectContaining({ eventType: "analysis.enqueued", targetId: "@scope/pkg@2.0.0" })
      ])
    );

    await app.close();
  });

  it("enqueues forced LLM review jobs behind the admin token", async () => {
    const persistence = new MemoryPersistence();
    const queue = new MemoryJobQueue();
    const app = buildGateway({
      config: loadConfig({
        ...process.env,
        ADMIN_TOKEN: "secret",
        LLM_REVIEW_ENABLED: "true",
        LLM_REVIEW_ENDPOINT: "https://llm.example.test/review",
        PERSISTENCE_DRIVER: "memory"
      }),
      persistence,
      queue,
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/-/anvil/llm-review",
      payload: { targets: [{ packageName: "pkg", version: "1.0.0" }] }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/-/anvil/llm-review",
      headers: { authorization: "Bearer secret" },
      payload: {
        targets: [
          { packageName: "pkg", version: "1.0.0" },
          { packageName: "pkg", version: "1.0.0" },
          { packageName: "@scope/pkg", version: "latest" }
        ],
        requestedBy: "reviewer"
      }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/llm-review",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: "pkg", priority: "urgent" }
    });
    const queuedJobs = [];
    for await (const job of queue.receiveAnalysisJobs()) queuedJobs.push(job);

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(202);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_LLM_REVIEW_INVALID" });
    expect(accepted.json()).toMatchObject({ ok: true, queued: 2 });
    expect(queuedJobs).toEqual([
      expect.objectContaining({ packageName: "pkg", version: "1.0.0", reason: "manual_review", priority: "high", requestedBy: "reviewer", runLlmReview: true }),
      expect.objectContaining({ packageName: "@scope/pkg", version: "latest", reason: "manual_review", priority: "high", requestedBy: "reviewer", runLlmReview: true })
    ]);
    expect(await persistence.listAuditEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "llm_review.enqueued", targetId: "pkg@1.0.0" }),
        expect.objectContaining({ eventType: "llm_review.enqueued", targetId: "@scope/pkg@latest" })
      ])
    );

    await app.close();
  });

  it("rejects forced LLM review requests when LLM review is disabled", async () => {
    const app = buildGateway({
      config: loadConfig({ ...process.env, PERSISTENCE_DRIVER: "memory" }),
      persistence: new MemoryPersistence(),
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/llm-review",
      payload: { packageName: "pkg", version: "1.0.0" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "ANVIL_LLM_REVIEW_DISABLED" });

    await app.close();
  });

  it("writes an audit event when an override is created", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-20T00:00:00.000Z"));
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret", PERSISTENCE_DRIVER: "memory" }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/override",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: " pkg ", version: " 1.0.0 ", reason: " intentional ", approvedBy: " reviewer " }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/override",
      headers: { authorization: "Bearer secret" },
      payload: { packageName: "pkg", reason: "intentional", action: "approve" }
    });

    expect(response.statusCode).toBe(201);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_OVERRIDE_INVALID" });
    expect(await persistence.getOverride("pkg", "1.0.0")).toMatchObject({
      reason: "intentional",
      expiresAt: "2026-06-19T00:00:00.000Z"
    });
    expect(await persistence.listAuditEvents()).toEqual([
      expect.objectContaining({
        actor: "reviewer",
        eventType: "override.created",
        targetId: "pkg@1.0.0",
        metadata: expect.objectContaining({ expiresAt: "2026-06-19T00:00:00.000Z" })
      })
    ]);

    await app.close();
    now.mockRestore();
  });

  it("accepts Node Base reports and writes an audit event", async () => {
    const persistence = new MemoryPersistence();
    const app = buildGateway({
      config: loadConfig({ ...process.env, ADMIN_TOKEN: "secret", PERSISTENCE_DRIVER: "memory" }),
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/-/anvil/node-base/reports",
      payload: { source: "devcontainer", reportType: "dependency", report: { summary: { high: 1 } } }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/node-base/reports",
      headers: { authorization: "Bearer secret" },
      payload: { source: "devcontainer", reportType: "../dependency", report: "not-json-object" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/-/anvil/node-base/reports",
      headers: { authorization: "Bearer secret" },
      payload: { source: " devcontainer ", projectName: " demo ", reportType: "dependency", report: { summary: { high: 1 } } }
    });

    expect(rejected.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_NODE_BASE_REPORT_INVALID" });
    expect(accepted.statusCode).toBe(201);
    expect(await persistence.listNodeBaseReports()).toEqual([
      expect.objectContaining({ source: "devcontainer", projectName: "demo", reportType: "dependency", summary: { high: 1 } })
    ]);
    expect(await persistence.listAuditEvents()).toEqual([
      expect.objectContaining({
        eventType: "node_base_report.submitted",
        targetType: "node_base_report"
      })
    ]);

    await app.close();
  });

  it("revokes overrides and invalidates cached policy decisions", async () => {
    const persistence = new MemoryPersistence();
    const config = testConfig("ci");
    await persistence.putOverride({ packageName: "pkg", version: "1.0.0", action: "allow", reason: "temporary", approvedBy: "reviewer" });
    await persistence.putPolicyDecision("pkg", "1.0.0", config.policy.version, {
      action: "allow",
      score: 0,
      reasons: [],
      explanation: "cached"
    });
    const app = buildGateway({
      config,
      persistence,
      queue: new MemoryJobQueue(),
      registry: {
        fetchMetadata: vi.fn(),
        fetchTarball: vi.fn()
      },
      downloadStats: noDownloadStats()
    });

    const response = await app.inject({
      method: "POST",
      url: "/-/anvil/override/revoke",
      payload: { packageName: " pkg ", version: " 1.0.0 ", revokedBy: " reviewer " }
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/-/anvil/override/revoke",
      payload: { packageName: "" }
    });

    expect(response.statusCode).toBe(200);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "ANVIL_OVERRIDE_REVOKE_INVALID" });
    expect(await persistence.getOverride("pkg", "1.0.0")).toBeUndefined();
    expect(await persistence.getPolicyDecision("pkg", "1.0.0", config.policy.version)).toBeUndefined();
    expect((await persistence.listAuditEvents())[0]).toMatchObject({ eventType: "override.revoked", targetId: "pkg@1.0.0" });

    await app.close();
  });
});

class TestObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  failHealthCheck = false;

  async healthCheck(): Promise<void> {
    if (this.failHealthCheck) throw new Error("object store unavailable");
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
}

class StaleMetadataPersistence extends MemoryPersistence {
  constructor(private readonly updatedAt: string) {
    super();
  }

  override async getMetadataRecord(packageName: string) {
    const metadata = await super.getMetadata(packageName);
    if (!metadata) return undefined;
    return {
      packageName,
      metadata,
      updatedAt: this.updatedAt
    };
  }
}

function noDownloadStats() {
  return {
    getWeeklyDownloads: vi.fn(async () => undefined)
  };
}

function packageMetadata(packageName: string, publishedAt: string): NpmPackageMetadata {
  const tarballPackageName = packageName.split("/").pop() ?? packageName;
  return {
    name: packageName,
    "dist-tags": {
      latest: "1.0.0"
    },
    time: {
      created: publishedAt,
      "1.0.0": publishedAt
    },
    versions: {
      "1.0.0": {
        name: packageName,
        version: "1.0.0",
        dist: {
          tarball: `https://registry.npmjs.org/${packageName}/-/${tarballPackageName}-1.0.0.tgz`,
          integrity: "sha512-test"
        }
      }
    }
  };
}
