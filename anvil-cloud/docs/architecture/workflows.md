# Workflow Architecture

## Purpose

Workflows are the durable, multi-step background primitive in Anvil Cloud. A workflow is a named, ordered list of typed steps. Each step receives the shared runtime context and a state object containing the original input and the results of prior steps. Run state is persisted after every step transition so an interrupted run can be resumed without re-executing completed steps.

Workflows complement jobs: a job is a single background handler invocation; a workflow is a sequence of handlers with per-step retries, per-step timeouts, and durable run state.

## Contract

### DSL

```ts
import { app, workflow } from "@anvil-cloud/runtime";

export default app({
  capabilities: { workflows: true },
  workflows: {
    syncNotes: workflow({
      steps: [
        {
          name: "fetch",
          retries: 2,
          timeoutMs: 10_000,
          handler: async (ctx, state) => ({ notes: state.input }),
        },
        {
          name: "store",
          handler: async (ctx, state) => ({ stored: state.steps.fetch }),
        },
      ],
    }),
  },
});
```

- `state` is `{ input: unknown, steps: Record<string, unknown> }`; `steps` holds prior step results keyed by step name.
- Steps execute sequentially. A step runs up to `1 + retries` attempts. `timeoutMs` bounds each attempt.
- Workflows run in the background with no request auth context: `ctx.auth.identity` is always `null` inside step handlers.
- Declaring any workflow, or using `ctx.workflows`, requires `capabilities.workflows` (enforced by Anvil Guard).

### Runtime host adapter

```ts
interface WorkflowAdapter {
  start(name: string, input: unknown): Promise<{ runId: string }>;
  getRun?(runId: string): Promise<WorkflowRun | null>;
  listRuns?(): Promise<WorkflowRun[]>;
}
```

`WorkflowRun` records `runId`, `workflow`, `status` (`running | completed | failed`), `input`, per-step state (`pending | running | completed | failed`, attempt count, result or error, timestamps), `createdAt`, and `updatedAt`.

Handlers can start runs through `ctx.workflows.start(name, input)`. The shared executor in `@anvil-cloud/runtime` (`executeWorkflowRun`) owns step sequencing, retries, timeouts, and state threading; adapters own persistence and scheduling.

The executor uses Effect internally for step attempts, retry policy, and
timeouts. This is an implementation detail of the Anvil Runtime: Cell workflow
handlers still use ordinary async TypeScript, and adapters still receive the
same `WorkflowRun` persistence contract.

### Manifest

`AppInspection` and the Cell manifest list workflows as `{ name, steps: string[] }` so the CLI, inspector, and deployment adapters can see workflow topology without executing handlers.

## Local execution (implemented)

Anvil Local persists runs to `.anvil/local/workflows.json`. The executor awaits a persistence callback after every step transition, so a crash mid-run leaves resumable state on disk. When the local runtime server starts, any run still marked `running` is resumed; completed steps are skipped and their persisted results are fed back into `state.steps`.

Local HTTP routes:

- `POST /_anvil/workflows/run/<name>` with `{ "input": ... }` starts a run asynchronously and returns `{ ok, runId }`.
- `GET /_anvil/workflows` lists runs.
- `GET /_anvil/workflows/<runId>` returns run detail.

CLI: `anvil workflows list`, `anvil workflows show <runId>`, and `anvil workflows run <name> [--input '<json>']`, all with `--json`.

## AWS mapping (partially implemented)

The AWS package maps workflow manifests onto AWS Step Functions, but AWS
preview deploys still reject workflow-bearing Cells before provisioning until
the full remote run-state and inspection path is verified. The implemented
pieces are:

- **One state machine per workflow.** The deployment adapter synthesizes a Step Functions state machine for each entry in the manifest's `workflows` list, named `anvil-<cell>-<environment>-<workflow>`. The state machine definition is derived from the manifest topology at deploy time, so Cell code never authors ASL.
- **Task states invoke the shared runtime Lambda.** Each step becomes an ASL `Task` state that invokes the existing per-Cell Lambda with a payload identifying the workflow, step, run id, and accumulated state. The Lambda routes the invocation to the matching step handler through the shared runtime, exactly as it routes HTTP and SQS events today.
- **Starts use configured state machines.** The CloudFormation template writes
  `ANVIL_WORKFLOW_STATE_MACHINES` into the Lambda environment, mapping workflow
  names to state machine ARNs. The AWS runtime host uses that mapping for
  `ctx.workflows.start`.
- **Retries map to ASL `Retry`.** A step's `retries` becomes a `Retry` policy on its Task state (`MaxAttempts: retries`, small `IntervalSeconds` with backoff). The executor's attempt accounting is reported back into run state from the Lambda.
- **Timeouts map to `TimeoutSeconds`.** A step's `timeoutMs` becomes the Task state's `TimeoutSeconds` (rounded up), so the platform enforces the bound even if the handler hangs.
- **Failure semantics.** When a Task state exhausts its retries, a `Catch` route marks the run `failed` in the metadata table and ends the execution; subsequent steps never run, matching local semantics.
- **IAM.** Declaring `capabilities.workflows` adds least-privilege grants: the deploy role may create/update the state machines, and the state machine role may invoke the Cell Lambda.

Remaining AWS workflow work:

- persist the same `WorkflowRun` shape into deployment metadata after every
  remote step transition;
- add remote `anvil workflows list/show --app <cell>` support through the
  existing remote reader, mirroring `anvil logs --app`;
- verify live account provisioning, execution, failure paths, and cleanup before
  removing the preview support gate.

This design keeps the workflow contract provider-neutral: Cell code, the manifest shape, run state shape, and CLI commands are identical across local and AWS execution.

## Non-goals (alpha)

- Parallel or branching steps. Steps are a linear sequence.
- Cross-Cell workflows.
- Workflow versioning and migration of in-flight runs.
- A hosted scheduler; local execution is in-process, AWS execution is designed but not implemented.
