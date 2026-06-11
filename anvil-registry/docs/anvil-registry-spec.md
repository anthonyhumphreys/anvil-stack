# Anvil Registry Specification

**Product name:** Anvil Registry  
**Tagline:** A secure npm registry gateway that forges dependencies before they reach your machine.

---

## 1. Purpose

Anvil Registry is a TypeScript-based secure npm registry proxy. It acts as a drop-in replacement for the npm registry and applies dependency security controls before packages are installed by developers or CI.

It should support local Docker Compose deployment and AWS deployment via SST.

The service must:

1. Proxy npm-compatible package metadata and tarballs.
2. Cache package metadata, tarballs, and analysis results.
3. Enforce package age policies.
4. Detect suspicious version changes using static analysis.
5. Detect typo-squatting and name-squatting risk.
6. Gate low-download and newly published packages.
7. Optionally use an LLM for structured risk review.
8. Allow explicit audited overrides.
9. Provide clear developer-facing explanations.
10. Run locally via Docker Compose or in AWS via SST.

---

## 2. Product Principles

### 2.1 Drop-in first

Developers should be able to use the service with:

```bash
npm config set registry http://localhost:4873
```

or project-level:

```ini
registry=http://localhost:4873
```

The service must support npm install flows by proxying package metadata and tarballs, rewriting tarball URLs so traffic remains inside the proxy.

### 2.2 Deterministic policy decides

The deterministic policy engine is the enforcement authority.

LLMs may:

- Summarise risk.
- Explain findings.
- Highlight ambiguity.
- Recommend quarantine.
- Provide reviewer-friendly context.

LLMs must not be the sole reason a package is allowed.

### 2.3 Fail closed where it matters

CI and production modes should prefer fail-closed behaviour for unknown or high-risk packages.

Development mode may warn or quarantine depending on configuration.

### 2.4 Cache everything by immutable identity

Analysis and policy decisions should be cached by:

- Package name.
- Version.
- Tarball integrity/hash.
- Analysis engine version.
- Policy version.

If the analyser changes, previous decisions can be invalidated or marked stale.

---

## 3. Recommended Technical Stack

### 3.1 Runtime

- **Language:** TypeScript.
- **Runtime:** Node.js 22 LTS.
- **Package manager:** pnpm.
- **Monorepo:** Turborepo.
- **HTTP server:** Fastify for the registry gateway; Next.js route handlers for Admin.
- **Validation:** Zod.
- **Logging:** Pino.
- **Testing:** Vitest.
- **Database:** Postgres.
- **ORM/migrations:** Drizzle.
- **Queue:** BullMQ locally, SQS on AWS.
- **Object storage:** MinIO locally, S3 on AWS.
- **Admin UI:** Next.js.
- **CLI:** Node/TypeScript.
- **Infrastructure:** Docker Compose and SST.

### 3.2 Why TypeScript

Anvil Registry lives inside the npm ecosystem. TypeScript gives the best ergonomics for npm metadata parsing, lockfile handling, tarball handling, CLI development, and ecosystem-specific tooling.

---

## 4. Monorepo Structure

```text
anvil-registry/
  apps/
    gateway/
      src/
      Dockerfile
      package.json

    worker/
      src/
      Dockerfile
      package.json

    admin/
      app/
      components/
      lib/
      next.config.mjs
      Dockerfile
      package.json

    cli/
      src/
      package.json

  packages/
    config/
    logger/
    shared/
    npm-registry/
    policy-engine/
    package-analysis/
    name-squatting/
    llm-risk-review/
    persistence/
    object-store/
    queue/

  infra/
    docker/
      docker-compose.yml
      minio/
      postgres/

    sst/
      sst.config.ts

  devcontainer-base/
    Dockerfile
    scripts/
    npmrc
    README.md

  docs/
    anvil-registry-spec.md
    anvil-node-base-spec.md

  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
```

---

## 5. Applications

## 5.1 `apps/gateway`

The gateway is the npm-compatible proxy.

### Responsibilities

- Receive npm registry metadata requests.
- Receive npm tarball requests.
- Fetch upstream npm metadata.
- Cache upstream metadata.
- Rewrite tarball URLs.
- Filter or rewrite blocked versions.
- Rewrite dist-tags to latest approved versions.
- Check policy decisions.
- Enqueue analysis jobs.
- Serve cached tarballs.
- Return developer-friendly block/quarantine errors.
- Expose health and readiness endpoints.

### Key routes

```http
GET /-/health
GET /-/ready

GET /:packageName
GET /@:scope/:packageName
GET /:packageName/-/:tarballName
GET /@:scope/:packageName/-/:tarballName

POST /-/anvil/explain
POST /-/anvil/analyze
POST /-/anvil/llm-review
POST /-/anvil/override
POST /-/anvil/node-base/reports
GET  /-/anvil/policy
GET  /-/anvil/queue

POST /-/npm/v1/security/advisories/bulk
POST /-/npm/v1/security/audits/quick
```

`GET /-/health` is a liveness check and should only prove the gateway process can answer HTTP. `GET /-/ready` is a traffic-readiness check and must fail with HTTP 503 when required runtime dependencies are unavailable. At minimum, readiness should report component status for persistence, object storage, and the analysis queue so load balancers and deploy scripts do not route npm install traffic into a service that can only provide interpretive dance.

`POST /-/anvil/explain` requires a package target (`packageName`, with optional `version` defaulting to `latest`) and should reject malformed input before fetching upstream metadata.

`POST /-/anvil/analyze` and `POST /-/anvil/llm-review` accept either one target (`packageName`, optional `version`) or a `targets` array. Target request bodies are validated, trimmed, deduplicated, and rejected with HTTP 400 when malformed rather than being allowed to wander into queueing code wearing a false moustache.

