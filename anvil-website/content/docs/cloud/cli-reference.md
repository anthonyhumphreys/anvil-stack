---
title: CLI reference
navTitle: CLI reference
description: Commands, JSON output, exit codes, local inspection, and AWS preview deployment for the Anvil Cloud CLI.
product: Anvil Cloud
section: Reference
order: 140
---

# CLI reference

The Anvil Cloud CLI binary is `anvil`.

In alpha, the package exists as `@anvil-cloud/cli` inside the `anvil-cloud` workspace. The command contract is the important part: human output can be friendly, but automation output must be stable.

## Commands

| Command | Purpose |
| --- | --- |
| `anvil new <name>` | Create a new Cell project. |
| `anvil dev` | Build and start the local runtime and client server. |
| `anvil check` | Validate config, import policy, capabilities, and TypeScript without writing build output. |
| `anvil build` | Build server and client artifacts, manifest, generated client, generated types, and metadata. |
| `anvil inspect --local` | Inspect local manifest, auth, database counts, and recent errors. |
| `anvil lens` | Verify the local runtime is reachable and print the Anvil Lens URL. |
| `anvil logs --local` | Read local NDJSON logs. |
| `anvil db list --local` | List local database tables. |
| `anvil db dump <table> --local` | Dump local table rows. |
| `anvil deploy --preview` | Build and synthesize AWS preview deployment output, with provisioning when configured. |
| `anvil auth users` | List local identity provider users. |
| `anvil auth add-user <id>` | Create a local user (`--email`, `--roles a,b`). |
| `anvil auth remove-user <id>` | Delete a local user. |
| `anvil auth login <id>` | Set the ambient dev identity and print a JWT. |
| `anvil auth token <id>` | Mint a JWT for a user (`--ttl` seconds); ideal for agents and curl. |
| `anvil auth whoami` | Show the ambient dev identity. |
| `anvil workflows list` | List local workflow runs. |
| `anvil workflows show <runId>` | Show a local workflow run with per-step state. |
| `anvil workflows run <name>` | Build the Cell and execute a workflow locally (`--input '<json>'`). |
| `anvil services list` | Show the last recorded local service states from `.anvil/local/services.json`. |

Remote inspection:

```bash
anvil inspect --app notes --env preview --json
anvil logs --app notes --env preview --json
```

Remote AWS readers require `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`.

## `anvil new <name>`

Creates a starter Cell:

```bash
anvil new notes
```

JSON output:

```json
{
  "ok": true,
  "cell": "notes",
  "path": "./notes",
  "next": ["cd notes", "anvil dev"]
}
```

## `anvil dev`

Starts local runtime and client servers after a successful build.

Options:

```txt
--json
--agent
--port <port>
--client-port <port>
```

Human output:

```txt
Anvil Local runtime  http://localhost:8787
Anvil client         http://localhost:5173
Anvil Lens           http://localhost:8787/_anvil/lens
```

`--agent --json` emits JSONL events and avoids rich terminal output.

## `anvil lens`

Checks that a local runtime is reachable (`GET /_anvil/health` at `--port`, default `8787`) and prints the Lens URL:

```bash
anvil lens
anvil lens --json
```

Success:

```json
{ "ok": true, "url": "http://localhost:8787/_anvil/lens" }
```

If nothing is running, the command exits with code `5` and returns `LENS_SERVER_NOT_RUNNING` telling you to run `anvil dev` first. See [Anvil Lens](/docs/cloud/lens).

## `anvil check`

Runs validation without writing artifacts:

```bash
anvil check --json
```

Failure shape:

```json
{
  "ok": false,
  "phase": "import-policy",
  "errors": [
    {
      "code": "FORBIDDEN_IMPORT",
      "severity": "error",
      "message": "Import '@aws-sdk/client-s3' is not allowed in Cell server code.",
      "hint": "Use declared Anvil capabilities such as ctx.db or ctx.files."
    }
  ]
}
```

## `anvil build`

Writes `.anvil/dist` and `.anvil/generated`:

```bash
anvil build --json
```

Successful output includes build paths, manifest, and diagnostics.

## Local inspection commands

```bash
anvil inspect --local --json
anvil logs --local --json
anvil db list --local --json
anvil db dump todos --local --json
anvil services list --json
```

`anvil services list` reads the snapshot file written by the dev server, so it shows the last recorded states. For live service state, query `GET /_anvil/services` on a running dev server. See [Services](/docs/cloud/services).

Use these before deploying. They are cheap and they catch the kind of "it worked in my imagination" issues that make preview environments do performance art.

## `anvil deploy --preview`

```bash
anvil deploy --preview --json
```

The CLI:

1. builds the Cell with `target: "preview"`
2. creates an AWS preview deployment plan
3. synthesizes a CloudFormation template
4. packages deploy artifacts when build output is present
5. provisions AWS resources only when the AWS provisioner is configured

If provisioning is not configured, the adapter returns:

- `ok: false`
- `code: "AWS_PROVISIONER_NOT_CONFIGURED"`
- deployment plan
- CloudFormation template
- artifact summary when available

That is useful. It means deploy planning can be reviewed without mutating an AWS account.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | General failure |
| `2` | Invalid CLI usage |
| `3` | Project validation failed |
| `4` | Build failed |
| `5` | Runtime unavailable or remote reader not configured |
| `6` | Deploy failed |

## Automation rule

Every automation-oriented command should support `--json`. Do not parse human output in CI or agent workflows unless you enjoy finding out that punctuation is an API now.
