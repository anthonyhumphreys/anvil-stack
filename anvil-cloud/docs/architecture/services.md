# Service Architecture

## Purpose

Services are the long-running background primitive in Anvil Cloud. A service is a named handler that runs continuously for the lifetime of an app: pollers, queue consumers, socket listeners, schedulers, or any loop that should be supervised rather than invoked per request.

Services complement the other handler kinds: a job is a single background invocation, a workflow is a durable multi-step run, and a service is a process-shaped handler that the platform starts, watches, restarts on failure, and stops cleanly.

## Contract

### DSL

```ts
import { app, service } from "@anvil-cloud/runtime";

export default app({
  capabilities: { services: true },
  services: {
    heartbeat: service({
      restart: "on-failure", // "always" | "on-failure" | "never" (default "on-failure")
      maxRestarts: 5, // default 5
      handler: async (ctx, controls) => {
        while (!controls.stopping()) {
          await ctx.log.info("tick");
          await sleep(1000, controls.signal);
        }
      },
    }),
  },
});
```

- `controls` is `{ signal: AbortSignal, stopping: () => boolean }`. The platform aborts the signal when the service must stop; well-behaved handlers observe it and return promptly.
- Services run in the background with no request auth context: `ctx.auth.identity` is always `null` inside service handlers.
- Declaring any service requires `capabilities.services` (enforced by Anvil Guard).
- Services cannot be invoked as runtime requests; `handleRuntimeRequest` rejects `kind: "service"` with a validation error. Lifecycle is owned by the supervisor.

### Supervisor

`ServiceSupervisor` in `@anvil-cloud/runtime` is the provider-neutral execution core, analogous to `executeWorkflowRun` for workflows. It owns:

- **start(name)** — runs the handler with a fresh `AbortController` and a runtime context.
- **Restart policy** — on handler failure, `on-failure` and `always` policies restart with capped exponential backoff (default base 100ms, cap 5s) up to `maxRestarts`; exhausting the cap records `failed`. A clean return restarts only under `always`, and the cap still applies. `never` records `failed` on the first error.
- **stop(name)** — aborts the signal and waits (bounded, default 5s) for the handler to exit; a handler that ignores the signal is recorded as stopped and a warning is logged.
- **status()** — `Array<ServiceStatus>` where `ServiceStatus = { name, state: "running" | "stopped" | "failed" | "restarting", restarts, startedAt?, lastError? }`.
- **Lifecycle logging** — every transition is written through `host.logs` with `kind: "service"`, so service logs flow through the same log adapter as request handlers.

Hosts do not gain a service adapter member: supervision is runtime-level, not a `RuntimeHost` capability, because services consume host capabilities rather than provide one.

### Manifest

`AppInspection` and the Cell manifest list services as `{ name, restart, maxRestarts }` so the CLI, inspector, and deployment adapters can see declared services without executing handlers.

## Local execution (implemented)

Anvil Local starts every declared service when the dev server boots and stops them all (signal abort plus bounded wait) on `close()`. After every state transition the supervisor's status snapshot is persisted to `.anvil/local/services.json`. The snapshot is informational; live state is in-process and served over HTTP.

Local HTTP routes:

- `GET /_anvil/services` returns `{ ok, services: ServiceStatus[] }`.
- `POST /_anvil/services/<name>/stop` and `POST /_anvil/services/<name>/start` control an individual service and return `{ ok, service }`.

CLI: `anvil-cloud services list [--json]` reads the snapshot file and notes that live state requires the dev server routes.

## Why Lambda is unsuitable

The AWS preview adapter executes handlers on Lambda, which is invocation-shaped: bounded execution time (15 minutes maximum), no supervised always-on processes, frozen execution between invocations, and per-invocation billing that is hostile to idle loops. A service is the opposite shape — an always-on, supervised process. Emulating one by chaining invocations would re-implement a scheduler badly and break the `AbortSignal` stop semantics. Services therefore have no Lambda execution path; deploying a Cell with services to the AWS preview adapter is unsupported until the container-backed adapter below exists.

## ECS/Fargate mapping (design only, not implemented)

The planned mapping runs services on ECS with Fargate, synthesized entirely by the deployment adapter from the manifest's `services` list:

- **One task definition per service**, named `anvil-<cell>-<environment>-<service>`, wrapping the same server bundle with an entrypoint that runs `ServiceSupervisor.start(<name>)` for exactly one service. Cell code never authors task definitions, images, or cluster configuration.
- **One ECS service per Anvil service** with `desiredCount: 1`. The ECS scheduler provides the outer restart loop; the in-process supervisor provides fast restarts with backoff, and `maxRestarts` exhaustion exits the task so ECS-level policy (deployment circuit breaker, alarms) takes over. `restart: "never"` maps to a task that exits without replacement beyond the scheduler minimum.
- **Stop semantics** map to ECS task stop: SIGTERM triggers the supervisor's `stopAll()` (abort + bounded wait) within the `stopTimeout` grace period before SIGKILL.
- **Logs** flow to CloudWatch Logs through the existing log adapter shape (`kind: "service"`), under the same log group conventions as Lambda handlers, so `anvil-cloud logs --app` works unchanged.
- **Status** is persisted to the deployment metadata table on transitions, mirroring the local snapshot file, so `anvil-cloud services list --app <cell>` can read remote state through the existing remote reader.
- **IAM and capabilities.** Declaring `capabilities.services` adds least-privilege grants: the deploy role may register task definitions and create/update ECS services; the task role receives exactly the grants implied by the Cell's other declared capabilities (database, files, events), identical to the Lambda role derivation.

This keeps the service contract provider-neutral: Cell code, the manifest shape, `ServiceStatus`, and CLI commands are identical across local and future container-backed execution. ECS remains invisible to Cell authors — it is an adapter implementation detail, consistent with the "no provider primitives in Cell code" constraint.

## Non-goals (alpha)

- Container, Kubernetes, or Docker authoring in Cell code.
- Horizontal scaling (`desiredCount > 1`), leader election, or distributed coordination.
- Cloud execution of services; only the local supervised runner is implemented.
- Health-check probes beyond handler exit/failure observation.
