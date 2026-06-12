import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8787);

const review = {
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

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/-/health") {
    sendJson(response, 200, { ok: true, service: "anvil-llm-review-mock" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/review") {
    sendJson(response, 404, { error: "ANVIL_LLM_REVIEW_MOCK_NOT_FOUND" });
    return;
  }

  try {
    await readBody(request);
    sendJson(response, 200, { review });
  } catch (error) {
    sendJson(response, 400, { error: "ANVIL_LLM_REVIEW_MOCK_BAD_REQUEST", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[anvil] LLM review mock listening on ${port}`);
});

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : undefined;
}
