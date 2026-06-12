import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../src/index.js";

describe("main", () => {
  it("prints help output", async () => {
    const output = await captureStdout(() => main(["help"]));

    expect(output).toContain("Anvil Cloud CLI");
    expect(output).toContain("anvil check");
  });

  it("emits AWS preview deployment plan and template JSON", async () => {
    const originalCwd = process.cwd();
    const originalExitCode = process.exitCode;
    const originalArtifactBucket = process.env.ANVIL_AWS_ARTIFACT_BUCKET;
    const originalMetadataTable =
      process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "anvil-cli-"));

    try {
      delete process.env.ANVIL_AWS_ARTIFACT_BUCKET;
      delete process.env.ANVIL_AWS_DEPLOYMENT_METADATA_TABLE;
      process.chdir(tempDir);
      await captureStdout(() => main(["new", "notes", "--json"]));
      process.chdir(path.join(tempDir, "notes"));

      const output = await captureStdout(() =>
        main(["deploy", "--preview", "--json"]),
      );
      const payload = JSON.parse(output) as Record<string, unknown>;

      expect(payload).toMatchObject({
        ok: false,
        code: "AWS_PROVISIONER_NOT_CONFIGURED",
        plan: {
          cell: "notes",
        },
        template: {
          Resources: {
            RuntimeFunction: {
              Type: "AWS::Lambda::Function",
            },
          },
        },
      });
    } finally {
      process.chdir(originalCwd);
      process.exitCode = originalExitCode;
      restoreEnv("ANVIL_AWS_ARTIFACT_BUCKET", originalArtifactBucket);
      restoreEnv("ANVIL_AWS_DEPLOYMENT_METADATA_TABLE", originalMetadataTable);
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";

  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();

    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
  }

  return output;
}
