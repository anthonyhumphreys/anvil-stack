import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisabledLlmRiskReviewProvider, HttpLlmRiskReviewProvider, createLlmRiskReviewProvider, llmRiskReviewSchema } from "./index.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))));
});

describe("llmRiskReviewSchema", () => {
  it("accepts spec-shaped structured risk reviews", () => {
    const review = llmRiskReviewSchema.parse({
      riskLevel: "high",
      confidence: "medium",
      summary: "Install script reaches out to a raw content host and reads token-looking environment variables.",
      suspectedRiskTypes: ["install_script_abuse", "credential_exfiltration", "unexpected_network_access"],
      evidence: [
        {
          signal: "NETWORK_ACCESS_IN_INSTALL_PATH",
          explanation: "The install path calls out to a remote host during dependency installation.",
          source: "code_snippet"
        },
        {
          signal: "USES_PROCESS_ENV",
          explanation: "The script reads process.env while running as an install hook.",
          source: "package_json"
        }
      ],
      recommendedAction: "quarantine"
    });

    expect(review.suspectedRiskTypes).toContain("credential_exfiltration");
    expect(review.evidence[0]?.source).toBe("code_snippet");
  });

  it("rejects non-spec risk types and evidence sources", () => {
    const result = llmRiskReviewSchema.safeParse({
      riskLevel: "high",
      confidence: "high",
      summary: "Looks spicy, allegedly.",
      suspectedRiskTypes: ["vibe_based_malware"],
      evidence: [{ signal: "UNKNOWN", explanation: "Because the model said so.", source: "horoscope" }],
      recommendedAction: "block"
    });

    expect(result.success).toBe(false);
  });

  it("keeps LLM review disabled by default", async () => {
    await expect(new DisabledLlmRiskReviewProvider().review()).resolves.toBeUndefined();
  });

  it("posts review input to an HTTP provider and validates the returned review", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new HttpLlmRiskReviewProvider({
      endpoint: "https://llm.example.test/review",
      apiKey: "secret",
      model: "risk-reviewer",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            review: {
              riskLevel: "high",
              confidence: "medium",
              summary: "Install path performs unexpected network access.",
              suspectedRiskTypes: ["unexpected_network_access"],
              evidence: [{ signal: "NETWORK_ACCESS_IN_INSTALL_PATH", explanation: "Remote fetch during install.", source: "code_snippet" }],
              recommendedAction: "quarantine"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as unknown as typeof fetch
    });

    const review = await provider.review({
      packageName: "pkg",
      version: "1.0.0",
      similarPopularPackages: [],
      deterministicSignals: ["NETWORK_ACCESS_IN_INSTALL_PATH"]
    });

    expect(review).toMatchObject({ riskLevel: "high", recommendedAction: "quarantine" });
    expect(calls[0]?.url).toBe("https://llm.example.test/review");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: "risk-reviewer",
      input: { packageName: "pkg", deterministicSignals: ["NETWORK_ACCESS_IN_INSTALL_PATH"] }
    });
  });

  it("retries transient HTTP provider failures", async () => {
    const fetchProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider warming up"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ review: mockReview() }), { status: 200 }));
    const provider = new HttpLlmRiskReviewProvider({
      endpoint: "https://llm.example.test/review",
      fetch: fetchProvider as unknown as typeof fetch,
      retryDelayMs: 1
    });

    await expect(
      provider.review({
        packageName: "pkg",
        version: "1.0.0",
        similarPopularPackages: [],
        deterministicSignals: []
      })
    ).resolves.toMatchObject({ riskLevel: "high", recommendedAction: "quarantine" });
    expect(fetchProvider).toHaveBeenCalledTimes(2);
  });

  it("accepts the local smoke-test mock provider contract over HTTP", async () => {
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/review") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "ANVIL_LLM_REVIEW_MOCK_NOT_FOUND" }));
        return;
      }

      let body = "";
      for await (const chunk of request) body += chunk;
      expect(JSON.parse(body)).toMatchObject({ model: "smoke-test", input: { packageName: "is-number", version: "7.0.0" } });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ review: mockReview() }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const provider = new HttpLlmRiskReviewProvider({
      endpoint: `http://127.0.0.1:${address.port}/review`,
      model: "smoke-test",
      retryDelayMs: 1
    });

    await expect(
      provider.review({
        packageName: "is-number",
        version: "7.0.0",
        similarPopularPackages: [],
        deterministicSignals: ["PROVENANCE_MISSING"]
      })
    ).resolves.toMatchObject({ riskLevel: "high", recommendedAction: "quarantine" });
  });

  it("ignores malformed HTTP provider output", async () => {
    const provider = new HttpLlmRiskReviewProvider({
      endpoint: "https://llm.example.test/review",
      fetch: (async () => new Response(JSON.stringify({ review: { riskLevel: "catastrophic" } }), { status: 200 })) as unknown as typeof fetch
    });

    await expect(
      provider.review({
        packageName: "pkg",
        version: "1.0.0",
        similarPopularPackages: [],
        deterministicSignals: []
      })
    ).resolves.toBeUndefined();
  });

  it("ignores malformed HTTP provider JSON", async () => {
    const provider = new HttpLlmRiskReviewProvider({
      endpoint: "https://llm.example.test/review",
      fetch: (async () => new Response("{ nope", { status: 200 })) as unknown as typeof fetch
    });

    await expect(
      provider.review({
        packageName: "pkg",
        version: "1.0.0",
        similarPopularPackages: [],
        deterministicSignals: []
      })
    ).resolves.toBeUndefined();
  });

  it("creates a disabled provider without an endpoint", async () => {
    const provider = createLlmRiskReviewProvider({ enabled: true });

    await expect(
      provider.review({
        packageName: "pkg",
        version: "1.0.0",
        similarPopularPackages: [],
        deterministicSignals: []
      })
    ).resolves.toBeUndefined();
  });
});

function mockReview() {
  return {
    riskLevel: "high",
    confidence: "medium",
    summary: "Mock LLM review requested by the local smoke test.",
    suspectedRiskTypes: ["unknown"],
    evidence: [
      {
        signal: "MANUAL_REVIEW",
        explanation: "The local smoke test forced model review for a known package target.",
        source: "metadata"
      }
    ],
    recommendedAction: "quarantine"
  };
}
