import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cliPackageDir = fileURLToPath(new URL("..", import.meta.url));
const cloudRoot = path.resolve(cliPackageDir, "../..");
const repoRoot = path.resolve(cloudRoot, "..");

describe("agent-facing docs", () => {
  it("keeps llms mirrors in sync for website and package publishing", async () => {
    const [llms, full, siteFull, packageLlms, packageFull] =
      await Promise.all([
        readText(path.join(cloudRoot, "llms.txt")),
        readText(path.join(cloudRoot, "llms-full.txt")),
        readText(path.join(repoRoot, "anvil-website/public/llms-full.txt")),
        readText(path.join(cliPackageDir, "docs/llms.txt")),
        readText(path.join(cliPackageDir, "docs/llms-full.txt")),
      ]);

    expect(siteFull).toBe(full);
    expect(packageLlms).toBe(llms);
    expect(packageFull).toBe(full);
  });

  it("publishes the agent docs with the CLI package", async () => {
    const packageJson = JSON.parse(
      await readText(path.join(cliPackageDir, "package.json")),
    ) as { files?: string[] };

    expect(packageJson.files).toEqual(expect.arrayContaining(["docs"]));
  });

  it("documents the Cell and Agent rules agents need before authoring", async () => {
    const full = await readText(path.join(cloudRoot, "llms-full.txt"));

    expect(full).toContain("src/cell.server.ts");
    expect(full).toContain("defineAgent");
    expect(full).toContain("capabilities.outboundFetch.allow");
    expect(full).toContain("Do not use these in Cell authoring code");
    expect(full).toContain("anvil-cloud check --json");
    expect(full).toContain(
      "Effect is allowed only inside platform orchestration internals",
    );
  });
});

async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}