`POST /-/anvil/override` and `POST /-/anvil/override/revoke` are token-gated mutation routes. Create requests must include a non-empty `packageName` and `reason`, default `action` to `allow`, trim string fields, reject unknown actions, and validate payloads before writing overrides or audit events.

`POST /-/anvil/node-base/reports` accepts token-gated Anvil Node Base JSON reports for Admin visibility. The body is validated with Zod, requires a simple report type and JSON object report, and may include `source`, `projectName`, and `summary`. If `summary` is omitted, the gateway can lift `report.summary` into the persisted report summary.

`GET /-/anvil/queue` is a token-gated operator endpoint that returns analysis queue depth for the configured queue driver. BullMQ reports waiting, active, delayed, failed, completed, and total pending counts. SQS reports approximate waiting, in-flight, and delayed counts from queue attributes because AWS enjoys putting "approximate" in the one place operators want a number.

The npm security audit endpoints are proxied to the configured upstream registry so ordinary npm install flows can keep their default audit behaviour while package metadata and tarballs still route through Anvil policy.

Actual npm scoped package paths can be quirky, so route handling must be tested against real npm, pnpm, and yarn requests.

### Metadata request flow

1. Client requests package metadata.
2. Gateway checks metadata cache.
3. If missing or stale, fetch from upstream registry.
4. Gateway evaluates each version against cheap metadata policy:
   - package age
   - known override
   - known blocked package
   - download/adoption metadata if available
   - known name-squatting signal
5. Gateway checks cached decisions for versions.
6. Gateway filters blocked versions.
7. Gateway can hide quarantined versions depending on policy mode.
8. Gateway rewrites dist-tags to point at newest allowed version.
9. Gateway rewrites tarball URLs to route through Anvil.
10. Gateway returns npm-compatible metadata.

### Tarball request flow

1. Client requests tarball.
2. Gateway identifies package/version.
3. Gateway checks policy decision cache.
4. If allowed:
   - serve tarball from object store if cached
   - otherwise fetch upstream, cache, stream to client
5. If unknown:
   - run cheap policy checks
   - enqueue deep analysis
   - allow, quarantine, or block depending runtime mode
6. If blocked/quarantined:
   - return HTTP error with Anvil explanation payload

---

## 5.2 `apps/worker`

The worker performs analysis outside the install request path.

### Responsibilities

- Consume analysis jobs.
- Fetch package metadata.
- Fetch target tarball.
- Fetch previous N versions.
- Unpack tarballs safely.
- Run static analysis.
- Run manifest diff.
- Run dependency diff.
- Run install script analysis.
- Run name-squatting checks.
- Optionally call LLM risk review.
- Persist reports.
- Persist policy decisions.
- Write audit events.
- Provide a dependency health-check command for orchestration.

### Worker job type

```ts
export type AnalysisJob = {
  packageName: string;
  version: string;
  requestedBy?: string;
  reason: "metadata_request" | "tarball_request" | "lockfile_scan" | "manual_review";
  priority: "low" | "normal" | "high";
  runLlmReview?: boolean;
  createdAt: string;
};
```

### Analysis stages

1. Resolve target package/version metadata.
2. Resolve previous 3 published versions.
3. Download tarballs into isolated temporary storage.
4. Extract without executing scripts.
5. Analyse package manifests.
6. Analyse file tree changes.
7. Analyse suspicious code patterns.
8. Analyse dependency delta.
9. Analyse name/download/reputation signals.
10. Optionally request LLM structured review.
11. Persist report.
12. Compute final policy decision.

### Worker health check

The worker image should support:

```bash
node apps/worker/dist/index.js --health-check
```

The command must exit `0` only when the worker can reach required runtime dependencies for consuming jobs and persisting results. At minimum that means persistence and the configured analysis queue. Docker Compose and SST should use this as the worker container health check.

### Manual and lockfile analysis enqueue

The gateway exposes `POST /-/anvil/analyze` so developer tools can enqueue explicit package analysis without waiting for a blocked metadata or tarball request. It accepts either a single `packageName`/`version` pair or a `targets` array, deduplicates exact package/version pairs, and enqueues `AnalysisJob` messages with `manual_review` by default. CLI lockfile warming uses `reason: "lockfile_scan"` so worker output can be traced back to preinstall review rather than install-path enforcement. `anvil scan --queue-analysis` uses the same route for risky or not-yet-reviewed lockfile targets after printing the policy verdict.

`anvil queue status` calls `GET /-/anvil/queue` with the admin token and prints current queue depth so local operators can see backlog before blaming policy, npm, or whatever else is closest to hand.

The gateway also exposes token-gated `POST /-/anvil/llm-review` for reviewer-requested model context when LLM review is enabled. It accepts the same single-target or `targets` array shape as `/analyze`, deduplicates exact package/version pairs, enqueues high-priority `manual_review` jobs with `runLlmReview: true`, and records `llm_review.enqueued` audit events. The worker must still respect the private-package opt-in; this route is a review trigger, not a permission slip to leak private source because someone got enthusiastic.

The Admin package review action validates its `requestedBy` and `priority` fields before forwarding to the gateway, and defaults empty form submissions to `admin-ui`/`high`.

---

## 5.3 `apps/admin`

The admin app is a Next.js App Router service that provides human review, policy visibility, and the route-handler JSON API used by the CLI for review data.

### Features

- ShadCN/Tailwind dashboard.
- Blocked package list.
- Quarantined package list.
- Package version detail page.
- Analysis report viewer.
- LLM risk review viewer and reviewer-triggered LLM review request.
- Override approval workflow.
- Effective policy configuration viewer.
- Audit log.
- Popular package index viewer.
- Popular package index upload workflow.
- JSON route handlers for CLI-facing review data: decisions, overrides, audit events, analysis reports, Node Base reports, policy, package review, LLM review requests, and popular package index operations.

