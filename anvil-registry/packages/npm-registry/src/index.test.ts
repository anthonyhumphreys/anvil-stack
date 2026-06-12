import { afterEach, describe, expect, it, vi } from "vitest";
import { NpmDownloadsClient, NpmRegistryRouter, encodePackagePath, filterMetadataVersions, resolveMetadataVersion, rewriteMetadataTarballs, toVersionMetadata } from "./index.js";

describe("npm registry helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encodes scoped package metadata paths without collapsing the slash", () => {
    expect(encodePackagePath("@scope/pkg")).toBe("%40scope/pkg");
  });

  it("rewrites tarball URLs using the requested package metadata name", () => {
    const rewritten = rewriteMetadataTarballs(
      {
        name: "@scope/pkg",
        versions: {
          "1.0.0": {
            name: "mismatched-name",
            version: "1.0.0",
            dist: {
              tarball: "https://registry.example/mismatched-name/-/pkg-1.0.0.tgz"
            }
          }
        }
      },
      "https://anvil.example"
    );

    expect(rewritten.versions?.["1.0.0"]?.dist?.tarball).toBe("https://anvil.example/@scope/pkg/-/pkg-1.0.0.tgz");
  });

  it("resolves exact versions and arbitrary dist-tags from metadata", () => {
    const metadata = {
      name: "pkg",
      "dist-tags": { latest: "1.0.0", beta: "2.0.0-beta.1" },
      versions: {
        "1.0.0": { name: "pkg", version: "1.0.0" },
        "2.0.0-beta.1": { name: "pkg", version: "2.0.0-beta.1" }
      }
    };

    expect(resolveMetadataVersion(metadata, "1.0.0")).toBe("1.0.0");
    expect(resolveMetadataVersion(metadata, "latest")).toBe("1.0.0");
    expect(resolveMetadataVersion(metadata, "beta")).toBe("2.0.0-beta.1");
    expect(resolveMetadataVersion(metadata, "missing")).toBeUndefined();
  });

  it("removes filtered versions from npm time metadata", () => {
    const filtered = filterMetadataVersions(
      {
        name: "pkg",
        "dist-tags": { latest: "2.0.0" },
        time: {
          created: "2020-01-01T00:00:00.000Z",
          modified: "2020-01-03T00:00:00.000Z",
          "1.0.0": "2020-01-01T00:00:00.000Z",
          "2.0.0": "2020-01-02T00:00:00.000Z"
        },
        versions: {
          "1.0.0": { name: "pkg", version: "1.0.0" },
          "2.0.0": { name: "pkg", version: "2.0.0" }
        }
      },
      new Map([
        [
          "2.0.0",
          {
            action: "block",
            score: 95,
            reasons: [{ code: "NEW_INSTALL_SCRIPT", message: "blocked", severity: "critical" }],
            explanation: "blocked"
          }
        ]
      ]),
      { hideQuarantined: true }
    );

    expect(filtered.versions).not.toHaveProperty("2.0.0");
    expect(filtered.time).toMatchObject({ created: "2020-01-01T00:00:00.000Z", modified: "2020-01-03T00:00:00.000Z", "1.0.0": "2020-01-01T00:00:00.000Z" });
    expect(filtered.time).not.toHaveProperty("2.0.0");
  });

  it("fetches weekly download counts from the npm downloads API", async () => {
    const fetch = vi.fn(async () => Response.json({ downloads: 42 }));
    vi.stubGlobal("fetch", fetch);

    const client = new NpmDownloadsClient({ baseUrl: "https://api.npmjs.org/downloads/" });
    await expect(client.getWeeklyDownloads("@scope/pkg")).resolves.toBe(42);

    expect(fetch).toHaveBeenCalledWith("https://api.npmjs.org/downloads/point/last-week/%40scope%2Fpkg");
  });

  it("routes scoped package metadata to matching upstream registries", async () => {
    const fetch = vi.fn(async (url: string) => Response.json({ name: url.includes("npm.pkg.example.test") ? "@internal/pkg" : "left-pad" }));
    vi.stubGlobal("fetch", fetch);
    const router = new NpmRegistryRouter([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      { name: "internal", baseUrl: "https://npm.pkg.example.test", scopes: ["@internal"], authToken: "secret" }
    ]);

    await expect(router.fetchMetadata("@internal/pkg")).resolves.toMatchObject({ name: "@internal/pkg" });
    await expect(router.fetchMetadata("left-pad")).resolves.toMatchObject({ name: "left-pad" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://npm.pkg.example.test/%40internal/pkg",
      expect.objectContaining({ headers: { authorization: "Bearer secret" } })
    );
    expect(fetch).toHaveBeenNthCalledWith(2, "https://registry.npmjs.org/left-pad", expect.objectContaining({ headers: undefined }));
    expect(router.resolveRegistryName("@internal/pkg")).toBe("internal");
  });

  it("uses registry-matched credentials when fetching tarballs", async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetch);
    const router = new NpmRegistryRouter([
      { name: "npmjs", baseUrl: "https://registry.npmjs.org" },
      { name: "internal", baseUrl: "https://npm.pkg.example.test/npm/", scopes: ["@internal"], authToken: "secret" }
    ]);

    await expect(router.fetchTarball("https://npm.pkg.example.test/npm/@internal/pkg/-/pkg-1.0.0.tgz")).resolves.toEqual(new Uint8Array([1, 2, 3]));

    expect(fetch).toHaveBeenCalledWith(
      "https://npm.pkg.example.test/npm/@internal/pkg/-/pkg-1.0.0.tgz",
      expect.objectContaining({ headers: { authorization: "Bearer secret" } })
    );
  });

  it("treats missing download stats as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));

    const client = new NpmDownloadsClient({ baseUrl: "https://api.npmjs.org/downloads" });

    await expect(client.getWeeklyDownloads("private-ish")).resolves.toBeUndefined();
  });

  it("maps npm provenance attestations from version metadata", () => {
    const version = toVersionMetadata(
      {
        name: "pkg",
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0",
            dist: {
              tarball: "https://registry.example/pkg/-/pkg-1.0.0.tgz",
              attestations: {
                url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
              }
            }
          }
        }
      },
      "1.0.0"
    );

    expect(version?.provenance).toEqual({
      present: true,
      source: "dist.attestations",
      attestationUrl: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0",
      raw: {
        url: "https://registry.example/-/npm/v1/attestations/pkg@1.0.0"
      }
    });
  });

  it("marks provenance as absent when npm metadata has no provenance fields", () => {
    const version = toVersionMetadata(
      {
        name: "pkg",
        versions: {
          "1.0.0": {
            name: "pkg",
            version: "1.0.0"
          }
        }
      },
      "1.0.0"
    );

    expect(version?.provenance).toEqual({ present: false });
  });

  it("preserves the package private flag from npm version metadata", () => {
    const version = toVersionMetadata(
      {
        name: "@scope/private-pkg",
        versions: {
          "1.0.0": {
            name: "@scope/private-pkg",
            version: "1.0.0",
            private: true
          }
        }
      },
      "1.0.0"
    );

    expect(version?.private).toBe(true);
  });
});
