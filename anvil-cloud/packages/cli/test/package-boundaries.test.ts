import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd(), "../..");
const publicPackages = new Set(["@anvilstack/cloud-cli"]);
const candidatePublicApiPackages = new Set([
  "@anvil-cloud/runtime",
  "@anvil-cloud/client",
]);

type PackageJson = {
  name: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: {
    access?: string;
  };
};

describe("package publishing boundaries", () => {
  it("keeps only intentional packages public", async () => {
    const packages = await readWorkspacePackages();
    const violations: Array<{
      packageName: string;
      message: string;
    }> = [];

    for (const packageJson of packages) {
      const shouldBePublic = publicPackages.has(packageJson.name);

      if (shouldBePublic) {
        if (packageJson.private !== false) {
          violations.push({
            packageName: packageJson.name,
            message: "public package must set private: false",
          });
        }

        if (packageJson.publishConfig?.access !== "public") {
          violations.push({
            packageName: packageJson.name,
            message: "public package must set publishConfig.access: public",
          });
        }

        for (const dependency of publishedWorkspaceDependencies(packageJson)) {
          violations.push({
            packageName: packageJson.name,
            message: `public package must not publish workspace dependency ${dependency}`,
          });
        }
      } else if (packageJson.private !== true) {
        violations.push({
          packageName: packageJson.name,
          message: "internal workspace package must remain private",
        });
      }

      if (
        candidatePublicApiPackages.has(packageJson.name) &&
        publicPackages.has(packageJson.name)
      ) {
        violations.push({
          packageName: packageJson.name,
          message:
            "candidate public API package must stay private until promoted deliberately",
        });
      }
    }

    expect(violations).toEqual([]);
  });
});

async function readWorkspacePackages(): Promise<PackageJson[]> {
  const workspaceGlobs = await readWorkspaceGlobs();
  const packages: PackageJson[] = [];

  for (const workspaceGlob of workspaceGlobs) {
    const workspaceDir = path.join(
      repoRoot,
      workspaceGlob.replace(/\/\*$/, ""),
    );
    const entries = await readdir(workspaceDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packagePath = path.join(workspaceDir, entry.name, "package.json");
      const packageJson = JSON.parse(
        await readFile(packagePath, "utf8"),
      ) as PackageJson;

      packages.push(packageJson);
    }
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function readWorkspaceGlobs(): Promise<string[]> {
  const workspace = await readFile(
    path.join(repoRoot, "pnpm-workspace.yaml"),
    "utf8",
  );

  return workspace
    .split("\n")
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = /^-\s+"([^"]+)"$/.exec(line);

      return match ? [match[1]] : [];
    });
}

function publishedWorkspaceDependencies(packageJson: PackageJson): string[] {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };

  return Object.entries(dependencies)
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name)
    .sort();
}