Admin exposes `GET /api/policy` and `/policy` so reviewers can inspect the runtime mode and effective deterministic policy. Policy editing is intentionally not part of this slice; config still comes from environment and deployment configuration. When `ANVIL_ADMIN_TOKEN` or the legacy `ADMIN_TOKEN` alias is configured, Admin pages and API route handlers require the bearer token or the local admin session cookie.

Admin package review URLs must preserve scoped package names with URL encoding, for example `/packages/%40scope%2Fpkg/1.0.0`.

### MVP auth

Local:

```text
Admin token via environment variable
```

AWS:

```text
Cognito or OAuth provider later
```

---

## 5.4 `apps/cli`

The CLI gives developers a way to inspect decisions before install or CI.

### Commands

```bash
anvil scan package-lock.json
anvil scan pnpm-lock.yaml --queue-analysis
anvil scan yarn.lock --queue-analysis
anvil explain react@19.0.0
anvil explain @tanstack/react-query@latest
anvil warm package-lock.json
anvil warm yarn.lock
anvil approve package@version --reason "intentional dependency" --approved-by reviewer --expires-at 2026-06-20T00:00:00Z
anvil revoke package@version --revoked-by reviewer
anvil llm-review package@version --requested-by reviewer
anvil queue status
anvil popular-index show
anvil popular-index upload popular-index.json --generated-at 2026-05-20T00:00:00Z
anvil policy test package.json
anvil doctor
```

### Example output

```text
Anvil blocked @tenstack/react-query@1.0.1

Reasons:
- Package has very low weekly downloads.
- Package name is similar to @tanstack/react-query.
- Package was published less than 7 days ago.

Suggested package:
- @tanstack/react-query

Override:
anvil approve @tenstack/react-query@1.0.1 --reason "intentional"
```

---

## 6. Core Packages

## 6.1 `packages/policy-engine`

The policy engine must be pure and deterministic.

### Input

```ts
export type PolicyInput = {
  packageName: string;
  version: string;
  runtimeMode: "development" | "ci" | "production";
  evaluatedAt?: string;
  metadata?: PackageMetadataSummary;
  versionMetadata?: PackageVersionMetadata;
  weeklyDownloads?: number;
  packageAgeDays?: number;
  analysisReport?: AnalysisReport;
  llmRiskReview?: LlmRiskReview;
  override?: Override;
  policy: PolicyConfig;
};
```

### Output

```ts
export type PolicyDecision = {
  action: "allow" | "warn" | "quarantine" | "block";
  score: number;
  reasons: PolicyReason[];
  explanation: string;
  expiresAt?: string;
};
```

### Policy reasons

```ts
export type PolicyReasonCode =
  | "PACKAGE_TOO_NEW"
  | "LOW_WEEKLY_DOWNLOADS"
  | "SIMILAR_TO_POPULAR_PACKAGE"
  | "NEW_PACKAGE_LOW_DOWNLOADS"
  | "NEW_INSTALL_SCRIPT"
  | "INSTALL_SCRIPT_CHANGED"
  | "NEW_DEPENDENCY_IN_PATCH_VERSION"
  | "SUSPICIOUS_FILE_ADDED"
  | "OBFUSCATED_CODE_DETECTED"
  | "UNEXPECTED_BINARY_FILE"
  | "USES_CHILD_PROCESS"
  | "USES_PROCESS_ENV"
  | "NETWORK_ACCESS_IN_INSTALL_PATH"
  | "REPOSITORY_CHANGED"
  | "PROVENANCE_MISSING"
  | "LLM_RISK_REVIEW_FLAGGED"
  | "APPROVED_OVERRIDE";
```

### Example policy config

```yaml
runtimeMode: production

policy:
  minimumPackageAgeDays: 7
  comparePreviousVersions: 3

  lowDownloadThreshold: 1000
  strictLowDownloadThreshold: 100
  blockSimilarLowDownloadPackages: true

  blockNewInstallScripts: true
  quarantineChangedInstallScripts: true
  blockUnexpectedBinaries: true
  quarantineObfuscatedCode: true

  llmReview:
    enabled: true
    includePrivatePackages: false
    runOnUnknownPackages: true
    runOnQuarantine: true
    provider: azure-openai
    model: gpt-5-nano

  overrides:
    enabled: true
    requireReason: true
    defaultExpiryDays: 30
```

---

## 6.2 `packages/npm-registry`

Handles npm registry protocol quirks.

### Responsibilities

- Fetch upstream package metadata.
- Fetch tarballs.
- Resolve scoped package paths.
- Rewrite tarball URLs.
- Filter versions.
- Rewrite dist-tags.
- Normalise package names.
- Parse package manifests.

### Upstream registry config

```ts
export type UpstreamRegistryConfig = {
  name: string;
  baseUrl: string;
  scopes?: string[];
  authTokenSecretName?: string;
};
```

Example:

```yaml
registries:
  - name: npmjs
    baseUrl: https://registry.npmjs.org

  - name: github
    baseUrl: https://npm.pkg.github.com
    scopes:
      - "@my-org"
    authTokenSecretName: GITHUB_NPM_TOKEN
```

---

## 6.3 `packages/package-analysis`

Runs deterministic static analysis.

### Manifest checks

- `package.json` added/removed/changed.
- Scripts added/removed/changed.
- Dependencies added/removed/changed.
- Dev dependencies added/removed/changed.
- Optional dependencies added/removed/changed.
- Peer dependencies added/removed/changed.
- `bin` entries added/changed.
- `files` field changed.
- Repository changed.
- License changed.
- Maintainers changed where available.

