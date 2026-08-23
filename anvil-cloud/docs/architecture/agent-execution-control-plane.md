# Agent execution control plane

## Purpose

The agent execution control plane turns an Agent Sandbox lifecycle into a
resumable, inspectable unit of work. It is provider-neutral: Desktop, CLI, and
hosted callers create one execution request, while an execution provider owns
the sandbox and its private transport.

This is platform infrastructure, not a Cell authoring primitive. Cell authors
continue to declare agents, capabilities, approvals, and sandbox requirements
through `defineAgent`.

## Implemented boundary

`@anvil-cloud/runtime` owns the JSON-friendly execution contract:

- immutable git or opaque snapshot source references;
- read-only and read-write modes;
- provider preferences and capability-derived network policy;
- TTL, event, and estimated-cost ceilings;
- control-plane credential names or execution-scoped Codex/Cursor subscription
  login intent, never credential values or local OAuth caches;
- cursor-based lifecycle, message, tool, command, file, approval, input,
  artifact, patch, usage, heartbeat, expiry, and cleanup events;
- evidence, test, patch, artifact, usage, and error results;
- the `AgentExecutionProvider` lifecycle and I/O interface.

`@anvil-cloud/control-plane` implements:

- idempotent leases keyed by `clientToken`;
- exact event sequencing and provider-event de-duplication;
- resumable reads from a durable cursor;
- approval decisions, structured input, steering, suspend, resume, collect,
  terminate, and TTL reaping;
- event and estimated-cost budget enforcement;
- in-memory and atomic JSON-file lease stores;
- content-addressed in-memory and file snapshot stores with size ceilings;
- short-lived, execution-bound, single-use source grants whose raw bearer is
  never persisted;
- cleanup receipts that distinguish requested from verified teardown;
- an authenticated and workspace-authorised `/v1/executions` HTTP router plus
  execution and source clients;
- a loopback-safe Node HTTP adapter for running the alpha service;
- an authenticated worker router that verifies snapshot bytes before handing
  them to a provider-neutral worker driver;
- a deterministic fake provider and conformance suite.

Run the conformance loop with:

```sh
anvil-cloud executions conformance --json
```

The check starts a deterministic writable execution, pauses for approval,
resumes from an event cursor, returns a patch, and verifies sandbox teardown.

## Request shape

```ts
const request: AgentExecutionRequest = {
  schemaVersion: "0.1",
  clientToken: "desktop-thread-42-turn-8",
  workspace: "workspace-42",
  cell: "repository-review",
  environment: "preview",
  task: "Inspect the repository and report failing tests.",
  agent: reviewerManifest,
  source: {
    kind: "git",
    repository: "https://github.com/example/repository.git",
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "main",
    selection: {
      includesWorkingTreePatch: false,
      excluded: [
        "git-metadata",
        "ignored-files",
        "secret-files",
        "unrelated-untracked-files",
      ],
    },
  },
  providerPreference: { kind: "provider", provider: "aws-lambda-microvm" },
  policy: {
    mode: "read-only",
    ttlSeconds: 3600,
    network: reviewerManifest.capabilities.network,
    maxEvents: 10000,
    maxCostUsd: 2,
    requireApprovalForExternalActions: true,
  },
  modelAuth: {
    kind: "provider-subscription",
    provider: "codex",
    persistence: "sandbox-session",
  },
};
```

Git source URLs must be credential-free HTTPS URLs pinned to a hexadecimal
commit. Snapshot sources use opaque ids and SHA-256 digests; the public lease
does not persist pre-signed download URLs. Every source records the excluded
content classes so ignored files, secret files, `.git` internals, and unrelated
untracked files cannot disappear behind an ambiguous "upload workspace" flag.

`provider-subscription` is the no-model-API-key path. A compatible worker
starts an interactive provider login inside the ephemeral sandbox and removes
the cached session during cleanup. The lease records only `codex` or `cursor`
plus `sandbox-session`; it never contains a token or a copy of local Codex or
Cursor auth state. Codex documents device-code login for headless environments.
Cursor documents browser subscription login for its CLI, but not an equivalent
headless delegated-login contract, so workers must advertise each subscription
provider independently instead of assuming parity.

## HTTP contract

The framework-neutral handler and client use these routes:

```txt
POST /v1/executions
GET  /v1/executions
GET  /v1/executions/:id
GET  /v1/executions/:id/events?cursor=<cursor>&limit=<n>
POST /v1/executions/:id/approval
POST /v1/executions/:id/input
POST /v1/executions/:id/steer
POST /v1/executions/:id/suspend
POST /v1/executions/:id/resume
POST /v1/executions/:id/collect
POST /v1/executions/:id/terminate
POST /v1/executions/reap
POST /v1/source-snapshots
GET  /v1/source-grants/:grantId
```

