---
title: LLM integration
navTitle: LLM integration
description: Configure optional LLM risk review, understand the provider contract, and keep model output out of the enforcement seat.
product: Anvil Registry
section: Operations
order: 10.25
---

# LLM integration

Anvil can call an external LLM reviewer to summarize package risk evidence. This is optional. The deterministic policy engine still owns enforcement.

Use LLM review for reviewer context:

- Explain why a lifecycle-script change looks suspicious.
- Summarize risky file, dependency, metadata, and download-stat signals.
- Suggest which evidence a human should inspect first.
- Add quarantine-level context for messy packages.

Do not use LLM review as a permission engine. A model recommendation cannot make a package safe, cannot bypass policy, and cannot approve an override. That job still belongs to deterministic rules and audited humans, because apparently we would like the security product to contain security.

## What runs where

The gateway and Admin service can enqueue LLM review jobs. The worker calls the provider and persists validated review output.

| Component | Role |
| --- | --- |
| Gateway | Exposes `POST /-/anvil/llm-review` for admin-token-gated manual review requests. |
| Admin | Lets reviewers queue LLM review from package detail pages and reads persisted review records. |
| CLI | Wraps the route with `anvil registry llm-review package@version`. |
| Worker | Calls the configured HTTP provider or isolated Codex CLI provider and stores schema-valid review output. |
| Policy engine | Treats high or critical LLM risk as quarantine context, not as an allow authority. |

Provider credentials are needed only by the worker. Do not expose `LLM_REVIEW_API_KEY` to the gateway, Admin browser code, public docs routes, or `NEXT_PUBLIC_*` variables.

## Enable review locally

The default Compose stack keeps LLM review disabled. To run the local mock provider:

```bash
pnpm smoke:llm-review
```

That smoke test starts the Compose stack with the `llm-review` profile, queues a forced review, waits for the worker, and verifies that Admin can read the persisted review.

For a manual local run:

```bash
LLM_REVIEW_ENABLED=true \
LLM_REVIEW_PROVIDER=mock \
LLM_REVIEW_MODEL=risk-reviewer \
LLM_REVIEW_ENDPOINT=http://llm-review-mock:8787/review \
docker compose -f infra/docker/docker-compose.yml --profile llm-review up -d --build llm-review-mock gateway worker admin
```

Then queue a review:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry llm-review is-number@7.0.0 --requested-by security-review --priority high
```

Inspect the result:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil registry explain is-number@7.0.0
```

## Environment variables

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `LLM_REVIEW_ENABLED` | `false` | Gateway, Admin, worker | Enables queueing and worker review behavior. |
| `LLM_REVIEW_PROVIDER` | unset | Gateway, Admin, worker | Provider label stored with review records. |
| `LLM_REVIEW_MODEL` | unset | Gateway, Admin, worker | Model label sent to the provider and stored with review records. |
| `LLM_REVIEW_ENDPOINT` | unset | Gateway, Admin, worker | HTTP endpoint for structured review calls. Required when enabled. |
| `LLM_REVIEW_API_KEY` | unset | Worker only | Optional bearer token for the provider endpoint. |
| `LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES` | `false` | Worker | Automatically run LLM review for unknown package analysis. |
| `LLM_REVIEW_RUN_ON_QUARANTINE` | `false` | Worker | Automatically run LLM review for quarantined analysis results. |
| `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES` | `false` | Worker | Allows private package metadata to be sent to the provider. |
| `CODEX_AUTH_FILE` | unset | Docker host | Absolute host `auth.json` path used by `docker-compose.codex.yml`. |
| `CODEX_CLI_COMMAND` | `codex` | Worker | Codex executable used when `LLM_REVIEW_PROVIDER=codex-cli`. |
| `CODEX_CLI_TIMEOUT_MS` | `120000` | Worker | Maximum duration of one Codex review process. |

Private package metadata is excluded by default. Only enable `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES=true` when the provider, workspace policy, and package owners all allow that data flow. "The endpoint seemed friendly" is not a data-processing agreement.

## Codex CLI on a NAS

The released operator bundle includes `docker-compose.codex.yml` for a Codex-backed worker. This is opt-in and separate from the default HTTP provider path.

On the NAS, sign in with Codex CLI and restrict its credential file:

```bash
chmod 700 "$HOME/.codex"
chmod 600 "$HOME/.codex/auth.json"
```

Set the absolute host path in the release `.env`:

```dotenv
CODEX_AUTH_FILE=/home/your-user/.codex/auth.json
LLM_REVIEW_RUN_ON_QUARANTINE=true
```