### Install script checks

High-risk lifecycle scripts:

- `preinstall`
- `install`
- `postinstall`
- `prepare`
- `prepublish`
- `prepublishOnly`

### Code pattern checks

Flag suspicious usage in install-path files:

- `child_process.exec`
- `child_process.execSync`
- `child_process.spawn`
- `child_process.spawnSync`
- `process.env`
- `fs.readFileSync`
- `fs.readdirSync`
- `os.homedir`
- `http.request`
- `https.request`
- `fetch`
- `net.connect`
- `dns.lookup`
- `eval`
- `new Function`
- `Buffer.from(base64)`

### File tree checks

- New binary files.
- Unexpected executable files.
- Large size delta.
- New minified files.
- New encoded blobs.
- New hidden files.
- New files under unusual paths.
- Package tarball contains credential-looking files.

### Diff policy

Compare target version against the previous 3 versions by default.

```text
target:     foo@1.2.4
baseline:   foo@1.2.3
baseline:   foo@1.2.2
baseline:   foo@1.2.1
```

The analysis should report:

- What changed.
- Why it matters.
- Whether it affects install-time execution.
- Whether it affects runtime only.
- Whether it is expected for major/minor/patch release type.

---

## 6.4 `packages/name-squatting`

Detects typo-squatting, scope-squatting, and brand confusion.

### Signals

- Low weekly downloads.
- New package.
- Similar to popular package.
- Similar to popular scope.
- Hyphen/underscore variant.
- Pluralisation variant.
- Missing character.
- Extra character.
- Transposed characters.
- Visual similarity.
- Known ecosystem confusion.

### Algorithms

- Damerau-Levenshtein distance.
- Jaro-Winkler similarity.
- Token normalisation.
- Scope/name splitting.
- Hyphen/underscore normalisation.
- Popular package index lookup.
- Known ecosystem map.

Detector output should preserve the likely intended package and the reasons that matched, such as `known_ecosystem_confusion`, `similar_scope`, `missing_character`, `extra_character`, `transposed_characters`, `pluralisation_variant`, and `visual_similarity`.

The gateway, worker, and admin UI load the popular package index from object storage at `POPULAR_PACKAGE_INDEX_OBJECT_KEY` when configured, defaulting to `popular-index/npm/latest.json` in local Docker/SST deployments. `POPULAR_PACKAGE_INDEX_PATH` remains a local-file fallback for development and bootstrap workflows. The JSON index contains:

```json
{
  "generatedAt": "2026-05-20T00:00:00.000Z",
  "popularPackages": [{ "name": "lodash", "weeklyDownloads": 60000000, "aliases": ["loadash"] }],
  "knownConfusions": { "loadash": "lodash" }
}
```

If no object or path is configured, Anvil uses the built-in seed index. Admin exposes the active index at `GET /api/popular-package-index` and `/popular-package-index` so reviewers can inspect which package names and known confusion pairs are driving deterministic typo-squatting evidence. Admin also accepts uploads from the `/popular-package-index` page and `POST /api/popular-package-index` with the same JSON shape, validates the index, writes it to `popular-index/npm/{date}.json`, updates the active object key, and records an audit event.

### Example detection

```text
Requested:
  @tenstack/react-query

Similar popular package:
  @tanstack/react-query

Decision:
  block if low downloads + high similarity
```

### Policy

```ts
if (lowDownloads && similarToPopularPackage) {
  return block("Possible typo-squatting package");
}

if (newPackage && lowDownloads) {
  return quarantine("New low-adoption package");
}

if (lowDownloads) {
  return warn("Low-adoption package");
}
```

---

## 6.5 `packages/llm-risk-review`

Optional structured LLM review.

### Purpose

The LLM risk review enriches deterministic findings but does not replace them.

### When to run

- Package is unknown.
- Package is quarantined.
- Package has high-risk static signals.
- Package is low-download and name-similar.
- Package introduces install scripts.
- Package has suspicious dependency tree.
- Human requested explanation.

### When not to run

- Known approved package/version.
- Happy path install.
- Private package unless explicitly enabled.
- Large source dump.
- Sensitive internal project data.

### Input shape

```ts
export type LlmRiskReviewInput = {
  packageName: string;
  version: string;
  packageAgeDays?: number;
  weeklyDownloads?: number;
  similarPopularPackages: Array<{
    name: string;
    similarity: number;
    weeklyDownloads?: number;
    reasons?: string[];
    suggestedPackage?: string;
  }>;
  deterministicSignals: PolicyReasonCode[];
  manifestDiff?: ManifestDiff;
  dependencyDiff?: DependencyDiff;
  suspiciousSnippets?: Array<{
    file: string;
    reason: string;
    snippet: string;
  }>;
};
```

### Output shape

```ts
export type LlmRiskReview = {
  riskLevel: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  summary: string;
  suspectedRiskTypes: Array<
    | "typosquatting"
    | "dependency_confusion"
    | "credential_exfiltration"
    | "install_script_abuse"
    | "obfuscation"
    | "unexpected_network_access"
    | "suspicious_maintainer_change"
    | "overbroad_dependency_tree"
    | "unknown"
  >;
  evidence: Array<{
    signal: string;
    explanation: string;
    source:
      | "metadata"
      | "package_json"
      | "diff"
      | "code_snippet"
      | "download_stats";
  }>;
  recommendedAction: "allow" | "warn" | "quarantine" | "block";
};
```

### Safety rules

- Validate output with Zod.
- Ignore malformed output.
- Never allow solely because the LLM recommends allow.
- Treat high-risk LLM review as a quarantine signal unless deterministic policy also supports block.
- Do not send private package source unless explicitly enabled.

---

## 7. Persistence Model

## 7.1 Tables

