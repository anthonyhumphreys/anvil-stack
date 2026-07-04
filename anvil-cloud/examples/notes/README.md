# Notes Cell Example

This is the canonical local-first Anvil Cell demo. It exercises:

- a `notes` table;
- authenticated `listNotes`, `createNote`, and `archiveNote` handlers;
- a public status query and `/api/health` endpoint;
- generated client metadata consumed by a React/Vite client;
- local auth, database, jobs, workflows, logs, and Lens inspection.

Build and check it from the workspace:

```bash
cd anvil-cloud/examples/notes
pnpm check
pnpm build
```

Or run the repeatable local smoke verifier from the `anvil-cloud` workspace:

```bash
pnpm verify:notes-golden-path
```

It starts `anvil-cloud dev` on ephemeral ports, creates a local user, mints a real
JWT, calls authenticated note mutation/query routes, checks inspect/logs, and
then runs the local `onboardUser` workflow through `workflows run/list/show`.
It also dumps the `notes` table as JSON to prove the authenticated mutation and
workflow-created row are both visible through local state inspection. After that
it runs `doctor --json` against the live runtime before confirming the AWS
preview workflow gate and destroy dry-run lifecycle. The verifier uses this
example's package scripts for `dev`, `check`, `build`, `inspect:local`,
`logs:local`, `deploy:preview:gate`, and
`destroy:preview:dry-run` so script drift breaks loudly. Very dignified.
`pnpm verify:notes-local` remains as a compatibility alias.

Run it locally:

```bash
pnpm dev -- --port 8787 --client-port 5173
```

In another terminal, create a local user and token:

```bash
node ../../packages/cli/dist/index.js auth add-user local_demo --email demo@example.test --roles admin --json
node ../../packages/cli/dist/index.js auth token local_demo --json
```

Paste the token into the client UI, or call the runtime directly:

```bash
TOKEN=$(node ../../packages/cli/dist/index.js auth token local_demo --json | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"input":{"title":"First note","body":"Created through Anvil Runtime."}}' \
  http://localhost:8787/_anvil/mutation/createNote
```

Useful inspection commands:

```bash
node ../../packages/cli/dist/index.js lens --json
pnpm inspect:local
pnpm logs:local
node ../../packages/cli/dist/index.js db dump notes --local --json
```

Preview lifecycle checks:

```bash
pnpm deploy:preview:gate
pnpm destroy:preview:dry-run
```

This demo intentionally includes a workflow, so it is not currently the AWS
preview smoke Cell. AWS has Step Functions synthesis and runtime bridge pieces,
but preview deploy still gates workflow-bearing Cells until remote run state,
inspection, live-account verification, and cleanup are proven. Use
`examples/aws-preview` for adapter verification.
