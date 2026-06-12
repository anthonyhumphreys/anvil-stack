import { describe, expect, it, vi } from "vitest";
import { parseLockfile, parseTarget, run, type CliDependencies } from "./index.js";

describe("cli", () => {
  it("parses scoped package targets", () => {
    expect(parseTarget("@tanstack/react-query@5.0.0")).toEqual({ packageName: "@tanstack/react-query", version: "5.0.0" });
    expect(parseTarget("@tanstack/react-query")).toEqual({ packageName: "@tanstack/react-query", version: "latest" });
  });

  it("parses package-lock dependencies", async () => {
    const targets = await parseLockfile("package-lock.json", async () =>
      JSON.stringify({
        packages: {
          "": { version: "1.0.0" },
          "node_modules/@scope/pkg": { version: "1.2.3" },
          "node_modules/lodash": { version: "4.17.21" },
          "node_modules/a/node_modules/b": { version: "1.0.0" },
          "node_modules/a/node_modules/@deep/pkg": { version: "2.0.0" }
        },
        dependencies: {
          top: {
            version: "3.0.0",
            dependencies: {
              nested: { version: "4.0.0" },
              "@nested/scope": { version: "5.0.0" }
            }
          }
        }
      })
    );

    expect(targets).toEqual([
      { packageName: "@deep/pkg", version: "2.0.0" },
      { packageName: "@nested/scope", version: "5.0.0" },
      { packageName: "@scope/pkg", version: "1.2.3" },
      { packageName: "b", version: "1.0.0" },
      { packageName: "lodash", version: "4.17.21" },
      { packageName: "nested", version: "4.0.0" },
      { packageName: "top", version: "3.0.0" }
    ]);
  });

  it("parses pnpm lock package entries", async () => {
    const targets = await parseLockfile(
      "pnpm-lock.yaml",
      async () => `lockfileVersion: '9.0'

packages:

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-test}

  '@scope/alias@npm:@scope/real@2.3.4':
    resolution: {integrity: sha512-test}

  '@tooling/bundler@6.3.5(@types/node@22.15.29)(tsx@4.19.4)(yaml@2.8.0)':
    resolution: {integrity: sha512-test}

  lodash@4.17.21:
    resolution: {integrity: sha512-test}

importers:
  .: {}
`
    );

    expect(targets).toEqual([
      { packageName: "@scope/pkg", version: "1.2.3" },
      { packageName: "@scope/real", version: "2.3.4" },
      { packageName: "@tooling/bundler", version: "6.3.5" },
      { packageName: "lodash", version: "4.17.21" }
    ]);
  });

  it("parses Yarn lock package entries", async () => {
    const targets = await parseLockfile(
      "yarn.lock",
      async () => `# yarn lockfile v1

"@scope/pkg@^1.0.0", "@scope/pkg@~1.2.0":
  version "1.2.3"
  resolved "https://registry.yarnpkg.com/@scope/pkg/-/pkg-1.2.3.tgz"

left-pad@^1.3.0:
  version "1.3.0"

alias-left-pad@npm:left-pad@^1.3.0:
  version "1.3.0"

"@tooling/bundler@npm:^6.0.0":
  version: 6.3.5
  resolution: "@tooling/bundler@npm:6.3.5"

"workspace-pkg@workspace:*":
  version: 0.0.0-use.local
`
    );

    expect(targets).toEqual([
      { packageName: "@scope/pkg", version: "1.2.3" },
      { packageName: "@tooling/bundler", version: "6.3.5" },
      { packageName: "left-pad", version: "1.3.0" }
    ]);
  });

  it("parses package.json registry dependencies and npm aliases", async () => {
    const targets = await parseLockfile(
      "package.json",
      async () => JSON.stringify({
        dependencies: {
          "alias-left-pad": "npm:left-pad@^1.3.0",
          "@scope/alias": "npm:@scope/real@^2.0.0",
          react: "^19.0.0",
          local: "file:../local"
        },
        devDependencies: {
          "workspace-tool": "workspace:*",
          typescript: "^5.8.0"
        }
      })
    );

    expect(targets).toEqual([
      { packageName: "@scope/real", version: "latest" },
      { packageName: "left-pad", version: "latest" },
      { packageName: "react", version: "latest" },
      { packageName: "typescript", version: "latest" }
    ]);
  });

  it("explains a package using the gateway", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "pkg",
          version: "1.0.0",
          decision: {
            action: "allow",
            score: 0,
            reasons: [],
            explanation: "pkg@1.0.0 is allowed by deterministic policy."
          }
        })
      ),
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["explain", "pkg@1.0.0"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/explain",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ packageName: "pkg", version: "1.0.0" }) })
    );
    expect(writes.join("")).toContain("Anvil allowed pkg@1.0.0");
  });

  it("prints analysis and LLM review context from explain responses", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "pkg",
          version: "1.0.0",
          decision: {
            action: "quarantine",
            score: 55,
            reasons: [{ code: "LLM_RISK_REVIEW_FLAGGED", message: "Install path behavior needs human review.", severity: "high" }],
            explanation: "pkg@1.0.0 is quarantined by deterministic policy."
          },
          analysisReport: {
            packageName: "pkg",
            version: "1.0.0",
            analyserVersion: "static-analysis-test",
            policyVersion: "test-policy",
            score: 25,
            signals: [{ code: "USES_PROCESS_ENV", message: "Package reads process.env in install-path code.", severity: "medium" }],
            createdAt: "2026-05-20T12:00:00.000Z"
          },
          llmRiskReviews: [
            {
              packageName: "pkg",
              version: "1.0.0",
              provider: "test-provider",
              model: "risk-reviewer",
              review: {
                riskLevel: "high",
                confidence: "medium",
                summary: "Install path behavior needs human review.",
                suspectedRiskTypes: ["install_script_abuse"],
                evidence: [{ signal: "USES_PROCESS_ENV", explanation: "Environment access in install-path code.", source: "code_snippet" }],
                recommendedAction: "quarantine"
              },
              createdAt: "2026-05-20T12:00:01.000Z"
            }
          ]
        })
      ),
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["explain", "pkg@1.0.0"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Analysis:");
    expect(writes.join("")).toContain("analyser: static-analysis-test");
    expect(writes.join("")).toContain("signals: USES_PROCESS_ENV");
    expect(writes.join("")).toContain("LLM review:");
    expect(writes.join("")).toContain("test-provider/risk-reviewer: high confidence=medium recommendation=quarantine");
    expect(writes.join("")).toContain("suspected risks: install_script_abuse");
  });

  it("ignores the pnpm argument separator", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true, upstream: "https://registry.npmjs.org", runtimeMode: "development" }))
    });

    await expect(run(["--", "doctor"], dependencies)).resolves.toBe(0);
  });

  it("prints readiness component failures from doctor", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/-/ready")) {
          return new Response(
            JSON.stringify({
              ok: false,
              upstream: "https://registry.npmjs.org",
              checks: [
                { component: "persistence", ok: true },
                { component: "queue", ok: false, error: "queue unavailable" }
              ]
            }),
            { status: 503, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse({ runtimeMode: "ci" });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["doctor"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Anvil gateway: not ready");
    expect(writes.join("")).toContain("Readiness checks:");
    expect(writes.join("")).toContain("- persistence: ok");
    expect(writes.join("")).toContain("- queue: failed (queue unavailable)");
  });

  it("reports non-JSON failed responses with their HTTP status", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" }))
    });

    const exitCode = await run(["doctor"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Anvil request failed (502): upstream unavailable"));
  });

  it("scans lockfiles and fails for blocked packages", async () => {
    const dependencies = fakeDependencies({
      readFile: vi.fn(async () =>
        JSON.stringify({
          packages: {
            "node_modules/bad-pkg": { version: "1.0.0" }
          }
        })
      ),
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "bad-pkg",
          version: "1.0.0",
          decision: {
            action: "block",
            score: 95,
            reasons: [{ code: "SIMILAR_TO_POPULAR_PACKAGE", message: "Looks like something else.", severity: "critical" }],
            explanation: "bad-pkg@1.0.0 is blocked by deterministic policy."
          }
        })
      )
    });

    await expect(run(["scan", "package-lock.json"], dependencies)).resolves.toBe(1);
  });

  it("queues risky and unreviewed package analysis during scans when requested", async () => {
    const writes: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://anvil.test/-/anvil/explain") {
        const body = JSON.parse(String(init?.body)) as { packageName: string; version: string };
        const action = body.packageName === "bad-pkg" ? "block" : "allow";
        return jsonResponse({
          packageName: body.packageName,
          version: body.version,
          decision: {
            action,
            score: action === "block" ? 95 : 0,
            reasons: action === "block" ? [{ code: "SIMILAR_TO_POPULAR_PACKAGE", message: "Looks like something else.", severity: "critical" }] : [],
            explanation: `${body.packageName}@${body.version} is ${action}.`
          },
          ...(body.packageName === "reviewed-pkg"
            ? {
                analysisReport: {
                  packageName: "reviewed-pkg",
                  version: body.version,
                  analyserVersion: "static-analysis-test",
                  policyVersion: "test-policy",
                  score: 0,
                  signals: [],
                  createdAt: "2026-05-20T12:00:00.000Z"
                }
              }
            : {})
        });
      }
      if (url === "http://anvil.test/-/anvil/analyze") {
        expect(init).toMatchObject({ method: "POST" });
        expect(JSON.parse(String(init?.body))).toEqual({
          targets: [
            { packageName: "bad-pkg", version: "1.0.0" },
            { packageName: "unreviewed-pkg", version: "2.0.0" }
          ],
          reason: "lockfile_scan",
          priority: "normal",
          requestedBy: "anvil-cli"
        });
        return jsonResponse({ ok: true, queued: 2 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const dependencies = fakeDependencies({
      readFile: vi.fn(async () =>
        JSON.stringify({
          packages: {
            "node_modules/bad-pkg": { version: "1.0.0" },
            "node_modules/unreviewed-pkg": { version: "2.0.0" },
            "node_modules/reviewed-pkg": { version: "3.0.0" }
          }
        })
      ),
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["scan", "--queue-analysis", "package-lock.json"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Queued analysis for 2 risky or unreviewed package versions from package-lock.json.");
  });

  it("warms metadata and queues lockfile analysis jobs", async () => {
    const writes: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://anvil.test/pkg" || url === "http://anvil.test/%40scope/pkg") return jsonResponse({ ok: true });
      if (url === "http://anvil.test/-/anvil/analyze") {
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({ authorization: "Bearer secret" })
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          targets: [
            { packageName: "@scope/pkg", version: "2.0.0" },
            { packageName: "pkg", version: "1.0.0" }
          ],
          reason: "lockfile_scan",
          priority: "normal",
          requestedBy: "anvil-cli"
        });
        return jsonResponse({ ok: true, queued: 2 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const dependencies = fakeDependencies({
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" },
      readFile: vi.fn(async () =>
        JSON.stringify({
          packages: {
            "node_modules/pkg": { version: "1.0.0" },
            "node_modules/@scope/pkg": { version: "2.0.0" }
          }
        })
      ),
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["warm", "package-lock.json"], dependencies);

    expect(exitCode).toBe(0);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/pkg", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/%40scope/pkg", undefined);
    expect(writes.join("")).toContain("Warmed metadata and policy decisions for 2 packages from package-lock.json.");
    expect(writes.join("")).toContain("Queued analysis for 2 package versions from package-lock.json.");
  });

  it("tests package.json dependency policy through the gateway", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      readFile: vi.fn(async () =>
        JSON.stringify({
          dependencies: {
            "bad-pkg": "^1.0.0",
            "ok-pkg": "^2.0.0"
          },
          devDependencies: {
            "warn-pkg": "^3.0.0"
          },
          optionalDependencies: {
            "file-pkg": "file:../file-pkg"
          }
        })
      ),
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { packageName: string; version: string };
        const action = body.packageName === "bad-pkg" ? "block" : body.packageName === "warn-pkg" ? "warn" : "allow";
        return jsonResponse({
          packageName: body.packageName,
          version: "latest",
          decision: {
            action,
            score: action === "block" ? 95 : action === "warn" ? 20 : 0,
            reasons:
              action === "allow"
                ? []
                : [{ code: action === "block" ? "SIMILAR_TO_POPULAR_PACKAGE" : "LOW_WEEKLY_DOWNLOADS", message: `${body.packageName} needs review.`, severity: action === "block" ? "critical" : "medium" }],
            explanation: `${body.packageName} is ${action}.`
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["policy", "test", "package.json"], dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.fetch).toHaveBeenCalledTimes(3);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/explain",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ packageName: "bad-pkg", version: "latest" }) })
    );
    expect(writes.join("")).toContain("Tested 3 dependency names from package.json using latest resolvable versions.");
    expect(writes.join("")).toContain("Use lockfile scan for exact installed versions.");
    expect(writes.join("")).toContain("Anvil blocked bad-pkg@latest");
    expect(writes.join("")).toContain("Anvil warned warn-pkg@latest");
  });

  it("prints suggested package evidence from policy decisions", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          packageName: "@tenstack/react-query",
          version: "1.0.0",
          decision: {
            action: "block",
            score: 95,
            reasons: [
              {
                code: "SIMILAR_TO_POPULAR_PACKAGE",
                message: "Package name is similar to @tanstack/react-query.",
                severity: "critical",
                evidence: { suggestedPackage: "@tanstack/react-query" }
              }
            ],
            explanation: "@tenstack/react-query@1.0.0 is blocked by deterministic policy."
          }
        })
      ),
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["explain", "@tenstack/react-query@1.0.0"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Suggested package:");
    expect(writes.join("")).toContain("@tanstack/react-query");
  });

  it("shows the active popular package index through the admin API", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/popular-package-index");
        return jsonResponse({
          source: "object:popular-index/npm/latest.json",
          generatedAt: "2026-05-20T00:00:00.000Z",
          popularPackages: [{ name: "lodash", weeklyDownloads: 60_000_000 }],
          knownConfusions: { loadash: "lodash" }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["popular-index", "show"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Popular package index: object:popular-index/npm/latest.json");
    expect(writes.join("")).toContain("Packages: 1");
    expect(writes.join("")).toContain("Known confusions: 1");
    expect(writes.join("")).toContain("lodash downloads=60000000");
  });

  it("uploads a validated popular package index through the admin API", async () => {
    const writes: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://admin.test/api/popular-package-index");
      expect(init).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" })
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        generatedAt: "2026-05-20T00:00:00.000Z",
        source: "popular-index.json",
        popularPackages: [{ name: "real-package", weeklyDownloads: 100000 }],
        knownConfusions: { "rea1-package": "real-package" },
        uploadedBy: "security"
      });
      return jsonResponse({
        activeKey: "popular-index/npm/latest.json",
        datedKey: "popular-index/npm/2026-05-20.json",
        index: {
          source: "object:popular-index/npm/latest.json",
          generatedAt: "2026-05-20T00:00:00.000Z",
          popularPackages: [{ name: "real-package", weeklyDownloads: 100000 }],
          knownConfusions: { "rea1-package": "real-package" }
        }
      });
    });
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test", ADMIN_TOKEN: "secret" },
      readFile: vi.fn(async () =>
        JSON.stringify({
          popularPackages: [{ name: "real-package", weeklyDownloads: 100000 }],
          knownConfusions: { "rea1-package": "real-package" }
        })
      ),
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["popular-index", "upload", "popular-index.json", "--generated-at", "2026-05-20T00:00:00.000Z", "--uploaded-by", "security"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Uploaded popular package index from popular-index.json.");
    expect(writes.join("")).toContain("Active key: popular-index/npm/latest.json");
    expect(writes.join("")).toContain("real-package downloads=100000");
  });

  it("posts approval overrides with admin token", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" }
    });

    const exitCode = await run(
      ["approve", "pkg@1.0.0", "--reason", "intentional", "--approved-by", "reviewer", "--expires-at", "2026-06-20T00:00:00Z"],
      dependencies
    );

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/override",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({
          packageName: "pkg",
          version: "1.0.0",
          reason: "intentional",
          action: "allow",
          approvedBy: "reviewer",
          expiresAt: "2026-06-20T00:00:00Z"
        })
      })
    );
  });

  it("prefers ANVIL_ADMIN_TOKEN for admin-gated CLI requests", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "legacy-secret", ANVIL_ADMIN_TOKEN: "anvil-secret" }
    });

    const exitCode = await run(["approve", "pkg@1.0.0", "--reason", "intentional"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/override",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer anvil-secret" }),
        body: JSON.stringify({ packageName: "pkg", version: "1.0.0", reason: "intentional", action: "allow", approvedBy: "anvil-cli" })
      })
    );
  });

  it("revokes approval overrides with admin token", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () => jsonResponse({ ok: true })),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" },
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["revoke", "@scope/pkg@1.0.0", "--revoked-by", "reviewer"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/override/revoke",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({ packageName: "@scope/pkg", version: "1.0.0", revokedBy: "reviewer" })
      })
    );
    expect(writes.join("")).toContain("Revoked override for @scope/pkg@1.0.0.");
  });

  it("queues forced LLM reviews with admin token", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          ok: true,
          queued: 1,
          jobs: [{ packageName: "pkg", version: "1.0.0" }]
        })
      ),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" },
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["llm-review", "pkg@1.0.0", "--requested-by", "reviewer", "--priority", "high"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/llm-review",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({ packageName: "pkg", version: "1.0.0", requestedBy: "reviewer", priority: "high" })
      })
    );
    expect(writes.join("")).toContain("Queued LLM review for pkg@1.0.0.");
    expect(writes.join("")).toContain("Jobs queued: 1");
  });

  it("prints analysis queue status with admin token", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      fetch: vi.fn(async () =>
        jsonResponse({
          queue: {
            driver: "bullmq",
            waiting: 3,
            active: 1,
            delayed: 2,
            failed: 0,
            completed: 8,
            totalPending: 6,
            checkedAt: "2026-05-20T00:00:00.000Z"
          }
        })
      ),
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ADMIN_TOKEN: "secret" },
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["queue", "status"], dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.fetch).toHaveBeenCalledWith(
      "http://anvil.test/-/anvil/queue",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer secret" })
      })
    );
    expect(writes.join("")).toContain("Analysis queue: bullmq");
    expect(writes.join("")).toContain("- total pending: 6");
  });

  it("lists overrides through the admin API", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/overrides?limit=5&packageName=pkg&version=1.0.0");
        return jsonResponse({
          overrides: [
            {
              override: {
                packageName: "pkg",
                version: "1.0.0",
                action: "allow",
                reason: "intentional",
                approvedBy: "reviewer",
                expiresAt: "2026-06-20T00:00:00.000Z"
              },
              createdAt: "2026-05-21T10:00:00.000Z"
            }
          ]
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["overrides", "--target", "pkg@1.0.0", "--limit", "5"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Overrides: 1");
    expect(writes.join("")).toContain("pkg@1.0.0 allow active by=reviewer");
    expect(writes.join("")).toContain("intentional");
  });

  it("lists audit events through the admin API", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/audit-events?limit=10&targetId=pkg%401.0.0");
        return jsonResponse({
          auditEvents: [
            {
              actor: "worker",
              eventType: "analysis.completed",
              targetType: "package",
              targetId: "pkg@1.0.0",
              metadata: { action: "warn", score: 20 },
              createdAt: "2026-05-21T10:00:00.000Z"
            }
          ]
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["audit-events", "--target", "pkg@1.0.0", "--limit", "10"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Audit events: 1");
    expect(writes.join("")).toContain("analysis.completed package:pkg@1.0.0 actor=worker");
    expect(writes.join("")).toContain('"action":"warn"');
  });

  it("prints persisted analysis report detail through the admin API", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/reports/pkg/1.0.0?integrity=sha512-new&analyser=static-v2");
        return jsonResponse({
          report: {
            packageName: "pkg",
            version: "1.0.0",
            tarballIntegrity: "sha512-new",
            analyserVersion: "static-v2",
            createdAt: "2026-05-21T10:00:00.000Z",
            report: {
              packageName: "pkg",
              version: "1.0.0",
              analyserVersion: "static-v2",
              policyVersion: "policy-v1",
              tarballIntegrity: "sha512-new",
              score: 80,
              signals: [{ code: "NEW_DEPENDENCY_IN_PATCH_VERSION", severity: "high", message: "Patch version added runtime dependencies." }],
              dependencyDiff: { runtime: { added: { "left-pad": "^1.0.0" } } },
              fileFindings: [{ path: "install.js", code: "USES_CHILD_PROCESS", reason: "Uses child process.", severity: "high", evidence: { pattern: "child_process" } }],
              createdAt: "2026-05-21T10:00:00.000Z"
            }
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["reports", "pkg@1.0.0", "--integrity", "sha512-new", "--analyser", "static-v2"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Analysis report pkg@1.0.0");
    expect(writes.join("")).toContain("Analyser: static-v2");
    expect(writes.join("")).toContain("NEW_DEPENDENCY_IN_PATCH_VERSION [high]");
    expect(writes.join("")).toContain("runtime added left-pad -> ^1.0.0");
    expect(writes.join("")).toContain("install.js USES_CHILD_PROCESS [high]");
  });

  it("prints persisted analysis report comparisons through the admin API", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/packages/pkg/1.0.0/reports/compare?leftIntegrity=sha512-old&rightIntegrity=sha512-new");
        return jsonResponse({
          packageName: "pkg",
          version: "1.0.0",
          left: {
            packageName: "pkg",
            version: "1.0.0",
            tarballIntegrity: "sha512-old",
            analyserVersion: "static-v1",
            report: {
              packageName: "pkg",
              version: "1.0.0",
              analyserVersion: "static-v1",
              policyVersion: "policy-v1",
              score: 10,
              signals: [],
              fileFindings: [],
              createdAt: "2026-05-21T09:00:00.000Z"
            }
          },
          right: {
            packageName: "pkg",
            version: "1.0.0",
            tarballIntegrity: "sha512-new",
            analyserVersion: "static-v2",
            report: {
              packageName: "pkg",
              version: "1.0.0",
              analyserVersion: "static-v2",
              policyVersion: "policy-v1",
              score: 60,
              signals: [{ code: "INSTALL_SCRIPT_CHANGED", severity: "medium", message: "Install script changed." }],
              fileFindings: [{ path: "scripts/install.js", code: "NETWORK_ACCESS_IN_INSTALL_PATH", reason: "Network access in install path.", severity: "high" }],
              createdAt: "2026-05-21T10:00:00.000Z"
            }
          },
          comparison: {
            scoreDelta: 50,
            signals: {
              added: [{ code: "INSTALL_SCRIPT_CHANGED", severity: "medium", message: "Install script changed." }],
              removed: [],
              unchanged: []
            },
            fileFindings: {
              added: [{ path: "scripts/install.js", code: "NETWORK_ACCESS_IN_INSTALL_PATH", reason: "Network access in install path.", severity: "high" }],
              removed: [],
              unchanged: []
            }
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["reports", "compare", "pkg@1.0.0", "--left-integrity", "sha512-old", "--right-integrity", "sha512-new"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Analysis report comparison pkg@1.0.0");
    expect(writes.join("")).toContain("Score delta: 50");
    expect(writes.join("")).toContain("INSTALL_SCRIPT_CHANGED [medium]");
    expect(writes.join("")).toContain("scripts/install.js NETWORK_ACCESS_IN_INSTALL_PATH [high]");
  });

  it("smoke tests gateway metadata and tarball proxying", async () => {
    const writes: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/-/ready")) return jsonResponse({ ok: true, checks: [{ component: "persistence", ok: true }] });
      if (url === "http://anvil.test/is-number") {
        return jsonResponse({
          name: "is-number",
          "dist-tags": { latest: "7.0.0" },
          versions: {
            "7.0.0": {
              dist: {
                tarball: "http://anvil.test/is-number/-/is-number-7.0.0.tgz"
              }
            }
          }
        });
      }
      if (url === "http://anvil.test/is-number/-/is-number-7.0.0.tgz") return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected URL ${url}`);
    });
    const dependencies = fakeDependencies({
      fetch: fetch as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    await expect(run(["smoke"], dependencies)).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith("http://anvil.test/-/health", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/-/ready", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/is-number", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/is-number/-/is-number-7.0.0.tgz");
    expect(writes.join("")).toContain("Anvil smoke check passed.");
  });

  it("smoke tests scoped package paths with split URL encoding", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
      if (url.endsWith("/-/ready")) return jsonResponse({ ok: true, checks: [{ component: "persistence", ok: true }] });
      if (url === "http://anvil.test/%40scope/pkg") {
        return jsonResponse({
          name: "@scope/pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: {
                tarball: "http://anvil.test/@scope/pkg/-/pkg-1.0.0.tgz"
              }
            }
          }
        });
      }
      if (url === "http://anvil.test/@scope/pkg/-/pkg-1.0.0.tgz") return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected URL ${url}`);
    });
    const dependencies = fakeDependencies({ fetch: fetch as unknown as typeof globalThis.fetch });

    await expect(run(["smoke", "@scope/pkg"], dependencies)).resolves.toBe(0);

    expect(fetch).toHaveBeenCalledWith("http://anvil.test/%40scope/pkg", undefined);
    expect(fetch).toHaveBeenCalledWith("http://anvil.test/@scope/pkg/-/pkg-1.0.0.tgz");
  });

  it("fails smoke tests when tarball URLs are not rewritten through the gateway", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/-/ready")) return jsonResponse({ ok: true });
        return jsonResponse({
          name: "pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: {
                tarball: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"
              }
            }
          }
        });
      }) as unknown as typeof globalThis.fetch
    });

    await expect(run(["smoke", "pkg"], dependencies)).resolves.toBe(1);
    expect(dependencies.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Tarball URL was not rewritten through Anvil"));
  });

  it("fails smoke tests when same-origin tarball URLs are not package tarball routes", async () => {
    const dependencies = fakeDependencies({
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith("/-/health")) return jsonResponse({ ok: true });
        if (url.endsWith("/-/ready")) return jsonResponse({ ok: true });
        return jsonResponse({
          name: "pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: {
                tarball: "http://anvil.test/not-the-package/-/pkg-1.0.0.tgz"
              }
            }
          }
        });
      }) as unknown as typeof globalThis.fetch
    });

    await expect(run(["smoke", "pkg"], dependencies)).resolves.toBe(1);
    expect(dependencies.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Tarball URL was not rewritten through Anvil"));
  });

  it("lists Node Base reports through the admin API and fails when high findings exist", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_REGISTRY_URL: "http://anvil.test", ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/node-base/reports?limit=5&reportType=network&risk=high");
        return jsonResponse({
          reports: [
            {
              id: "report-1",
              source: "devcontainer",
              projectName: "demo",
              reportType: "network",
              summary: { outboundConnections: 2, high: 1, medium: 0 },
              report: { summary: { outboundConnections: 2, high: 1, medium: 0 } },
              createdAt: "2026-05-20T12:00:00.000Z"
            }
          ]
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["node-base", "reports", "--type", "network", "--risk", "high", "--limit", "5"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("Node Base reports: 1 (network) risk=high");
    expect(writes.join("")).toContain("report-1 network demo");
    expect(writes.join("")).toContain("high=1 medium=0");
    expect(writes.join("")).toContain("2 connections");
  });

  it("does not double-count Node Base summary aliases", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/node-base/reports?limit=20");
        return jsonResponse({
          reports: [
            {
              id: "report-1",
              source: "devcontainer",
              reportType: "ioc",
              summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 },
              report: { summary: { high: 1, highConfidenceFindings: 1, medium: 2, mediumConfidenceFindings: 2 } },
              createdAt: "2026-05-20T12:00:00.000Z"
            }
          ]
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["node-base", "reports"], dependencies);

    expect(exitCode).toBe(1);
    expect(writes.join("")).toContain("high=1 medium=2");
    expect(writes.join("")).not.toContain("high=2 medium=4");
  });

  it("prints a Node Base report detail with findings and connections", async () => {
    const writes: string[] = [];
    const dependencies = fakeDependencies({
      env: { ANVIL_ADMIN_URL: "http://admin.test" },
      fetch: vi.fn(async (url: string) => {
        expect(url).toBe("http://admin.test/api/node-base/reports/report-1");
        return jsonResponse({
          report: {
            id: "report-1",
            source: "devcontainer",
            projectName: "demo",
            reportType: "network",
            summary: { outboundConnections: 1, high: 0, medium: 1 },
            report: {
              summary: { outboundConnections: 1, high: 0, medium: 1 },
              mediumConfidenceFindings: [{ code: "NON_STANDARD_PORT", source: "strace", line: 8, evidence: "connect(... htons(8080) ...)" }],
              networkSummary: {
                connections: [{ family: "AF_INET", address: "198.51.100.10", port: 8080, line: 8 }]
              },
              policy: {
                network: {
                  allowedPorts: [80, 443],
                  allowedHosts: ["registry.npmjs.org"],
                  blockedHosts: ["raw.githubusercontent.com"],
                  directIpSeverity: "medium",
                  nonStandardPortSeverity: "high"
                }
              }
            },
            createdAt: "2026-05-20T12:00:00.000Z"
          }
        });
      }) as unknown as typeof globalThis.fetch,
      stdout: {
        write: (value: string) => {
          writes.push(value);
          return true;
        }
      }
    });

    const exitCode = await run(["node-base", "report", "report-1"], dependencies);

    expect(exitCode).toBe(0);
    expect(writes.join("")).toContain("Node Base network report report-1");
    expect(writes.join("")).toContain("Risk: high=0 medium=1");
    expect(writes.join("")).toContain("NON_STANDARD_PORT");
    expect(writes.join("")).toContain("198.51.100.10:8080");
    expect(writes.join("").match(/198\.51\.100\.10:8080/g)).toHaveLength(1);
    expect(writes.join("")).toContain("Network policy:");
    expect(writes.join("")).toContain("allowed ports: 80, 443");
    expect(writes.join("")).toContain("blocked hosts: raw.githubusercontent.com");
    expect(writes.join("")).toContain("non-standard port severity: high");
  });
});

function fakeDependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    fetch: vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch,
    readFile: vi.fn(async () => ""),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    env: { ANVIL_REGISTRY_URL: "http://anvil.test" },
    ...overrides
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