```sql
packages
  id
  name
  scope
  upstream_registry
  created_at
  updated_at

package_versions
  id
  package_id
  version
  published_at
  tarball_url
  integrity
  shasum
  weekly_downloads
  cached_tarball_key
  created_at
  updated_at

analysis_reports
  id
  package_version_id
  analyser_version
  policy_version
  status
  score
  signals_json
  manifest_diff_json
  dependency_diff_json
  file_diff_json
  report_json
  created_at

llm_risk_reviews
  id
  analysis_report_id
  provider
  model
  risk_level
  confidence
  review_json
  created_at

policy_decisions
  id
  package_version_id
  action
  score
  reasons_json
  explanation
  policy_version
  expires_at
  created_at

overrides
  id
  package_name
  version
  action
  reason
  requested_by
  approved_by
  expires_at
  created_at
  revoked_at

audit_events
  id
  actor
  event_type
  target_type
  target_id
  metadata_json
  created_at

policy_configs
  id
  name
  version
  config_json
  active
  created_at
```

---

## 8. Object Storage

Object storage should hold bulky artefacts.

### Keys

```text
tarballs/{packageName}/{version}/{integrity}.tgz
analysis/{packageName}/{version}/{analysisId}/report.json
analysis/{packageName}/{version}/{analysisId}/manifest-diff.json
analysis/{packageName}/{version}/{analysisId}/file-tree.json
popular-index/npm/{date}.json
```

Local:

```text
MinIO
```

AWS:

```text
S3
```

---

## 9. Queueing

Use an adapter to support local and AWS.

### Interface

```ts
export interface JobQueue {
  enqueueAnalysisJob(job: AnalysisJob): Promise<void>;
  receiveAnalysisJobs(): AsyncIterable<AnalysisJob>;
  acknowledge(jobId: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
}
```

### Local

```text
BullMQ + Redis
```

### AWS

```text
SQS + dead-letter queue
```

The runtime queue adapter must support `QUEUE_DRIVER=sqs` with `ANALYSIS_QUEUE_URL`. The gateway sends `AnalysisJob` messages as JSON to SQS, and the worker consumes with long polling, deletes messages only after successful analysis, and returns failed messages to the queue for retry. BullMQ remains the local Redis-backed path.

---

## 10. Runtime Modes

## 10.1 Development

- Warn on low-risk issues.
- Quarantine unknown risky packages.
- Allow local overrides.
- Verbose explanations.
- Can fail open for missing LLM provider.

## 10.2 CI

- Fail closed.
- No unauthenticated overrides.
- Unknown suspicious packages fail.
- Quarantined packages fail.
- Lockfile scan available.

## 10.3 Production

- Fail closed for high-risk signals.
- Use cached decisions aggressively.
- Allow approved audited overrides; override creation defaults to `overrides.defaultExpiryDays` when no explicit `expiresAt` is supplied.
- Queue deep analysis.
- Record all policy events.

---

## 11. Docker Compose Deployment

### 11.1 Services

```yaml
services:
  gateway:
    build:
      context: .
      dockerfile: apps/gateway/Dockerfile
    ports:
      - "4873:4873"
    environment:
      RUNTIME_MODE: development
      PUBLIC_BASE_URL: http://localhost:4873
      DATABASE_URL: postgres://anvil:anvil@postgres:5432/anvil
      QUEUE_DRIVER: bullmq
      REDIS_URL: redis://redis:6379
      OBJECT_STORE_DRIVER: s3
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: anvil-package-cache
      S3_ACCESS_KEY_ID: minio
      S3_SECRET_ACCESS_KEY: miniopassword
      UPSTREAM_NPM_REGISTRY: https://registry.npmjs.org
    depends_on:
      - postgres
      - redis
      - minio

  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    environment:
      RUNTIME_MODE: development
      DATABASE_URL: postgres://anvil:anvil@postgres:5432/anvil
      QUEUE_DRIVER: bullmq
      REDIS_URL: redis://redis:6379
      OBJECT_STORE_DRIVER: s3
      S3_ENDPOINT: http://minio:9000
      S3_BUCKET: anvil-package-cache
      S3_ACCESS_KEY_ID: minio
      S3_SECRET_ACCESS_KEY: miniopassword
      UPSTREAM_NPM_REGISTRY: https://registry.npmjs.org
    depends_on:
      - postgres
      - redis
      - minio

  admin:
    build:
      context: .
      dockerfile: apps/admin/Dockerfile
    ports:
      - "3000:3000"
    environment:
      ANVIL_API_BASE_URL: http://gateway:4873
      ADMIN_TOKEN: local-dev-token
    depends_on:
      - gateway

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: anvil
      POSTGRES_USER: anvil
      POSTGRES_PASSWORD: anvil
    ports:
      - "5432:5432"
    volumes:
      - anvil-postgres:/var/lib/postgresql/data

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: miniopassword
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - anvil-minio:/data

volumes:
  anvil-postgres:
  anvil-minio:
```

The local Compose file passes optional `LLM_REVIEW_*` values through to gateway, worker, and admin. Set `LLM_REVIEW_ENABLED=true`, `LLM_REVIEW_ENDPOINT`, and optionally `LLM_REVIEW_API_KEY`, `LLM_REVIEW_PROVIDER`, `LLM_REVIEW_MODEL`, `LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES`, `LLM_REVIEW_RUN_ON_QUARANTINE`, or `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES` before `docker compose up` to exercise the MVP LLM review route locally. Empty optional values are treated as unset so a default Compose run does not fail config parsing just because no model endpoint exists yet. Provider credentials are passed only to the worker.

### 11.2 Database migrations

The persistence package owns the checked-in Drizzle migrations under:

```text
packages/persistence/drizzle/
```

Run migrations against a Postgres database with:

