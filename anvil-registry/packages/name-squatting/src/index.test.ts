import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  detectNameSquatting,
  encodePopularPackageIndex,
  jaroWinklerSimilarity,
  loadActivePopularPackageIndex,
  loadPopularPackageIndex,
  loadPopularPackageIndexFromObjectStore,
  parsePopularPackageIndex,
  popularPackageIndexDatedObjectKey
} from "./index.js";

describe("detectNameSquatting", () => {
  it("detects tanstack confusion", () => {
    expect(detectNameSquatting("@tenstack/react-query")[0]).toMatchObject({
      candidate: "@tanstack/react-query",
      suggestedPackage: "@tanstack/react-query",
      reasons: expect.arrayContaining(["known_ecosystem_confusion"])
    });
  });

  it("detects lodash typo", () => {
    expect(detectNameSquatting("loadash")[0]).toMatchObject({
      candidate: "lodash",
      reasons: expect.arrayContaining(["known_ecosystem_confusion"])
    });
  });

  it("detects vite scope confusion", () => {
    expect(detectNameSquatting("@vite/plugin-react")[0]).toMatchObject({
      candidate: "@vitejs/plugin-react",
      reasons: expect.arrayContaining(["known_ecosystem_confusion", "similar_scope"])
    });
  });

  it("treats exact package names across scopes as scope confusion", () => {
    const unscoped = detectNameSquatting("react-query", [{ name: "@tanstack/react-query", weeklyDownloads: 4_000_000 }])[0];
    const scoped = detectNameSquatting("@unknown/lodash", [{ name: "lodash", weeklyDownloads: 60_000_000 }])[0];

    expect(unscoped).toMatchObject({
      candidate: "@tanstack/react-query",
      similarity: 1,
      suggestedPackage: "@tanstack/react-query",
      reasons: expect.arrayContaining(["scope_confusion", "high_name_similarity"])
    });
    expect(scoped).toMatchObject({
      candidate: "lodash",
      similarity: 1,
      suggestedPackage: "lodash",
      reasons: expect.arrayContaining(["scope_confusion", "high_name_similarity"])
    });
  });

  it("labels edit-pattern variants", () => {
    const missing = detectNameSquatting("lodsh", [{ name: "lodash" }])[0];
    const extra = detectNameSquatting("loadash", [{ name: "lodash" }])[0];
    const transposed = detectNameSquatting("lodahs", [{ name: "lodash" }])[0];

    expect(missing?.reasons).toContain("missing_character");
    expect(extra?.reasons).toContain("extra_character");
    expect(transposed?.reasons).toContain("transposed_characters");
  });

  it("labels pluralisation and visual variants", () => {
    expect(detectNameSquatting("reacts", [{ name: "react" }])[0]?.reasons).toContain("pluralisation_variant");
    expect(detectNameSquatting("l0dash", [{ name: "lodash" }])[0]?.reasons).toContain("visual_similarity");
  });

  it("uses Jaro-Winkler similarity as an additional signal", () => {
    expect(jaroWinklerSimilarity("fastfy", "fastify")).toBeGreaterThan(0.9);
    expect(detectNameSquatting("fastfy", [{ name: "fastify" }])[0]?.reasons).toContain("high_jaro_winkler_similarity");
  });

  it("does not flag legitimate scoped declaration packages as squats of their runtime package", () => {
    expect(detectNameSquatting("@types/isarray", [{ name: "isarray", weeklyDownloads: 1_000_000 }])).toEqual([]);
    expect(detectNameSquatting("@types/call-bind", [{ name: "call-bind", weeklyDownloads: 1_000_000 }])).toEqual([]);
    expect(detectNameSquatting("@types/array.prototype.every", [{ name: "array.prototype.every", weeklyDownloads: 1_000_000 }])).toEqual([]);
  });

  it("does not treat longer prefix names as typos without typo-like evidence", () => {
    expect(detectNameSquatting("vitepress", [{ name: "vite", weeklyDownloads: 20_000_000 }])).toEqual([]);
    expect(detectNameSquatting("eslint-plugin-react", [{ name: "eslint", weeklyDownloads: 20_000_000 }])).toEqual([]);
  });

  it("loads a configurable popular package index", () => {
    const directory = mkdtempSync(join(tmpdir(), "anvil-popular-index-"));
    const indexPath = join(directory, "latest.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        generatedAt: "2026-05-20T00:00:00.000Z",
        popularPackages: [{ name: "@scope/actual-package", weeklyDownloads: 123_000, aliases: ["actual-package"] }],
        knownConfusions: { "@scope/actua1-package": "@scope/actual-package" }
      })
    );

    try {
      const index = loadPopularPackageIndex(indexPath);
      expect(index).toMatchObject({
        generatedAt: "2026-05-20T00:00:00.000Z",
        source: indexPath,
        popularPackages: [{ name: "@scope/actual-package", weeklyDownloads: 123_000, aliases: ["actual-package"] }],
        knownConfusions: { "@scope/actua1-package": "@scope/actual-package" }
      });
      expect(detectNameSquatting("@scope/actua1-package", index)[0]).toMatchObject({
        candidate: "@scope/actual-package",
        suggestedPackage: "@scope/actual-package",
        reasons: expect.arrayContaining(["known_ecosystem_confusion"])
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats exact popular-package aliases as known ecosystem confusion evidence", () => {
    const [signal] = detectNameSquatting("loadash", {
      source: "test",
      popularPackages: [{ name: "lodash", weeklyDownloads: 60_000_000, aliases: ["loadash"] }],
      knownConfusions: {}
    });

    expect(signal).toMatchObject({
      candidate: "lodash",
      suggestedPackage: "lodash",
      reasons: expect.arrayContaining(["known_ecosystem_confusion"])
    });
  });

  it("rejects malformed popular package indexes", () => {
    expect(() => parsePopularPackageIndex({ popularPackages: [{ weeklyDownloads: -1 }] })).toThrow("Popular package entries require a name.");
  });

  it("loads and encodes object-store backed indexes", async () => {
    const index = parsePopularPackageIndex({
      generatedAt: "2026-05-20T12:30:00.000Z",
      popularPackages: [{ name: "real-package", weeklyDownloads: 50_000 }],
      knownConfusions: { "rea1-package": "real-package" }
    });
    const store = new Map<string, Uint8Array>([["popular-index/npm/latest.json", encodePopularPackageIndex(index)]]);

    const loaded = await loadPopularPackageIndexFromObjectStore({ get: async (key) => store.get(key) });
    const active = await loadActivePopularPackageIndex({ objectStore: { get: async (key) => store.get(key) }, objectKey: "popular-index/npm/latest.json" });

    expect(loaded).toMatchObject({
      source: "object:popular-index/npm/latest.json",
      popularPackages: [{ name: "real-package", weeklyDownloads: 50_000 }],
      knownConfusions: { "rea1-package": "real-package" }
    });
    expect(active.source).toBe("object:popular-index/npm/latest.json");
    expect(popularPackageIndexDatedObjectKey("2026-05-20T12:30:00.000Z")).toBe("popular-index/npm/2026-05-20.json");
  });
});
