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
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js build --json
```

Or run the repeatable local smoke verifier from the `anvil-cloud` workspace:

```bash
pnpm verify:notes-local
```

It starts `anvil dev` on ephemeral ports, creates a local user, mints a real
JWT, calls authenticated note mutation/query routes, checks inspect/logs, and
then shuts the dev server down.

Run it locally:

```bash
node ../../packages/cli/dist/index.js dev --port 8787 --client-port 5173
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
node ../../packages/cli/dist/index.js inspect --local --json
node ../../packages/cli/dist/index.js logs --local --json
node ../../packages/cli/dist/index.js db dump notes --local --json
node ../../packages/cli/dist/index.js workflows run onboardUser --input '{}' --json
```

This demo intentionally includes a workflow, so it is not currently the AWS
preview smoke Cell. Use `examples/aws-preview` for adapter verification until
cloud workflow execution exists.