```bash
DATABASE_URL=postgres://anvil:anvil@localhost:5432/anvil pnpm db:migrate
```

The Docker Compose Postgres service still mounts `infra/docker/postgres/init` so a brand-new local volume starts with the current schema immediately. The migration runner is the deployment-friendly path for existing databases and should be run before starting gateway, worker, or admin services in shared environments.

Local Docker Compose runs migrations through a one-shot `migrate` service built from `packages/persistence/Dockerfile`. The gateway, worker, and admin services depend on that service completing successfully before they start, so fresh and existing local volumes follow the same migration path. The migrator waits for Postgres readiness before applying Drizzle migrations, because container startup order is not database readiness, no matter how confidently YAML suggests otherwise.

Local Docker Compose should also declare health checks for Postgres, Redis, and the gateway. The gateway health check should use `/-/ready`, and admin should wait for the gateway to become healthy before starting.

After the local stack is running, use the smoke command to verify the npm-facing path and admin health:

```bash
pnpm smoke:local
```

The smoke check must call gateway liveness/readiness, fetch package metadata, verify tarball URLs have been rewritten through Anvil, download the rewritten tarball URL, and check admin health when `ANVIL_ADMIN_URL` is set.

Use the client smoke to verify real package-manager install paths through the gateway:

```bash
pnpm smoke:clients
```

This command creates throwaway projects, installs known unscoped and scoped packages through Anvil with npm, pnpm, and Yarn, keeps lifecycle scripts disabled, and verifies the installed package versions. The npm leg keeps audit enabled by default and runs `npm audit` through the gateway so the npm security proxy routes are covered by the real client smoke. Set `ANVIL_CLIENT_SMOKE_NPM_AUDIT=false` only when deliberately testing without upstream audit availability.

Use the scoped upstream smoke to verify scoped/private registry routing without needing real private credentials:

```bash
pnpm smoke:scoped-upstream
```

This command starts a token-gated mock scoped registry and a local gateway, then verifies scoped metadata routing, tarball URL rewriting, upstream bearer auth, cache hits, and token-safe readiness output.

Use the analysis queue smoke to verify token-gated manual analysis enqueueing, worker consumption, persistence, and Admin report visibility:

```bash
pnpm smoke:analysis
```

To exercise reviewer-triggered LLM review locally, run:

```bash
pnpm smoke:llm-review
```

This starts the Compose stack with the `llm-review` profile, uses the local mock LLM review endpoint, queues a forced review through `POST /-/anvil/llm-review`, and verifies that the worker persists a review visible through Admin.

Use the Node Base image smoke to verify that the devcontainer image builds, defaults to the non-root `node` user, keeps safer npm config enabled, exposes the expected helper commands, and has a writable report directory:

```bash
pnpm smoke:node-base-image
```

Use the observed-mode image smoke to verify that the built Node Base image can run an install with lifecycle scripts explicitly enabled under `strace`, capture IOC/network evidence, write lifecycle and environment reports, and redact credential-shaped environment values:

```bash
pnpm smoke:node-base-image-observed
```

Use the image-to-registry smoke to verify that the built Node Base image can submit a generated report through the local gateway and that Admin/CLI can read the persisted report:

```bash
pnpm smoke:node-base-image-report
```

---

## 12. AWS Deployment with SST

## 12.1 AWS resources

- VPC.
- ECS cluster.
- Fargate service: gateway.
- Fargate service: worker.
- Fargate service: admin Next.js app.
- Application Load Balancer.
- RDS Postgres.
- S3 package cache bucket.
- SQS analysis queue.
- SQS dead-letter queue.
- Secrets/SSM parameters.
- CloudWatch logs.
- Route 53 DNS records.
- ACM certificate.

## 12.2 Conceptual SST config

> Exact SST component arguments should be verified during implementation. Treat this as deployment intent, not copy-paste production infrastructure.

