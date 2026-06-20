# Anvil Registry

Anvil Registry is a TypeScript npm registry gateway and companion Node devcontainer base image for safer dependency installs.

This repository is the first public version of Anvil, and it should be treated as a rough **alpha** release. It is suitable for local trials, security review, early CI experiments, and contribution work. It is not yet a polished production security platform, and the docs call out that reality because pretending alpha software is finished is how projects become haunted.

The gateway proxies npm metadata and tarballs, rewrites tarball URLs through itself, caches artefacts, runs deterministic package policy, queues static analysis outside the install path, and exposes review/override surfaces through the admin app and CLI. Anvil Node Base is the local harness: it defaults npm toward safer installs, reports lifecycle scripts, and provides explicit observed mode for packages that need install scripts.

The source-of-truth specs and public docs live in:

- `docs/anvil-registry-spec.md`
- `docs/anvil-node-base-spec.md`
- `docs/README.md`
- `../anvil-website/content/docs/registry`
- `../anvil-website/content/docs/node-base`

## Workspace

- `apps/gateway`: Fastify npm registry proxy and operator routes.
- `apps/worker`: queue consumer for static package analysis and optional LLM risk review.
- `apps/admin`: Next.js Admin UI and route-handler JSON API for package reviews, policy, overrides, reports, popular package index operations, and Node Base reports.
- `apps/cli`: `anvil-registry` command-line client for explain, scan, warm, smoke, queue, LLM review, reports, overrides, policy tests, and Node Base report views.
- `packages/*`: shared config, logging, npm registry client, policy engine, package analysis, name-squatting, LLM review, persistence, object store, queue, provenance, and shared types.
- `infra/docker`: local Docker Compose stack.
- `infra/sst`: AWS/SST infrastructure.
- `devcontainer-base`: hardened Node 22 devcontainer base image and helper scripts.
- `docs`: product specs and repo-level documentation map.

## Documentation

Start here:

- `docs/README.md`: repo documentation map and coverage notes.
- `../anvil-website/content/docs/registry/introduction.md`: public registry docs introduction.
- `../anvil-website/content/docs/registry/alpha-status.md`: current alpha posture and recommended rollout.
- `../anvil-website/content/docs/registry/quickstart.md`: local registry and client setup.
- `../anvil-website/content/docs/registry/architecture.md`: system architecture.
- `../anvil-website/content/docs/registry/api-reference.md`: alpha HTTP/operator surface.
- `../anvil-website/content/docs/node-base/overview.md`: public Node Base docs.
- `devcontainer-base/README.md`: Node Base helper scripts and image validation.
- `apps/cli/README.md`: CLI install and command summary.

When behaviour changes, update the relevant docs in the same pull request. A security gateway with stale docs is just a puzzle box with ports.

## Local Development

Install dependencies with lifecycle scripts disabled unless you explicitly need otherwise:

```bash
pnpm install --ignore-scripts
```

Run the main checks:

```bash
pnpm lint
pnpm typecheck
pnpm typecheck:smokes
pnpm test
pnpm build
```

Run individual services without Docker:

```bash
pnpm dev:gateway
pnpm dev:worker
pnpm --filter @anvilstack/admin dev
```

The defaults use in-memory adapters unless environment variables select Postgres, S3/MinIO, or BullMQ/SQS.

Gateway metadata responses are cached in persistence and refreshed after `NPM_METADATA_CACHE_TTL_SECONDS` seconds. The default is `300`; set it to `0` to force every metadata request back to the upstream registry during debugging.

By default Anvil proxies npmjs via `UPSTREAM_NPM_REGISTRY`. For scoped/private registries, set `UPSTREAM_NPM_REGISTRIES_JSON` to a JSON array such as:

```json
[
  { "name": "npmjs", "baseUrl": "https://registry.npmjs.org" },
  { "name": "internal", "baseUrl": "https://npm.pkg.github.com", "scopes": ["@my-org"], "authTokenSecretName": "GITHUB_NPM_TOKEN" }
]
```

Scoped metadata and tarball fetches use the matching upstream and bearer token while public packages continue through the default registry. For local-only testing, `authToken` may be provided inline; deployed config should prefer `authTokenSecretName`, which resolves the token from the named environment secret.

## Docker Compose

Start the local stack:

```bash
docker compose -f infra/docker/docker-compose.yml up -d --build gateway worker admin
```

This starts Postgres, Redis, MinIO, the migration job, gateway, worker, and the Next.js Admin service through service dependencies. The gateway listens on `http://localhost:4873`; Admin listens on `http://localhost:3000`. The local admin token defaults to `local-dev-token`.

Point npm at the gateway:

```bash
npm config set registry http://localhost:4873
```

Then install as usual. Scoped packages, tarballs, and npm audit requests should stay routed through the gateway. Because scoped package paths apparently needed their own little tax on human happiness.

## CLI

Install the published CLI:

```bash
npm install --global @anvilstack/registry-cli
```

The CLI is a client. It requires a running gateway for package decision commands, and Admin plus `ANVIL_ADMIN_TOKEN` for protected operations.

Common commands:

```bash
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-registry explain is-number@7.0.0
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-registry scan pnpm-lock.yaml --queue-analysis
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-registry scan yarn.lock --queue-analysis
ANVIL_REGISTRY_URL=http://localhost:4873 anvil-registry warm package-lock.json
ANVIL_REGISTRY_URL=http://localhost:4873 ANVIL_ADMIN_TOKEN=local-dev-token anvil-registry queue status
ANVIL_ADMIN_URL=http://localhost:3000 anvil-registry reports is-number@7.0.0
ANVIL_ADMIN_URL=http://localhost:3000 anvil-registry reports compare is-number@7.0.0
ANVIL_ADMIN_URL=http://localhost:3000 anvil-registry node-base reports --limit 20
```

