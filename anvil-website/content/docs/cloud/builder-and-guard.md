---
title: Builder and Guard
navTitle: Builder and Guard
description: How the Anvil Builder checks, bundles, extracts manifests, and enforces alpha import and capability policy.
product: Anvil Cloud
section: Runtime
order: 130
---

# Builder and Guard

The Anvil Builder turns a Cell project into inspectable output. Guard checks keep server code inside the Cell contract.

## Build pipeline

`anvil check` and `anvil build` share the same pipeline. `check` runs it without writing artifacts; `build` writes output.

Pipeline:

1. Load `anvil.json`.
2. Resolve server and client entrypoints.
3. Run import and capability policy checks.
4. Run TypeScript typecheck.
5. Bundle the server entrypoint.
6. Import the server bundle and extract the app manifest.
7. Bundle the client entrypoint.
8. Write manifest, generated client, generated types, and build metadata.

If any error-level diagnostic appears, the pipeline stops at the failing phase.

## Output directories

```txt
.anvil/
  dist/
    client/
      index.html
      assets/
        cell.client.js
    server/
      index.mjs
    manifest.json
    build-meta.json
  generated/
    api.d.ts
    client.ts
```

## Diagnostics

Diagnostics include:

- code
- severity
- message
- file
- line and column where available
- hint where available

CLI JSON output keeps these shapes stable enough for scripts and agents.

## Import policy

Cell server code must stay statically inspectable. Current forbidden imports include:

| Import | Why |
| --- | --- |
| `fs`, `node:fs` | Use `ctx.files` for Cell-owned file storage. |
| `child_process`, `node:child_process` | Move background work into declared jobs. |
| `@aws-sdk/*` | Provider access belongs in the AWS adapter. |
| `aws-cdk-lib` | Cell code must not author provider infrastructure directly. |
| `sst`, `sst/*` | Provider tooling belongs inside deployment adapters. |
| `cdktf`, `@cdktf/*` | Terraform/CDKTF authoring belongs inside deployment adapters. |
| `pulumi`, `@pulumi/*` | Provider infrastructure belongs inside deployment adapters. |

Dynamic import is also forbidden in Cell server code.

## Capability checks

Guard can detect some undeclared effects:

- global `fetch` requires `capabilities.outboundFetch`
- literal `fetch("https://...")` hosts must match `capabilities.outboundFetch.allow`
- fetch targets must be static absolute `http` or `https` URL literals so Guard
  can check the host
- scheduled jobs require `capabilities.scheduledJobs`
- direct `process.env` is rejected, use `ctx.env`
- handler use of capabilities should match declared Cell capabilities where alpha can inspect it

This is not a perfect sandbox. It is a practical alpha control that narrows the contract and catches common ways app code escapes into provider-specific behavior.

## Typecheck

The builder runs TypeScript against the Cell project. This catches app-code mistakes before bundle and manifest extraction.

Use:

```bash
anvil check --json
```

before:

```bash
anvil build --json
```

## Manifest extraction

After the server bundle is built, the builder imports it and verifies that the default export is an `app()` definition.

If manifest extraction fails, the builder returns `SERVER_EXPORT_INVALID` or `MANIFEST_EXTRACTION_FAILED` diagnostics.

## Generated client output

The builder emits generated client metadata under `.anvil/generated` so browser code can call queries and mutations through stable names instead of hand-written string paths.

Read [Generated client](/docs/cloud/generated-client) for client-side usage.

## Practical rule

If a Cell needs a new capability, declare it and teach the runtime/adapters how to provide it. Do not smuggle provider access through imports. Smuggling is exciting right up until the first deploy plan looks like a ransom note.
