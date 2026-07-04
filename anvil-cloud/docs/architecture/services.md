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

The AWS preview adapter executes request, job, and workflow handlers on Lambda,
which is invocation-shaped: bounded execution time (15 minutes maximum), no
supervised always-on processes, frozen execution between invocations, and
per-invocation billing that is hostile to idle loops. A service is the opposite
shape: an always-on, supervised process. Emulating one by chaining invocations
would re-implement a scheduler badly and break the `AbortSignal` stop
semantics. Services therefore use the ECS/Fargate preview resource path below
instead of Lambda.

## ECS/Fargate mapping (preview implemented)

AWS preview synthesizes ECS/Fargate resources entirely from the manifest's
`services` list:

- **One ECS cluster per preview Cell** when services are declared.
- **One Fargate task definition and ECS service per Anvil service** with
  `desiredCount: 1`.
- **Adapter-owned parameters.** The template adds `ServiceSubnetIds` for the
  subnets used by preview tasks. Cell authors do not write VPC, subnet, task,
  image, or cluster definitions.
- **Logs.** Service tasks write to a Cell-owned CloudWatch log group.
- **Review gate.** Deployment plans add `service-preview-review` so subnet and
  cleanup expectations are reviewed before provisioning.

The current preview task definition is an adapter-owned scaffold for service
resource provisioning and operational review. Running the exact Cell service
handler inside the Fargate task is the next hardening step. That limitation is
intentional in the docs because pretending the adapter is done would be
decorative infrastructure, which is the least useful kind.

This keeps the service contract provider-neutral: Cell code, the manifest shape, `ServiceStatus`, and CLI commands are identical across local and future container-backed execution. ECS remains invisible to Cell authors — it is an adapter implementation detail, consistent with the "no provider primitives in Cell code" constraint.

## Non-goals (alpha)

- Container, Kubernetes, or Docker authoring in Cell code.
- Horizontal scaling (`desiredCount > 1`), leader election, or distributed coordination.
- Production-grade cloud execution of service handlers; AWS preview currently
  provisions adapter-owned Fargate service resources for review and hardening.
- Health-check probes beyond handler exit/failure observation.