```ts
export default $config({
  app(input) {
    return {
      name: "anvil-registry",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },

  async run() {
    const vpc = new sst.aws.Vpc("Vpc");

    const cluster = new sst.aws.Cluster("Cluster", {
      vpc,
    });

    const bucket = new sst.aws.Bucket("PackageCache");

    const queue = new sst.aws.Queue("AnalysisQueue", {
      dlq: {
        retry: 3,
      },
    });
    const adminToken = new sst.Secret("AdminToken");

    const database = new sst.aws.Postgres("Database", {
      vpc,
      database: "anvil",
      username: "anvil",
      dev: {
        host: "localhost",
        port: 5432,
        database: "anvil",
        username: "anvil",
        password: "anvil",
      },
    });

    const databaseEnvironment = {
      PERSISTENCE_DRIVER: "postgres",
      DATABASE_HOST: database.host,
      DATABASE_PORT: $interpolate`${database.port}`,
      DATABASE_NAME: database.database,
      DATABASE_USER: database.username,
      DATABASE_PASSWORD: database.password,
    };

    new sst.aws.Task("DatabaseMigration", {
      cluster,
      image: {
        context: ".",
        dockerfile: "packages/persistence/Dockerfile",
      },
      environment: {
        ...databaseEnvironment,
        DATABASE_READY_ATTEMPTS: "60",
        DATABASE_READY_DELAY_MS: "1000",
      },
      link: [database],
    });

    const gateway = new sst.aws.Service("Gateway", {
      cluster,
      image: {
        context: ".",
        dockerfile: "apps/gateway/Dockerfile",
      },
      loadBalancer: {
        rules: [
          {
            listen: "443/https",
            forward: "4873/http",
          },
        ],
        health: {
          "4873/http": {
            path: "/-/ready",
            successCodes: "200",
            interval: "30 seconds",
            timeout: "5 seconds",
            healthyThreshold: 2,
            unhealthyThreshold: 2,
          },
        },
      },
      health: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:4873/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        startPeriod: "30 seconds",
        interval: "30 seconds",
        timeout: "5 seconds",
        retries: 3,
      },
      environment: {
        RUNTIME_MODE: "production",
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
        ANVIL_ADMIN_TOKEN: adminToken.value,
        ADMIN_TOKEN: adminToken.value,
        OBJECT_STORE_DRIVER: "s3",
        S3_BUCKET: bucket.name,
        QUEUE_DRIVER: "sqs",
        ANALYSIS_QUEUE_URL: queue.url,
        UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
        NPM_DOWNLOADS_API: "https://api.npmjs.org/downloads",
        ...databaseEnvironment,
      },
      link: [bucket, queue, database, adminToken],
    });

    const admin = new sst.aws.Service("Admin", {
      cluster,
      image: {
        context: ".",
        dockerfile: "apps/admin/Dockerfile",
      },
      loadBalancer: {
        rules: [
          {
            listen: "443/https",
            forward: "3000/http",
          },
        ],
        health: {
          "3000/http": {
            path: "/-/health",
            successCodes: "200",
            interval: "30 seconds",
            timeout: "5 seconds",
            healthyThreshold: 2,
            unhealthyThreshold: 2,
          },
        },
      },
      health: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
        ],
        startPeriod: "30 seconds",
        interval: "30 seconds",
        timeout: "5 seconds",
        retries: 3,
      },
      environment: {
        RUNTIME_MODE: "production",
        ANVIL_API_BASE_URL: process.env.ANVIL_API_BASE_URL ?? process.env.PUBLIC_BASE_URL,
        ANVIL_ADMIN_TOKEN: adminToken.value,
        ADMIN_TOKEN: adminToken.value,
        OBJECT_STORE_DRIVER: "s3",
        S3_BUCKET: bucket.name,
        POPULAR_PACKAGE_INDEX_OBJECT_KEY: "popular-index/npm/latest.json",
        ...databaseEnvironment,
      },
      link: [bucket, database, adminToken],
    });

    const worker = new sst.aws.Service("Worker", {
      cluster,
      image: {
        context: ".",
        dockerfile: "apps/worker/Dockerfile",
      },
      health: {
        command: ["CMD", "node", "apps/worker/dist/index.js", "--health-check"],
        startPeriod: "30 seconds",
        interval: "30 seconds",
        timeout: "10 seconds",
        retries: 3,
      },
      environment: {
        RUNTIME_MODE: "production",
        OBJECT_STORE_DRIVER: "s3",
        S3_BUCKET: bucket.name,
        QUEUE_DRIVER: "sqs",
        ANALYSIS_QUEUE_URL: queue.url,
        UPSTREAM_NPM_REGISTRY: "https://registry.npmjs.org",
        NPM_DOWNLOADS_API: "https://api.npmjs.org/downloads",
        ...databaseEnvironment,
      },
      link: [bucket, queue, database],
    });

    return {
      gatewayUrl: gateway.url,
      adminUrl: admin.url,
      migrationTask: "DatabaseMigration",
    };
  },
});
```

The `DatabaseMigration` task uses the same Drizzle migration runner as local Docker Compose. It should be run after infrastructure deployment and before routing production install traffic to a new gateway or worker revision. Runtime services accept either a single `DATABASE_URL` or discrete `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD` values; the discrete form avoids building unsafe connection strings in infrastructure code.

The gateway service uses `/-/health` for the ECS container health check and `/-/ready` for the load-balancer target health check. The process can stay alive while a dependency is unavailable, but traffic should not be routed to a target that cannot reach Postgres, object storage, or the analysis queue.

The SST deployment also creates an admin Fargate service using the Next.js standalone build from `apps/admin/Dockerfile`, exposes `/-/health` as its load-balancer health check, and links an `AdminToken` secret into both gateway and admin as `ANVIL_ADMIN_TOKEN` plus the legacy `ADMIN_TOKEN` alias. That keeps override creation, index uploads, report submission, and manual analysis enqueueing token-gated in production while matching the current config package preference for `ANVIL_ADMIN_TOKEN`.

Set `PUBLIC_BASE_URL` or `ANVIL_GATEWAY_DOMAIN` before deployment so npm metadata rewrites tarball URLs to the real HTTPS gateway endpoint. SST fails fast when neither is configured, rather than emitting package metadata that points installers at a placeholder host. Set `ANVIL_GATEWAY_DOMAIN` and `ANVIL_ADMIN_DOMAIN` to attach custom load-balancer domains to the gateway or admin services. Route 53-hosted domains use SST's default DNS and certificate handling; externally managed DNS can set `ANVIL_GATEWAY_CERT_ARN` or `ANVIL_ADMIN_CERT_ARN` to a validated ACM certificate ARN, which disables automated DNS for that service and leaves the DNS record in the operator's hands.

SST passes deploy-time `LLM_REVIEW_ENABLED`, `LLM_REVIEW_PROVIDER`, `LLM_REVIEW_MODEL`, `LLM_REVIEW_ENDPOINT`, `LLM_REVIEW_RUN_ON_UNKNOWN_PACKAGES`, `LLM_REVIEW_RUN_ON_QUARANTINE`, and `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES` values into gateway, worker, and admin. The provider credential is the `LlmReviewApiKey` secret and is linked only to the worker, because the gateway enqueues review jobs and should not need the model key.

SST also forwards configured `POLICY_*` environment overrides into gateway, worker, and admin so install-path enforcement, worker analysis, and Admin policy inspection use the same deterministic policy settings. The deploy preflight validates boolean policy overrides and non-negative integer thresholds before `sst deploy`.

