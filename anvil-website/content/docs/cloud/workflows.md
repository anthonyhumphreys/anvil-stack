---
title: Workflows
navTitle: Workflows
description: Durable multi-step background workflows in Anvil Cells, with per-step retries, timeouts, and resumable run state.
product: Anvil Cloud
section: Architecture
order: 119
---

# Workflows

A workflow is a named, ordered list of typed steps that runs in the background. Where a job is a single handler invocation, a workflow chains handlers with per-step retries, per-step timeouts, and durable run state that survives a crash mid-run.

## Definition

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

Each step handler receives the shared runtime `ctx` and a `state` object:

- `state.input` is the input the run was started with.
- `state.steps` holds the results of prior steps, keyed by step name.

Workflows run in the background with no request auth context. `ctx.auth.identity` is always `null` inside step handlers; use the run input to carry user identifiers when a workflow acts on behalf of a user.

## Capability requirement

Declaring a workflow, or calling `ctx.workflows.start` from a handler, requires `capabilities.workflows`. Anvil Guard reports `CAPABILITY_NOT_DECLARED` during `anvil-cloud check` and `anvil-cloud build` if it is missing.

## Durability semantics

The executor persists run state after every step transition: when a step starts, on each attempt, when it completes or fails, and when the run finishes. Locally that state lives in `.anvil/local/workflows.json`.

- A step runs up to `1 + retries` attempts, with a short backoff between attempts.
- `timeoutMs` bounds each attempt; a timed-out attempt counts as a failure.
- When a step exhausts its attempts, the step and the run are marked `failed` and later steps do not run.
- If the local runtime crashes mid-run, the run is left in `running` state on disk. When the local server starts again, it resumes the run: completed steps are skipped and their persisted results are threaded back into `state.steps`.

## Starting workflows

From a handler:

```ts
mutations: {
  kickOff: mutation({
    handler: async (ctx) => ctx.workflows.start("syncNotes", { full: true }),
  }),
},
```

Over the local runtime HTTP surface:

```txt
POST /_anvil/workflows/run/<name>   body: { "input": ... }  ->  { "ok": true, "runId": "run_..." }
GET  /_anvil/workflows              ->  { "ok": true, "runs": [...] }
GET  /_anvil/workflows/<runId>      ->  { "ok": true, "run": {...} }
```

The run starts asynchronously; poll the detail route for status.

## CLI

```bash
anvil-cloud workflows list --json
anvil-cloud workflows show <runId> --json
anvil-cloud workflows run syncNotes --input '{"full":true}' --json
```

`anvil-cloud workflows run` builds the Cell, executes the workflow against local state without needing a running dev server, waits for completion, and prints the final run. The exit code is non-zero when the run fails.

A run record looks like:

```json
{
  "runId": "run_5f3c…",
  "workflow": "syncNotes",
  "status": "completed",
  "input": { "full": true },
  "steps": [
    { "name": "fetch", "status": "completed", "attempts": 1, "result": { "notes": { "full": true } } },
    { "name": "store", "status": "completed", "attempts": 1, "result": { "stored": { "notes": { "full": true } } } }
  ],
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:01.000Z"
}
```

## Current limits

Workflows execute end-to-end on the local runtime. AWS preview also maps
declared workflows to Step Functions state machines whose task states invoke the
shared runtime Lambda.

The AWS runtime host can start configured Step Functions executions for
`ctx.workflows.start` when `ANVIL_WORKFLOW_STATE_MACHINES` maps workflow names
to state machine ARNs. The generated CloudFormation template now writes that
mapping into the Lambda environment for workflow-bearing manifests.

AWS preview deployment plans include a `workflow-preview-review` approval gate
and Step Functions cost-driver hints. Remote workflow run inspection is not yet
mirrored through `anvil-cloud workflows list/show --app`.

Steps are a linear sequence: no branching, no parallelism, and no cross-Cell workflows in alpha.
