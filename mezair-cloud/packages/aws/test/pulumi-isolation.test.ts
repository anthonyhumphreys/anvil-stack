import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");

describe("Pulumi package boundary", () => {
  it("keeps public authoring and local runtime packages Pulumi-free", async () => {
    for (const packagePath of [
      "packages/runtime/package.json",
      "packages/local/package.json",
    ]) {
      const pkg = JSON.parse(
        await readFile(path.join(repo, packagePath), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(
        Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
      ).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^@pulumi\//)]),
      );
    }
  });
});