Run the SST deploy preflight before `sst deploy` to catch missing gateway URLs, domain/certificate mismatches, malformed private upstream config, invalid policy overrides, and partially enabled LLM review without touching AWS:

```bash
PUBLIC_BASE_URL=https://npm.your-domain.com pnpm sst:preflight
```

Run the deployed migration task through SST's linked resource shell:

```bash
pnpm sst:migrate
```

The migration runner starts `Resource.DatabaseMigration`, polls ECS until the task stops, and fails if the migration container exits non-zero. For local command validation without touching AWS:

```bash
pnpm --filter @anvilstack/infra-sst migrate:run -- --dry-run
```

---

## 13. Security Controls

## 13.1 Package age gate

Default:

```yaml
minimumPackageAgeDays: 7
```

Actions:

```text
Package < 1 day old:
  block unless override

Package 1-7 days old:
  quarantine unless override

Package > 7 days old:
  allow if other checks pass
```

## 13.2 Name-squatting gate

Default:

```yaml
lowDownloadThreshold: 1000
blockSimilarLowDownloadPackages: true
```

Actions:

```text
Low downloads only:
  warn

Low downloads + similar popular package:
  block

New + low downloads + similar popular package:
  block, high severity
```

## 13.3 Static analysis gate

Default:

```yaml
comparePreviousVersions: 3
blockNewInstallScripts: true
quarantineChangedInstallScripts: true
blockUnexpectedBinaries: true
quarantineObfuscatedCode: true
```

## 13.4 Provenance signal

Provenance should be treated as a positive trust signal where available, especially for critical packages.

Policy:

```text
Missing provenance:
  not automatically bad

Unexpected provenance change:
  suspicious

Trusted publishing present:
  reduce risk score

Critical package without provenance:
  warn or quarantine depending policy
```

---

## 14. Error Response Shape

When blocked, return useful JSON.

```json
{
  "error": "ANVIL_PACKAGE_BLOCKED",
  "package": "@tenstack/react-query",
  "version": "1.0.1",
  "decision": "block",
  "score": 95,
  "reasons": [
    {
      "code": "LOW_WEEKLY_DOWNLOADS",
      "message": "Package has fewer weekly downloads than the configured threshold."
    },
    {
      "code": "SIMILAR_TO_POPULAR_PACKAGE",
      "message": "Package name is similar to @tanstack/react-query."
    }
  ],
  "suggestions": [
    {
      "package": "@tanstack/react-query",
      "reason": "Popular package with similar name."
    }
  ],
  "overrideHint": "Run: anvil approve @tenstack/react-query@1.0.1 --reason \"intentional\""
}
```

---

## 15. Acceptance Criteria

## 15.1 Gateway

- Can be used as npm registry via `npm config set registry`.
- Can proxy metadata for unscoped packages.
- Can proxy metadata for scoped packages.
- Can proxy tarballs.
- Rewrites tarball URLs to the Anvil gateway.
- Can block versions younger than configured minimum age.
- Can rewrite latest dist-tag to newest allowed version.
- Returns useful error response for blocked package.

## 15.2 Worker

- Can analyse `package@version`.
- Can fetch previous 3 versions.
- Can detect new install scripts.
- Can detect changed install scripts.
- Can detect new dependencies.
- Can detect dependency additions in patch versions.
- Can persist analysis report.
- Can persist policy decision.

## 15.3 Name-squatting

- Can detect `tenstack` vs `tanstack`.
- Can detect `loadash` vs `lodash`.
- Can detect `@vite/plugin-react` vs `@vitejs/plugin-react`.
- Can combine low downloads + similarity into block decision.
- Can suggest likely intended package.

## 15.4 LLM review

- Runs only when configured.
- Runs only for suspicious/unknown/quarantined packages.
- Produces schema-valid JSON.
- Does not make final allow decision.
- Stores review against analysis report.
- Failure does not break deterministic policy engine.

## 15.5 Docker Compose

- `docker compose up` starts gateway, worker, admin, postgres, redis, minio.
- `npm install` can run through local gateway.
- Admin UI can view package decision.
- Worker can process analysis queue.

## 15.6 SST

- SST deploy creates gateway, worker, admin, and migration services.
- Gateway and Admin are accessible through HTTPS endpoints.
- Worker consumes SQS jobs.
- Tarballs are cached in S3.
- Reports are persisted.
- Logs are visible in CloudWatch.

---

## 16. Build Roadmap

## Phase 1: Anvil Registry MVP

- Fastify gateway.
- npm metadata proxy.
- tarball proxy.
- tarball URL rewriting.
- Postgres persistence.
- MinIO/S3 object cache.
- Docker Compose stack.
- Minimum package age policy.
- Basic block response.

## Phase 2: Worker and static analysis

- BullMQ/SQS queue adapter.
- Worker service.
- Previous 3 version resolution.
- Manifest diff.
- Lifecycle script detection.
- Dependency diff.
- Analysis report persistence.

## Phase 3: Name-squatting

- Popular package index.
- Download threshold.
- Similarity matching.
- Scope confusion detection.
- Suggested intended package.
- Override flow.

## Phase 4: LLM risk review

- Structured LLM review.
- Zod validation.
- Review persistence.
- Risk explanation summaries.
- Admin report integration.

## Phase 5: Admin and CLI

- Admin dashboard.
- Override approval.
- Override revoke.
- Audit log.
- `anvil scan`.
- `anvil explain`.
- `anvil warm`.
- `anvil llm-review`.
- `anvil popular-index show/upload`.

## Phase 6: SST production deployment

- SST VPC.
- ECS/Fargate gateway.
- ECS/Fargate worker.
- S3 cache.
- SQS queue.
- RDS Postgres.
- HTTPS domain.
- CloudWatch logs.
