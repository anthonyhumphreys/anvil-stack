# Anvil Cloud as an optional agent sandbox provider

## Decision

Yes—this is feasible and strategically strong.

Anvil Desktop should remain local-first. Anvil Cloud becomes an optional execution control plane that can lease an isolated sandbox for:

- an entire Outcome Room;
- one expensive or risky turn;
- a dynamically spawned specialist subagent;
- later, an explicitly authorised Watchtower reaction.

Desktop should never call AWS, Vercel, or Cloudflare SDKs directly. It should speak one Anvil execution protocol; Anvil Cloud selects and controls the provider.

## Intended experience

The composer gains a compact execution target:

- **Local** — default, current behaviour.
- **Cloud · Auto** — choose by declared capabilities and workspace policy.
- **Cloud · AWS**
- **Cloud · Vercel**
- **Cloud · Cloudflare**

A workspace may define a default, but every Outcome Room and turn can override it. Nothing cloud-related appears unless Cloud features and at least one provider connection are enabled.

Dynamic delegation uses an Anvil tool available to the coordinating agent:

- `cloud_agent.spawn`
- `cloud_agent.send`
- `cloud_agent.wait`
- `cloud_agent.cancel`

Remote agents emit the same lifecycle events as local subagents, so the new Work topology can show provider, status, task, cost envelope, expiry, and result without creating another monitoring surface.

## Existing foundation

Anvil Cloud already owns the right lifecycle abstraction in [agent-sandbox.ts](/Users/anthonyhumphreys/Code/anvil/anvil-cloud/packages/runtime/src/agent-sandbox.ts:1): start, inspect, suspend, resume, terminate, and short-lived authentication.

AWS already implements that contract through [AwsLambdaMicroVmSandboxProvider](/Users/anthonyhumphreys/Code/anvil/anvil-cloud/packages/aws/src/sandbox.ts:45). AWS documents Firecracker isolation, session-specific state, lifecycle control, and an eight-hour ceiling, making this the shortest path to a real vertical slice. [AWS Lambda MicroVM documentation](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html)

The missing layer is not basic sandbox provisioning. It is the execution control plane:

- source snapshot ingestion;
- streamed agent protocol;
- approval and steering transport;
- credential brokering;
- durable event cursors;
- artifact and patch collection;
- cost and expiry enforcement;
- remote inspection and cleanup evidence.

The present [ControlPlaneApi](/Users/anthonyhumphreys/Code/anvil/anvil-cloud/packages/control-plane/src/index.ts:27) is primarily a read-oriented local runtime API. It needs a hosted execution contract rather than provider-specific methods.

## Proposed architecture

1. **Desktop execution client**
   - Creates a capability envelope.
   - Uploads a clean source snapshot plus an explicitly selected working-tree patch.
   - Streams normalised events.
   - Relays approvals, user input, steering, and cancellation.
   - Receives evidence, artifacts, and a patch bundle.

2. **Anvil execution control plane**
   - Authenticates the user and resolves workspace provider policy.
   - Creates an idempotent execution lease.
   - Selects the sandbox provider.
   - Stores the durable event log and heartbeat.
   - Brokers credentials without exposing secret values.
   - Reaps expired or orphaned sandboxes.
   - Produces a cleanup receipt.

3. **Provider adapter**
   - Implements sandbox lifecycle and sandbox I/O.
   - Uploads/downloads workspace data.
   - Executes and streams commands.
   - Applies network, resource, and TTL policy.
   - Captures snapshots, files, and filesystem diffs.

4. **Agent worker**
   - Runs inside the sandbox.
   - Starts the supported agent protocol.
   - Uses `/workspace` as its only writable checkout.
   - Emits typed Codex-compatible events.
   - Never receives Desktop OAuth files or unrestricted cloud credentials.

## Execution protocol

Each lease needs these operations:

- `createExecution(capabilities, source, providerPreference)`
- `streamEvents(executionId, cursor)`
- `resolveApproval(executionId, requestId, decision)`
- `submitInput(executionId, requestId, values)`
- `steer(executionId, message)`
- `collectResult(executionId)`
- `suspend`, `resume`, and `terminate`

Important event types:

- execution and sandbox lifecycle;
- agent text, reasoning, tools, commands, and file edits;
- subagent creation and coordination;
- approval/input requests;
- artifact availability;
- patch readiness;
- usage, budget, heartbeat, expiry, and cleanup.

Events must be resumable by cursor so closing Desktop does not lose the audit trail.

## Source and result contract

Default source input:

- committed repository snapshot;
- current branch and commit SHA;
- optional explicitly reviewed working-tree patch;
- no ignored files, secret files, `.git` internals, or unrelated untracked files.

Default result:

