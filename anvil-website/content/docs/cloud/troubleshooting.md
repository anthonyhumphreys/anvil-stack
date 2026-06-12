---
title: Troubleshooting
navTitle: Troubleshooting
description: Diagnose Anvil Cloud build failures, import policy violations, local runtime problems, and AWS preview issues.
product: Anvil Cloud
section: Reference
order: 145
---

# Troubleshooting

`anvil check --json` and `anvil build --json` are the primary diagnostic tools. Every failure they report carries a stable code; this page maps the common ones to fixes.

## Import policy violations (`FORBIDDEN_IMPORT`)

Anvil Guard rejects imports that bypass the Cell contract. The diagnostic includes a hint, and the fixes are mechanical:

| Import | Why it is rejected | Fix |
| --- | --- | --- |
| `fs` / `node:fs` | Cell code must not touch the host filesystem | Use `ctx.files` for Cell-owned file storage |
| `child_process` / `node:child_process` | Cells cannot spawn processes | Move background work into a declared job |
| `@aws-sdk/*` | Cells must not call providers directly | Use declared capabilities such as `ctx.db` or `ctx.files` |
| `aws-cdk-lib` | Cell code must not author infrastructure | Provider infrastructure belongs in deployment adapters |
| `sst` | Same boundary as above | Provider tooling belongs inside deployment adapters |

If you genuinely need a capability that does not exist yet, that is a platform gap, not something to work around with a direct provider import. Open an issue instead.

## Build pipeline failures

The builder runs stages in order: config load, import policy, typecheck, server/client bundle, manifest extraction. The first failing stage stops the run, so fix errors top-down.

- **Config load fails**: the Cell definition could not be evaluated. Run with `--json` and check the diagnostic; syntax errors and unresolved imports in the app definition surface here.
- **Typecheck fails**: standard TypeScript errors. The builder uses your Cell's `tsconfig`; reproduce with `tsc --noEmit` if you want faster iteration.
- **Manifest extraction fails**: usually a Cell definition that uses dynamic constructs where the builder expects declarative ones. Keep `app`, `table`, `query`, `mutation`, `endpoint`, and `job` declarations statically analyzable.

## Local runtime

- **Port already in use**: another `anvil dev` instance (or anything else) holds the port. Stop it or pass a different port.
- **Stale behavior after edits**: from a workspace checkout, the CLI runs against built package output; rerun `pnpm build` in `anvil-cloud` after changing platform packages. Cell code itself is rebuilt by the dev loop.
- **Database state surprises**: the local JSON database adapter persists per project. Inspect it with `anvil db` and the local inspector rather than guessing.

## AWS preview adapter

- **Artifact upload fails**: confirm `ANVIL_AWS_ARTIFACT_BUCKET` is set and your AWS credentials can write to it.
- **Stack synthesis or provisioning fails**: check `ANVIL_AWS_STACK_PREFIX` and `ANVIL_AWS_DEPLOYMENT_METADATA_TABLE`, then read the CloudFormation events for the failed stack; the adapter surfaces the stack name in its output.
- **Remember the scope**: the AWS adapter is a preview. It proves the adapter contract; it is not a production hosting path yet. See [Status and limits](/docs/cloud/status-and-limits).

## Getting useful output for bug reports

Every CLI command supports `--json` with stable shapes. When filing an issue at [anvil-stack](https://github.com/anthonyhumphreys/anvil-stack/issues), include:

```bash
anvil check --json
anvil build --json
```

plus the Cell definition if you can share it. JSON output is the contract; screenshots of terminal text are harder to act on.