The handler requires an authentication and authorisation policy. It returns
`401` when no principal resolves, checks the workspace for create, snapshot,
list, read, and control actions, and returns `403` on denial. The one exception
is the worker-only source-grant route: it accepts the one-time grant bearer plus
the bound execution id, consumes the grant once, and never treats that bearer
as a user session.

The Node adapter defaults to `127.0.0.1:4764`, bounds JSON request bodies, sets
`no-store`, and supports header authentication before a large request body is
buffered. The CLI enables that early rejection while leaving the one-time GET
grant route to its separate execution-bound bearer. Run the durable alpha
service with:

```sh
export ANVIL_EXECUTION_CONTROL_TOKEN="$(openssl rand -base64 32)"
anvil-cloud executions serve --provider fake --json
anvil-cloud executions list --json
anvil-cloud executions snapshot \
  --workspace workspace-42 \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --archive repository.tar \
  --json
```

`--provider aws` additionally requires an HTTPS `--public-url`, the configured
AWS sandbox image, and a compatible deployed worker. Remote public binds are
rejected unless deliberately enabled.

## AWS read-only transport

`AwsLambdaMicroVmSandboxProvider` now implements the execution-provider
contract for read-only requests. After the existing Lambda MicroVM lifecycle
starts a session, it uses a short-lived MicroVM auth token for every request to
the sandbox worker:

```txt
POST /_anvil/execution/workspace
POST /_anvil/execution/runs
GET  /_anvil/execution/runs/:runId/events
POST /_anvil/execution/runs/:runId/approvals/:requestId
POST /_anvil/execution/runs/:runId/input/:requestId
POST /_anvil/execution/runs/:runId/steer
GET  /_anvil/execution/runs/:runId/result
```

The startup payload advertises protocol `0.1` and resumable events. Execution
startup then carries either control-plane credential-name auth or provider
subscription intent. Auth tokens are used only for the request and are not
written into execution leases or events.

The framework-neutral worker handler implements the same routes. For snapshot
sources it redeems the grant over HTTPS, checks canonical base64, byte length,
and SHA-256 for both archive and optional patch, then passes only verified bytes
to the worker driver. Grant credentials are removed at that boundary.

This is an executable adapter and worker boundary with deterministic transport
coverage, not a claim that the hosted service and worker image are deployed.
`ANVIL_AWS_AGENT_SUBSCRIPTION_PROVIDERS=codex,cursor` advertises only login
flows the selected image actually implements; without it, AWS rejects
subscription-auth requests before starting a sandbox.

## Desktop workbench

Anvil Desktop's existing optional Cloud surface now has a remote execution
panel. It can save/test a control-plane connection, upload an immutable archive
of the selected repository's committed files, start a read-only execution,
follow durable events, resolve approvals, steer, and terminate. The bearer is
encrypted with Electron `safeStorage` in the main-process SQLite boundary. The
renderer sees endpoint/configured state but never reads the stored token or
archive bytes.

The agent runtime selector defaults to **my Codex subscription**. Cursor
subscription and cloud-managed credential modes remain explicit choices. A
dirty working tree is not uploaded: Desktop reports that local changes were
excluded and pins the execution to `HEAD`.

## Security invariants

- Local execution remains the default outside this package.
- Local Codex/Cursor OAuth caches have no representation in the protocol.
- Subscription login persists for the sandbox session only and requires an
  explicitly advertised worker capability.
- Hosted user requests fail closed and are workspace-authorised.
- Snapshot grants are short-lived, execution-bound, single-use, and stored as
  token hashes.
- The execution network policy must match the compiled agent manifest.
- Read-write mode requires the agent's `filesystem: "read-write"` capability.
- AWS rejects read-write requests and working-tree patches in the current
  implementation.
- Provider fallback happens only while selecting a provider, before a sandbox
  starts.
- TTL, event count, and estimated-cost ceilings fail the lease and request
  sandbox cleanup.
- Results reference artifacts by id and digest rather than embedding arbitrary
  files in control-plane JSON.
- Collection and cancellation produce a cleanup receipt; only an inspected
  terminal sandbox is marked `verified`.

## Remaining production work

- a compatible AWS worker image and real-account smoke test;
- concrete Codex device-login and Cursor interactive-login worker drivers plus
  expiry/revocation smoke tests;
- provider credential brokering at the network boundary for the optional
  cloud-managed mode;
- durable hosted storage with concurrency control rather than the alpha JSON
  file store;
- artifact upload, signed patch bundles, and local disposable-worktree review;
- Work topology event projection and chat-level remote target selection;
- writable AWS execution after patch signing, external-action approvals, and
  orphan cleanup evidence are proven;
- dynamic remote subagent tools;
- later provider adapters through the same conformance contract.