- unified patch against the original commit;
- changed-file manifest;
- commands, tests, errors, and evidence;
- Canvas artifact bundle with repository/session storage intent;
- provider usage and cost estimate;
- sandbox termination receipt.

Remote patches land in a disposable local worktree first. They are never silently applied to the user’s checkout.

Parallel subagents receive independent writable clones from one immutable base snapshot. They return patches to the coordinator; they do not share a writable filesystem.

## Provider order

| Provider | Recommendation | Reason |
| --- | --- | --- |
| AWS Lambda MicroVM | First production slice | Anvil already implements the lifecycle adapter. Strong isolation and explicit network/lifecycle controls. |
| Vercel Sandbox | Second adapter | Excellent contract match: Firecracker environments, SDK command/file operations, snapshots, network policy, and credential brokering. No Anvil adapter exists yet. [Vercel Sandbox](https://vercel.com/docs/sandbox), [snapshot contract](https://vercel.com/docs/vercel-sandbox/concepts/snapshots) |
| Cloudflare Sandbox | Experimental third adapter | Cloudflare now provides isolated Linux containers, commands, files, services, outbound interception, and persistent storage options. This materially supersedes Anvil Cloud’s older “agent sandboxes unsupported” assumption. [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) |

For Cloudflare, target the recommended Sandbox 1.0 preview contract behind an experimental flag. Do not build new integration work on deprecated HTTP/WebSocket transports, default sessions, or old stream helpers. [Cloudflare migration guidance](https://developers.cloudflare.com/sandbox/guides/2026-deprecation/)

## Delivery phases

### Phase 0 — contracts and conformance

- Add an execution-control-plane contract.
- Add sandbox I/O and event-stream conformance suites.
- Define capability, source, result, usage, and cleanup schemas.
- Decide the supported remote model-auth mechanism.
- Explicitly prohibit copying local Codex OAuth state into a sandbox.

Exit gate: a fake provider can run a deterministic turn, pause for approval, resume from an event cursor, return a patch, and prove teardown.

### Phase 1 — AWS read-only vertical slice

- Provision an AWS MicroVM from Desktop.
- Load a committed repository snapshot.
- Run a read-only coder session.
- Stream output, commands, tests, and evidence into the Outcome Room.
- Terminate automatically and retain a cleanup receipt.

Exit gate: one real repository inspection works end-to-end without transferring local credentials or granting repository writes.

### Phase 2 — writable AWS sessions

- Add disposable remote branches.
- Return signed patch and artifact bundles.
- Preview results locally before applying.
- Add TTL, quota, network allow-list, cancellation, and orphan reaping.

Exit gate: implementation plus tests returns a clean patch that can be reviewed and applied locally.

### Phase 3 — dynamic cloud subagents

- Expose the `cloud_agent.*` coordination tools.
- Route bounded specialist tasks to remote leases.
- Represent them in Work topology.
- Merge results as patches or handoff reports.
- Enforce per-outcome concurrency and spend limits.

Exit gate: one local coordinator can run two isolated remote specialists concurrently and reconcile their results without a shared writable checkout.

### Phase 4 — Vercel and Cloudflare adapters

- Add `@anvil-cloud/vercel`.
- Rework Cloudflare sandbox compatibility around its current Sandbox SDK.
- Run the same conformance suite for all providers.
- Add capability-based Auto routing rather than provider-name heuristics.

Exit gate: the same Desktop execution request can run on every supported provider with equivalent evidence and teardown semantics.

### Phase 5 — Watchtower integration

- Add remote execution as an explicit Watchtower action.
- Require per-listener provider, budget, TTL, and permission policy.
- Begin with read-only investigation events.
- Keep cloud writes, deployments, pushes, and external messages approval-gated.

## Security invariants

- Local execution remains the default.
- No production access is inferred from choosing a cloud provider.
- Provider and model credentials remain control-plane-side.
- Secrets are injected only at allowed egress targets.
- Every execution has a TTL, resource ceiling, and network policy.
- No cloud agent can push, deploy, merge, message, or mutate external systems without an explicit capability and approval.
- Every sandbox produces an inspectable event log and termination receipt.
- A failed Watchtower dispatch must never change the originating workflow result.
- Provider fallback occurs only before execution begins, never midway through a writable session.

## Primary unresolved product decision

Remote agent authentication must be solved before Phase 1 is called production-ready. The safe initial contract is an explicitly configured API/service credential held by the control plane. Uploading a developer’s local `~/.codex` authentication state is out of bounds.

## Recommended first issue

Build the fake-provider conformance harness and AWS read-only vertical slice together. The demo should be:

> From an Outcome Room, select “Cloud · AWS”, inspect the current committed repository, stream live evidence into Work topology, return a review artifact, and show a verified teardown receipt.

That proves the differentiating loop before investing in multi-provider UI or autonomous cloud writes.