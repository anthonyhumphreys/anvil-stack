import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { buildGateway, type GatewayDependencies } from "../apps/gateway/src/app.js";
import { loadConfig } from "../packages/config/src/index.js";

const packageName = "@private/anvil-smoke";
const version = "1.0.0";
const tarballName = "anvil-smoke-1.0.0.tgz";
const token = "scoped-smoke-token";
const tarballBytes = new TextEncoder().encode("anvil scoped upstream smoke tarball\n");

type SeenRequest = {
  path: string;
  authorization?: string;
};

const seenRequests: SeenRequest[] = [];
const cacheDir = await mkdtemp(path.join(tmpdir(), "anvil-scoped-upstream-"));
let upstream: http.Server | undefined;
let gateway: ReturnType<typeof buildGateway> | undefined;

try {
  const upstreamPort = await freePort();
  const gatewayPort = await freePort();
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  upstream = await startMockScopedRegistry(upstreamPort, upstreamBaseUrl);

  const config = loadConfig({
    RUNTIME_MODE: "development",
    PUBLIC_BASE_URL: gatewayBaseUrl,
    CACHE_DIR: cacheDir,
    UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
    SCOPED_SMOKE_NPM_TOKEN: token,
    UPSTREAM_NPM_REGISTRIES_JSON: JSON.stringify([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      { name: "private-smoke", baseUrl: upstreamBaseUrl, scopes: ["@private"], authTokenSecretName: "SCOPED_SMOKE_NPM_TOKEN" }
    ]),
    NPM_METADATA_CACHE_TTL_SECONDS: "300",
    POLICY_MINIMUM_PACKAGE_AGE_DAYS: "7",
    POLICY_PROVENANCE_HIGH_DOWNLOAD_THRESHOLD: "100000"
  }) as NonNullable<GatewayDependencies["config"]>;

  gateway = buildGateway({
    config,
    downloadStats: {
      async getWeeklyDownloads() {
        return 50_000;
      }
    }
  });
  await gateway.listen({ host: "127.0.0.1", port: gatewayPort });

  const ready = await fetchJson(`${gatewayBaseUrl}/-/ready`);
  assert.equal(ready.ok, true);
  assert.deepEqual(ready.upstreamRegistries, [
    { name: "npmjs", baseUrl: "https://registry.npmjs.org", scopes: [] },
    { name: "private-smoke", baseUrl: upstreamBaseUrl, scopes: ["@private"] }
  ]);
  assert.equal(JSON.stringify(ready).includes(token), false, "readiness response must not leak upstream auth tokens");

  const metadataResponse = await fetch(`${gatewayBaseUrl}/@private/anvil-smoke`);
  await assertOk(metadataResponse);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.name, packageName);
  assert.equal(
    metadata.versions?.[version]?.dist?.tarball,
    `${gatewayBaseUrl}/@private/anvil-smoke/-/${tarballName}`
  );

  const tarballResponse = await fetch(metadata.versions[version].dist.tarball);
  await assertOk(tarballResponse);
  assert.equal(tarballResponse.headers.get("x-anvil-cache"), "miss");
  assert.deepEqual(new Uint8Array(await tarballResponse.arrayBuffer()), tarballBytes);

  const cachedTarballResponse = await fetch(metadata.versions[version].dist.tarball);
  await assertOk(cachedTarballResponse);
  assert.equal(cachedTarballResponse.headers.get("x-anvil-cache"), "hit");
  assert.deepEqual(new Uint8Array(await cachedTarballResponse.arrayBuffer()), tarballBytes);

  const metadataRequests = seenRequests.filter((request) => request.path === "/@private/anvil-smoke");
  const tarballRequests = seenRequests.filter((request) => request.path === `/@private/anvil-smoke/-/${tarballName}`);
  assert.equal(metadataRequests.length, 1, "metadata should be fetched once and then served from Anvil metadata cache");
  assert.equal(tarballRequests.length, 1, "tarball should be fetched once and then served from Anvil object cache");
  assert.equal(
    seenRequests.every((request) => request.authorization === `Bearer ${token}`),
    true,
    "all scoped upstream requests must carry the configured bearer token"
  );

  console.log("[anvil] Scoped upstream smoke passed.");
} finally {
  if (gateway) await gateway.close();
  if (upstream) await closeServer(upstream);
  await rm(cacheDir, { recursive: true, force: true });
}

async function startMockScopedRegistry(port: number, baseUrl: string) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", baseUrl);
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    seenRequests.push({
      path: decodedPath,
      authorization: request.headers.authorization
    });

    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "mock scoped registry requires bearer auth" });
      return;
    }

    if (decodedPath === "/@private/anvil-smoke") {
      sendJson(response, 200, metadata(baseUrl));
      return;
    }

    if (decodedPath === `/@private/anvil-smoke/-/${tarballName}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(tarballBytes);
      return;
    }

    sendJson(response, 404, { error: "not found", path: decodedPath });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

function metadata(baseUrl: string) {
  return {
    name: packageName,
    "dist-tags": {
      latest: version
    },
    time: {
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-02T00:00:00.000Z",
      [version]: "2026-01-01T00:00:00.000Z"
    },
    versions: {
      [version]: {
        name: packageName,
        version,
        private: true,
        dist: {
          tarball: `${baseUrl}/@private/anvil-smoke/-/${tarballName}`,
          integrity: "sha512-scoped-smoke",
          shasum: "scoped-smoke"
        }
      }
    }
  };
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  await assertOk(response);
  return (await response.json()) as Record<string, unknown>;
}

async function assertOk(response: Response) {
  if (response.status === 200) return;
  assert.equal(response.status, 200, await response.text());
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function closeServer(server: http.Server | net.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