Admin-gated mutations read `ANVIL_ADMIN_TOKEN`, falling back to `ADMIN_TOKEN`.

See `../anvil-website/content/docs/registry/cli.md` for installation, gateway setup, command usage, and publish instructions.

## Policy Configuration

Deterministic policy defaults are conservative and can be tuned from environment variables:

- `POLICY_MINIMUM_PACKAGE_AGE_DAYS`
- `POLICY_LOW_DOWNLOAD_THRESHOLD`
- `POLICY_STRICT_LOW_DOWNLOAD_THRESHOLD`
- `POLICY_BLOCK_SIMILAR_LOW_DOWNLOAD_PACKAGES`
- `POLICY_HIDE_QUARANTINED_METADATA`
- `POLICY_OVERRIDE_DEFAULT_EXPIRY_DAYS`

Additional policy knobs use the same `POLICY_` prefix for install scripts, provenance, override behaviour, analyser comparison depth, and policy versioning. The gateway records the effective policy at `GET /-/anvil/policy`, because guessing production policy from vibes is how incident reviews get spicy.

SST forwards any configured `POLICY_*` values into gateway, worker, and admin so deployed enforcement, worker analysis, and policy inspection stay on the same version of reality.

## LLM Review

LLM risk review is optional and never the enforcement authority. Deterministic policy still makes the final decision; LLM output is schema-validated context that can add quarantine-level risk signals.

Run the local mock-provider smoke:

```bash
pnpm smoke:llm-review
```

Or start Compose with your own provider settings:

```bash
LLM_REVIEW_ENABLED=true \
LLM_REVIEW_PROVIDER=http \
LLM_REVIEW_MODEL=risk-reviewer \
LLM_REVIEW_ENDPOINT=http://llm-review-mock:8787/review \
docker compose -f infra/docker/docker-compose.yml --profile llm-review up -d --build llm-review-mock gateway worker admin
```

Private package metadata is excluded from LLM review unless `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES=true` is explicitly set.

## Smoke Tests

After the local stack is running:

```bash
pnpm smoke:local
pnpm smoke:clients
pnpm smoke:scoped-upstream
pnpm smoke:analysis
pnpm smoke:node-base-report
```

`smoke:clients` installs known unscoped and scoped packages through npm, pnpm, and Yarn. The npm leg leaves audit enabled by default and runs `npm audit` through the gateway; set `ANVIL_CLIENT_SMOKE_NPM_AUDIT=false` when testing in an environment where upstream audit is intentionally unavailable.

`smoke:scoped-upstream` starts a token-gated mock scoped registry and a local gateway, then verifies scoped metadata routing, tarball URL rewriting, upstream bearer auth, and Anvil cache hits without needing real private registry credentials.

Node Base image checks:

```bash
pnpm test:node-base
pnpm smoke:node-base-image
pnpm smoke:node-base-image-observed
pnpm smoke:node-base-image-report
```

The image smokes build Docker images and can take longer than the unit suite.

## Node Base

See `devcontainer-base/README.md` for helper commands and image publishing details. The short version:

- Safe mode runs `npm ci --ignore-scripts` and reports lifecycle scripts.
- Observed mode deliberately enables scripts under tracing and writes IOC/network reports.
- Reports are written to `${ANVIL_REPORT_DIR:-.anvil/reports}`.
- Reports can be submitted back to Anvil Registry for admin visibility.

## Deployment

Docker Compose is the local path. SST is the AWS path and defines the Fastify gateway, worker, Next.js Admin service, migration task, S3, SQS, RDS, secrets, and CloudWatch resources under `infra/sst`.

Set `PUBLIC_BASE_URL` or `ANVIL_GATEWAY_DOMAIN` for the npm-facing gateway URL before deploying so tarball rewrites point at the real HTTPS endpoint. SST fails fast when neither is configured, because quietly publishing tarball URLs to a placeholder domain is how you build a very small outage machine. Set `ANVIL_API_BASE_URL` only when the admin service should call a different gateway URL; otherwise it inherits `PUBLIC_BASE_URL` or the gateway domain.
Set `ANVIL_GATEWAY_DOMAIN` or `ANVIL_ADMIN_DOMAIN` to attach custom SST load-balancer domains. Route 53 hosted domains use SST's default DNS/certificate handling; for externally managed DNS, also set `ANVIL_GATEWAY_CERT_ARN` or `ANVIL_ADMIN_CERT_ARN` to a validated ACM certificate ARN.
When `UPSTREAM_NPM_REGISTRIES_JSON` entries use `authTokenSecretName`, SST creates linked secrets for those names and passes them to gateway, worker, and admin; set the secret values before routing installs through private upstreams.
The SST `AdminToken` secret is exposed as `ANVIL_ADMIN_TOKEN` and the legacy `ADMIN_TOKEN` alias for gateway and admin. New client/operator commands should use `ANVIL_ADMIN_TOKEN`; the alias is kept so older local scripts do not faceplant.
Deployment policy overrides use the same `POLICY_*` environment variables described above. `pnpm sst:preflight` validates boolean and non-negative integer policy values before deployment, which is cheaper than discovering `POLICY_MINIMUM_PACKAGE_AGE_DAYS=banana` in ECS logs.

Run the local deploy preflight before `sst deploy` to catch missing gateway URLs, domain/certificate mismatches, malformed private upstream config, invalid policy overrides, and partially enabled LLM review:

```bash
PUBLIC_BASE_URL=https://npm.your-domain.com pnpm sst:preflight
```

Run migrations for SST deployments with:

```bash
pnpm sst:migrate
```

Deployment details are intentionally driven by `docs/anvil-registry-spec.md`; if this README and the spec ever disagree, trust the spec and fix the README.
