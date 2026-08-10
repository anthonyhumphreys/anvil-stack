import { describe, expect, it, vi } from "vitest";

import {
  redactCloudflareSecrets,
  runCloudflareWranglerDeploy,
  sanitizeTemporaryCloudflareEnvironment,
  type CloudflareWorkerArtifacts,
  type WranglerCommandRunner,
} from "../src/index.js";

const artifacts: CloudflareWorkerArtifacts = {
  directory: "/tmp/anvil-cloudflare",
  worker: "/tmp/anvil-cloudflare/worker.mjs",
  config: "/tmp/anvil-cloudflare/wrangler.jsonc",
  workerName: "smoke-preview-12345678",
  workerSha256: "abc123",
};

describe("Cloudflare Wrangler execution", () => {
  it("scrubs every inherited Cloudflare credential in temporary mode", () => {
    expect(
      sanitizeTemporaryCloudflareEnvironment({
        PATH: "/bin",
        CF_API_TOKEN: "secret-a",
        CLOUDFLARE_API_TOKEN: "secret-b",
        WRANGLER_HOME: "/shared",
      }),
    ).toEqual({ PATH: "/bin" });
  });

  it("enforces the temporary-account Wrangler floor", async () => {
    const run = vi.fn<WranglerCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: "4.101.0",
      stderr: "",
    });

    await expect(
      runCloudflareWranglerDeploy({
        artifacts,
        authentication: "temporary",
        run,
      }),
    ).rejects.toThrow("require Wrangler 4.102.0 or later");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns the claim URL separately and redacts captured output", async () => {
    const claimUrl =
      "https://dash.cloudflare.com/claim-preview?claimToken=super-secret";
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `Claim URL: ${claimUrl}\nhttps://smoke.example.workers.dev/`,
        stderr: "",
      });
    let capturedClaimUrl: string | undefined;

    const result = await runCloudflareWranglerDeploy({
      artifacts,
      authentication: "temporary",
      env: { PATH: "/bin", CLOUDFLARE_API_TOKEN: "must-not-pass" },
      run,
      onClaimUrl(value) {
        capturedClaimUrl = value;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      claimUrlCaptured: true,
      previewUrl: "https://smoke.example.workers.dev",
    });
    expect(capturedClaimUrl).toBe(claimUrl);
    expect(JSON.stringify(result)).not.toContain("claimToken");
    expect(result.stdout).toContain("[REDACTED_CLOUDFLARE_CLAIM_URL]");
    expect(result.stdout).not.toContain("super-secret");
    expect(run.mock.calls[1]?.[0].env).toEqual({
      PATH: "/bin",
      FORCE_COLOR: "0",
      WRANGLER_HIDE_BANNER: "true",
      WRANGLER_LOG_SANITIZE: "true",
      WRANGLER_SEND_ERROR_REPORTS: "false",
      WRANGLER_SEND_METRICS: "false",
    });
  });

  it("keeps dry-run compilation non-mutating in temporary mode", async () => {
    const run = vi
      .fn<WranglerCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "wrangler 4.120.0",
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "dry run", stderr: "" });

    await runCloudflareWranglerDeploy({
      artifacts,
      authentication: "temporary",
      dryRun: true,
      run,
    });

    expect(run.mock.calls[1]?.[0].args).toContain("--dry-run");
    expect(run.mock.calls[1]?.[0].args).not.toContain("--temporary");
  });

  it("redacts claim URLs wherever Wrangler writes them", () => {
    expect(
      redactCloudflareSecrets(
        "open https://dash.cloudflare.com/claim-preview?claimToken=secret-now",
      ),
    ).toBe("open [REDACTED_CLOUDFLARE_CLAIM_URL]");
  });
});