Then apply both Compose files:

```bash
docker compose -f docker-compose.yml -f docker-compose.codex.yml config
docker compose -f docker-compose.yml -f docker-compose.codex.yml pull
docker compose -f docker-compose.yml -f docker-compose.codex.yml up -d
```

Only the worker receives `/var/lib/anvil-codex/auth.json`, mounted read-only. The worker invokes Codex with shell and code-execution tools disabled, ignores user configuration and repository rules, uses an ephemeral working directory, constrains the final output with JSON Schema, and removes Registry database, object-store, and admin credentials from the child process environment. Gateway and Admin can enqueue reviews but never receive the Codex credential.

Package evidence is untrusted model input. These controls reduce prompt-injection reach, but the credential still grants use of the signed-in Codex account and the evidence is sent to that account. Mount only `auth.json`, keep the NAS trusted, leave private-package review disabled unless explicitly approved, and retain deterministic policy as the enforcement authority.

## Provider contract

Anvil posts JSON to `LLM_REVIEW_ENDPOINT`:

```json
{
  "model": "risk-reviewer",
  "input": {
    "packageName": "example",
    "version": "1.2.3"
  },
  "instructions": "Return only JSON matching the Anvil LlmRiskReview schema. Do not recommend allow solely because evidence is inconclusive."
}
```

The exact `input` object includes package evidence collected by the worker, such as metadata, static findings, dependency changes, and available download signals.

The provider response must contain either the review object directly or a `review` object:

```json
{
  "review": {
    "riskLevel": "high",
    "confidence": "medium",
    "summary": "Install script behavior needs manual review.",
    "suspectedRiskTypes": ["install_script_abuse"],
    "evidence": [
      {
        "signal": "NEW_INSTALL_SCRIPT",
        "explanation": "A patch release introduced a postinstall script.",
        "source": "package_json"
      }
    ],
    "recommendedAction": "quarantine"
  }
}
```

Accepted risk levels are `low`, `medium`, `high`, and `critical`. Accepted recommendations are `allow`, `warn`, `quarantine`, and `block`.

Anvil validates model-shaped output before storing it. Invalid JSON, malformed schema output, or non-2xx provider responses are treated as unavailable review context. The worker records that the review was unavailable; it does not turn model failure into a secret allow.

## Manual review route

The gateway exposes:

```http
POST /-/anvil/llm-review
Authorization: Bearer <admin-token>
Content-Type: application/json
```

Single target:

```json
{
  "name": "example",
  "version": "1.2.3",
  "requestedBy": "security-review",
  "priority": "high"
}
```

Multiple targets:

```json
{
  "targets": [
    { "name": "example", "version": "1.2.3" },
    { "name": "@scope/pkg", "version": "4.5.6" }
  ],
  "requestedBy": "security-review",
  "priority": "high"
}
```

The route validates, trims, deduplicates, and enqueues review jobs with `runLlmReview: true`. It records `llm_review.enqueued` audit events. It does not approve the package, bypass private-package controls, or skip static analysis.

CLI equivalent:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 \
ANVIL_ADMIN_TOKEN=local-dev-token \
  anvil registry llm-review example@1.2.3 --requested-by security-review --priority high
```

## Hosted deployment

SST passes LLM review environment values into gateway, worker, and Admin. The `LlmReviewApiKey` secret is linked only to the worker.

Before deploying with review enabled, run:

```bash
pnpm --dir infra/sst test
```

The SST preflight catches partially enabled HTTP review, such as setting `LLM_REVIEW_ENABLED=true` without a provider endpoint. The Codex CLI provider is an operator-managed Docker path, not an SST deployment path.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `ANVIL_LLM_REVIEW_DISABLED` | Confirm `LLM_REVIEW_ENABLED=true` is set for gateway, Admin, and worker. |
| `ANVIL_LLM_REVIEW_INVALID` | Check the request body uses `name` and `version`, or a `targets` array with those fields. |
| Jobs enqueue but no review appears | For HTTP, check `LLM_REVIEW_ENDPOINT` and provider output. For Codex, check the worker mount, `CODEX_AUTH_FILE` permissions, and worker logs. |
| Private package review is skipped | This is the default. Set `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES=true` only after approving that data flow. |
| Provider returns text instead of JSON | Make the provider return the schema object directly or inside `review`. |

When in doubt, run `pnpm smoke:llm-review` against the local mock first. It removes provider drama from the equation, which is rude to drama but helpful to debugging.
