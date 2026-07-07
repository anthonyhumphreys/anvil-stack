import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentManifest, defineAgent } from "@anvil-cloud/runtime";
import { describe, expect, it } from "vitest";

import {
  createLocalSandboxProvider,
  listLocalSandboxSessions,
  LocalDockerSandboxProvider,
  LocalProcessSandboxProvider,
  selectLocalSandboxBackend,
  type DockerCommandRunner,
  type LocalSandboxProvider,
} from "../src/index.js";

describe("local Agent Sandbox providers", () => {
  const fixedDate = new Date("2026-07-06T10:00:00.000Z");

  for (const backend of ["process", "docker"] as const) {
    it(`runs the sandbox lifecycle and conformance policy checks for ${backend}`, async () => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-sandbox-"));
      const dockerCommands: string[][] = [];
      const dockerCommand: DockerCommandRunner = async (args) => {
        dockerCommands.push(args);

        return args[0] === "create" ? { stdout: "container_123\n" } : {};
      };
      const provider: LocalSandboxProvider =
        backend === "docker"
          ? new LocalDockerSandboxProvider({
              rootDir,
              dockerCommand,
              idFactory: () => "docker-id",
              now: () => fixedDate,
            })
          : new LocalProcessSandboxProvider({
              rootDir,
              idFactory: () => "process-id",
              now: () => fixedDate,
            });
      const manifest = createAgentManifest(
        defineAgent({
          name: "repo-agent",
          model: { provider: "local", model: "stub" },
          capabilities: {
            filesystem: "read-write",
            network: { allow: ["github.com"] },
            secrets: "brokered",
          },
          credentialBroker: {
            credentials: [
              {
                credential: "GITHUB_TOKEN",
                domains: ["github.com"],
                inject: {
                  kind: "header",
                  name: "authorization",
                  scheme: "bearer",
                },
              },
            ],
          },
          runtime: { sandbox: "required" },
        }),
      );

      try {
        const session = await provider.start({
          manifest,
          cell: "notes",
          environment: "local",
        });

        expect(session).toMatchObject({
          agent: "repo-agent",
          status: "active",
          provider: `local-${backend}`,
          startedAt: fixedDate.toISOString(),
        });

        const records = await listLocalSandboxSessions({ rootDir });
        const [record] = records;

        expect(record).toMatchObject({
          backend,
          policy: {
            network: { allow: ["github.com"] },
            credentialBroker: {
              credentials: [
                {
                  credential: "GITHUB_TOKEN",
                  domains: ["github.com"],
                },
              ],
            },
          },
        });
        expect(record.workspaceRoot).toContain(
          path.join(".anvil", "local", "sandboxes"),
        );
        expect(JSON.stringify(record)).not.toContain("ghp_");
        await writeFile(path.join(record.workspaceRoot, "probe.txt"), "ok");

        await provider.suspend(session.id);
        await expect(provider.inspect(session.id)).resolves.toMatchObject({
          status: "suspended",
        });

        await expect(provider.resume(session.id)).resolves.toMatchObject({
          status: "active",
        });

        await provider.terminate(session.id);
        await expect(provider.inspect(session.id)).resolves.toMatchObject({
          status: "terminated",
          terminatedAt: fixedDate.toISOString(),
        });
        await expect(stat(record.workspaceRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });

        if (backend === "docker") {
          expect(dockerCommands).toEqual(
            expect.arrayContaining([
              expect.arrayContaining(["create"]),
              ["start", expect.stringContaining("anvil-sandbox-repo-agent")],
              ["stop", expect.stringContaining("anvil-sandbox-repo-agent")],
              ["start", expect.stringContaining("anvil-sandbox-repo-agent")],
              ["rm", "-f", expect.stringContaining("anvil-sandbox-repo-agent")],
            ]),
          );
        }
      } finally {
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  }

  it("selects docker automatically when docker is available", async () => {
    await expect(
      selectLocalSandboxBackend({ dockerAvailable: async () => true }),
    ).resolves.toBe("docker");
  });

  it("falls back to process when docker is unavailable", async () => {
    await expect(
      selectLocalSandboxBackend({ dockerAvailable: async () => false }),
    ).resolves.toBe("process");
  });

  it("honors explicit backend overrides", async () => {
    const provider = await createLocalSandboxProvider({
      backend: "process",
      dockerAvailable: async () => true,
    });

    expect(provider).toBeInstanceOf(LocalProcessSandboxProvider);
  });

  it("sanitizes client tokens before using them as session ids", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "anvil-sandbox-"));
    const provider = new LocalProcessSandboxProvider({
      rootDir,
      now: () => fixedDate,
    });
    const manifest = createAgentManifest(
      defineAgent({
        name: "safe-agent",
        model: { provider: "local", model: "stub" },
        runtime: { sandbox: "required" },
      }),
    );

    try {
      const session = await provider.start({
        manifest,
        cell: "notes",
        environment: "local",
        clientToken: "../unsafe/token",
      });

      expect(session.id).toBe("unsafe-token");
      expect(session.id).not.toContain("/");
      await expect(provider.inspect(session.id)).resolves.toMatchObject({
        id: "unsafe-token",
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
