# Cloudflare adapter implementation plan

## Purpose

This document records the staged implementation of Cloudflare as Anvil Cloud's
next deployment adapter. Cloudflare is currently a **plan-only preview target**:
`plan` and `review` expose stable provider mappings, cost drivers, and blocking
gates, but deploy and remove remain disabled. This does not ship a second
production adapter inside the current alpha milestone.

Cloudflare is a good next adapter candidate because Workers, Durable Objects,
D1, R2, Queues, Cron Triggers, Workers AI, and Pages map naturally onto many
Anvil concepts while keeping the Cell authoring model small and
provider-neutral.

For agent-created previews, the adapter also models [Cloudflare Temporary
Accounts](https://developers.cloudflare.com/workers/platform/claim-deployments/).
`anvil-cloud plan --stage preview --adapter cloudflare --temporary --json`
selects that authentication mode. It requires Wrangler 4.102.0 or later when
deployment lands, needs no existing Cloudflare credentials, and produces a
claim URL that must be completed within 60 minutes. The current plan-only phase
does not invoke Wrangler or create an account.

## Current state assessment

### What is ready

- **Provider-neutral Cell authoring exists.** Cells declare schema, routes,
  handlers, jobs, workflows, services, capabilities, and client targets without
  importing provider SDKs or infrastructure resources.
- **The builder emits inspectable artifacts.** The builder produces a Cell
  manifest and Cell graph that adapters can consume without executing user code
  or leaking provider terms into the graph.
- **The runtime contract is shared.** Local runtime, tests, Lambda entrypoints,
  jobs, and workflow execution are normalised through the same runtime request
  and host capability model.
- **AWS establishes adapter precedent.** The AWS adapter demonstrates stable
  plan/review metadata, cost drivers, approval gates, rollback and cleanup
  guidance, generated runtime entrypoints, remote inspection, logs, and
  provider-owned resource synthesis.
- **Guard rails exist for portability.** Import policy and graph validation keep
  Pulumi, AWS, Terraform, CDK, and similar provider concepts out of Cell code
  and provider-neutral manifests.
- **The planning contract is shared.** `@anvil-cloud/deployment` owns the
  provider-neutral plan/review types and conformance harness rather than making
  new adapters depend on `@anvil-cloud/aws`.
- **Conformance checks cover AWS and Cloudflare.** `runPreviewAdapterConformance` validates
  stable adapter plan metadata, sorted ids, approval gates, cost metadata,
  rollback commands, and cleanup commands.
- **CLI planning is registered by adapter name.** `plan` and `review` resolve
  `aws` and `cloudflare` through one registry. Unknown providers and unsupported
  lifecycle operations fail with explicit machine-readable usage errors.

### What is not ready

- **The AWS adapter has two deployment paths.** The newer manifest-based preview
  adapter and older graph/Pulumi adapter overlap. Cloudflare targets only the
  provider-neutral manifest planning contract; AWS compatibility keeps the
  legacy stage deploy/remove path in place for now.
- **Cloudflare lifecycle operations are intentionally blocked.** The adapter
  makes no provider calls and creates no resources until the Worker runtime
  bridge, bundling compatibility gates, and deploy/remove smoke tests exist.
- **Cloud runtime assumptions differ from Lambda.** Cloudflare Workers are
  V8-isolate based, not Node.js processes. Bundling, module format, unsupported
  Node APIs, binary handling, background work, and environment bindings need
  explicit compatibility gates.
- **Some Anvil features need Cloudflare-specific policy decisions.** Services,
  workflows, agent sandboxes, brokered credentials, file public-read policy,
  auth verification, and outbound fetch enforcement do not all have one-to-one
  Cloudflare equivalents yet.

## Target Cloudflare mapping

| Anvil concept                    | Cloudflare backing                                              | Initial support                               |
| -------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Runtime HTTP ingress             | Workers routes or Pages Functions                               | Preview target                                |
| Query/mutation/endpoint handlers | Worker module invoking shared Anvil Runtime                     | Preview target                                |
| Client bundle                    | Cloudflare Pages or R2-backed static assets                     | Preview target                                |
| Database                         | D1 for relational/simple table storage                          | Preview target, gated by schema compatibility |
| Files                            | R2 bucket and object prefixes                                   | Preview target                                |
| Environment/secrets              | Worker secrets and vars                                         | Preview target                                |
| Logs                             | Workers logs / tail events, later Logpush                       | Preview target for recent logs                |
| Scheduled jobs                   | Cron Triggers                                                   | Follow-up                                     |
| Queued jobs                      | Cloudflare Queues                                               | Follow-up                                     |
| Workflows                        | Cloudflare Workflows, Durable Objects, or adapter-managed state | Design required                               |
| Services                         | Not supported initially                                         | Block with review diagnostic                  |
| Agent inference                  | Workers AI or external provider through brokered fetch          | Follow-up                                     |
| Agent sandboxes                  | Not supported initially                                         | Block with review diagnostic                  |
| Outbound fetch                   | Runtime allow-list guard in Worker global fetch                 | Preview target                                |
| Deploy metadata                  | D1 table, KV namespace, or R2 metadata object                   | Preview target                                |
| Audit events                     | D1/KV append records                                            | Follow-up                                     |

## Temporary Account contract

Temporary Accounts are the preferred first-run path for interactive or
agent-created previews, not a production or CI credential strategy. The
implementation must preserve these provider constraints:

- invoke `wrangler deploy --temporary` only when no OAuth login, API token, or
  global API key is already active;
- require Wrangler 4.102.0 or later;
- keep Wrangler's global temporary configuration isolated per operating-system
  user; never share it between Anvil users;
- treat both the temporary API token and claim URL as bearer credentials: never
  include them in logs, analytics, plan JSON, support telemetry, or client-side
  responses;
- deliver the claim URL only to the intended user and delete any stored copy by
  the account or claim expiry;
- allow redeploy during the claim window, then require normal authenticated
  deployment after claim;
- fail closed when a Cell needs an unsupported temporary-account resource.

Cloudflare currently documents Workers, Workers Static Assets, KV, one D1
database, Durable Objects, Hyperdrive, Queues, and selected certificate
operations for Temporary Accounts. R2 is not in that supported-resource list,
so `capabilities.files` produces a blocking diagnostic in temporary mode even
though permanent-account planning maps files to R2. Secret-binding operations
are also not documented in that list, so Cells declaring
`capabilities.secrets` fail closed in temporary mode until that path is
provider-verified.

## Compatibility policy

The first Cloudflare adapter should be called a **preview adapter**, not a broad
production target. It should deploy only Cells that fit the Workers execution
model and should return stable diagnostics for unsupported features rather than
silently degrading behaviour.

Initial blocking diagnostics should include:

- Node-only runtime or dependencies that cannot bundle for Workers.
- Services, agent sandboxes, or other long-running process expectations.
- File features that require public-read semantics before R2 public access is
  designed.
- Workflows or jobs until the adapter has durable scheduling/state semantics.
- Database schemas that cannot be represented safely in the first D1 mapping.
- Environment or secret declarations that lack corresponding Cloudflare binding
  configuration.

## Implementation plan

### Phase 0: Stabilise the shared adapter contract — complete

1. Extract provider-neutral deployment plan, review, operations, result, and
   conformance types out of `@anvil-cloud/aws` into a shared module such as
   `@anvil-cloud/builder` or a new `@anvil-cloud/deployment` package.
2. Replace literal `adapter: "aws"` plan typing with `adapter: string` plus
   adapter-specific extension metadata under a namespaced field.
3. Make conformance tests adapter-agnostic and require:
   - stable schema version;
   - plan adapter name matching the registered adapter;
   - stable sorted review ids;
   - approval summaries matching gates;
   - cost, rollback, and cleanup guidance;
   - machine-readable unsupported-feature diagnostics.
4. Define one canonical deploy input shape: manifest, build output, stage or
   environment, preview name, previous manifest/graph when available, and
   adapter options.
5. Update AWS to implement the extracted contract without changing CLI JSON
   shapes.

### Phase 1: Add an adapter registry and Cloudflare package shell — complete

1. Add `packages/cloudflare` with no provider deployment side effects at import
   time.
2. Export a `CloudflarePreviewDeploymentAdapter` that plans without network
   access and blocks lifecycle operations explicitly.
3. Add CLI adapter registry resolution for `aws` and `cloudflare` while keeping
   AWS as the default during alpha.
4. Add `anvil-cloud plan --stage dev --adapter cloudflare --json` support before
   deploy support.
5. Add docs and tests showing unsupported features are review-gated rather than
   ignored.

### Phase 2: Worker runtime bridge and bundling

1. Add a generated Cloudflare Worker entrypoint that converts Worker `Request`
   events into `RuntimeRequest` values and converts `RuntimeResponse` back into
   Web `Response` values.
2. Ensure the runtime path does not rely on Node-only APIs in the Worker target.
3. Extend builder targets to produce a Worker-compatible server bundle when the
   Cloudflare adapter is selected.
4. Install the outbound fetch allow-list guard in the Worker environment.
5. Add tests for:
   - `POST /_anvil/query/:name`;
   - `POST /_anvil/mutation/:name`;
   - `/api/*` endpoint routing;
   - CORS preflight;
   - binary/body preservation;
   - stable request ids and structured log fields.

### Phase 3: Cloudflare resource synthesis

1. Decide the engine boundary. Prefer direct Cloudflare API calls or Wrangler
   configuration generation at first; do not expose Wrangler or Terraform to
   Cell authors.
2. Synthesize adapter-owned resources:
   - Worker script and route;
   - Pages project or static asset upload target;
   - D1 database and migrations for supported tables;
   - R2 bucket/prefixes for files;
   - KV/D1/R2 deployment metadata;
   - Worker vars and secret binding names;
   - optional Queues and Cron Triggers after core HTTP is stable.
3. Emit Cloudflare mappings only under verbose/debug adapter metadata.
4. Keep human and JSON plan output Anvil-first: runtime, HTTP ingress,
   client-assets, database, files, environment, logs, jobs, workflows.

### Phase 4: Runtime host adapters

1. Implement Cloudflare-backed host adapters:
   - D1 database adapter;
   - R2 file adapter;
   - Worker env/secrets adapter;
   - structured log adapter;
   - queue adapter when Queues support lands;
   - workflow adapter when the workflow backing is selected.
2. Use capability checks before provider calls so missing declarations fail as
   Anvil runtime errors, not Cloudflare API errors.
3. Add integration-style tests with mocked bindings first, then optional smoke
   tests against a real Cloudflare account.

### Phase 5: Deploy, remove, inspect, and logs

1. Implement `deploy` with artifact upload, Worker publication, binding setup,
   and metadata write. Use `wrangler deploy --temporary` for explicitly selected
   first-run previews and normal OAuth/API-token auth for permanent accounts and
   CI.
2. Implement `remove` with deterministic cleanup and review output.
3. Implement `inspect --adapter cloudflare` from adapter metadata without
   requiring direct dashboard access.
4. Implement `logs --adapter cloudflare` using the best available Cloudflare log
   source for preview environments.
5. Return stable error classes and error codes for account, token, API, quota,
   and propagation failures.
6. Parse temporary-account URL/expiry output into a secret-bearing handoff
   object, redact it from normal JSON/log surfaces, and verify the deployed URL
   before presenting the one-time claim action to the intended user.

### Phase 6: Hardening and feature expansion

1. Add Cron Trigger support for scheduled jobs.
2. Add Queue support for queued jobs and dead-letter policy.
3. Decide workflow backing: Cloudflare Workflows when it is mature enough for
   the Anvil workflow contract, otherwise Durable Objects plus D1/KV state.
4. Evaluate Workers AI as an optional provider-backed inference capability.
5. Revisit public file serving and custom domain support.
6. Promote the adapter only after conformance, docs, smoke tests, and rollback
   behaviour match AWS quality.

## Prompt and skill support for custom adapters

Anvil can make third-party adapters safer by shipping prompts and Codex-style
skills that guide contributors through the provider-neutral contract instead of
starting from provider SDK examples.

### Adapter author prompt pack

Provide versioned prompts under a docs or templates directory, for example
`docs/prompts/adapters/`, with focused tasks:

1. **Evaluate a provider mapping** — asks the agent to map Anvil concepts to a
   provider, identify unsupported features, and write review gates.
2. **Create a plan-only adapter** — asks the agent to implement `plan` and
   conformance tests before any deploy code.
3. **Create a runtime bridge** — asks the agent to translate provider events to
   `RuntimeRequest` and responses back to provider responses.
4. **Create host adapters** — asks the agent to implement database, files, env,
   logs, jobs, and workflow adapters behind runtime interfaces.
5. **Add CLI registry support** — asks the agent to register an adapter without
   hard-coding provider assumptions into command handlers.
6. **Run conformance and portability checks** — asks the agent to run shared
   adapter conformance, import policy, typecheck, and targeted tests.

Each prompt should require the agent to cite the relevant manifest, runtime,
builder, CLI, and adapter files it changed.

### `adapter-author` skill

A first-party skill can encode the safe workflow:

1. Read the root and project `AGENTS.md` files, `PATCH.md`, the alpha spec,
   deployment adapter architecture, runtime architecture, and the current AWS
   adapter docs.
2. Confirm the adapter is provider-owned and must not change Cell authoring.
3. Start with a plan-only adapter and conformance tests.
4. Add provider resource synthesis only after plan output is stable.
5. Add deploy/remove only after runtime bridge and host adapter tests pass.
6. Emit unsupported-feature diagnostics for gaps.
7. Never add provider SDK imports to Cell examples, runtime DSL, client SDK, or
   provider-neutral graph types.

The skill should include checklists for common adapter mistakes:

- leaking provider nouns into Cell manifests;
- adding direct provider SDK usage to user code;
- skipping JSON output tests;
- relying on live cloud state during `plan`;
- hiding cost or cleanup guidance;
- treating unsupported features as no-ops;
- changing AWS behaviour while adding a new adapter.

### Adapter template

After the shared contract is extracted, add a scaffold command or template such
as `packages/adapter-template` containing:

```txt
src/index.ts              # adapter class and public exports
src/plan.ts               # Anvil-first plan and review metadata
src/synthesize.ts         # provider resource mapping
src/runtime-bridge.ts     # provider event <-> RuntimeRequest bridge
src/host.ts               # runtime host capability adapters
test/plan.test.ts         # conformance and review metadata tests
test/runtime-bridge.test.ts
README.md                 # provider mapping and non-goals
```

This gives contributors a bounded extension point and lets prompts/skills ask
for edits in known files rather than open-ended provider rewrites.

## Suggested first pull requests

1. **Shared deployment contract extraction.** Move adapter-neutral plan and
   conformance types out of the AWS package and update AWS to consume them.
2. **Adapter registry.** Replace CLI hard-coded AWS checks with a registry that
   initially contains only AWS.
3. **Cloudflare docs and package shell.** Add `@anvil-cloud/cloudflare` with a
   plan-only adapter and stable unsupported-feature diagnostics.
4. **Worker runtime bridge.** Add tests for Worker request/response translation
   before deployment code.
5. **Cloudflare deploy smoke path.** Add opt-in smoke tests requiring explicit
   Cloudflare credentials and never run them by default in local CI.
