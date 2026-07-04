# Builder Architecture

## Purpose

Anvil Builder turns Anvil Cell source code into deployable and inspectable artefacts.

The builder is responsible for:

- validating the project structure;
- typechecking Cell source;
- enforcing import and capability restrictions;
- bundling the server entrypoint;
- bundling the client entrypoint when the target is `vite-react`;
- extracting a manifest;
- generating client API metadata;
- writing build metadata.

## Design principles

- Build output should be deterministic.
- Build errors should be machine-readable.
- Manifest extraction should not execute handler bodies.
- Unsafe imports should fail before bundle output.
- The builder should produce the same artefacts for local inspection and cloud deploy.

## Package split

```txt
packages/builder
  src/
    build.ts             # main build pipeline
    config.ts            # anvil.json loading and validation
    diagnostics.ts       # stable diagnostic types/codes
    import-policy.ts     # forbidden/allowed import rules
    manifest-extract.ts  # manifest extraction from app definition
    server-bundle.ts     # esbuild server bundle
    client-bundle.ts     # Vite client bundle
    generated-client.ts  # generated API metadata/types
```

## Build pipeline

```txt
1. Load anvil.json
2. Resolve Cell entrypoints
3. Validate source layout
4. Run TypeScript typecheck
5. Run static import policy checks
6. Bundle server entrypoint
7. Load bundled app in analysis mode
8. Extract manifest
9. Bundle client entrypoint when `client.kind` is `vite-react`
10. Generate client metadata
11. Write build metadata
12. Return build result
```

## Build output

```txt
.anvil/dist/server/index.mjs
.anvil/dist/server/index.mjs.map
.anvil/dist/client/index.html
.anvil/dist/client/assets/*
.anvil/dist/manifest.json
.anvil/dist/build-meta.json
.anvil/generated/client.ts
.anvil/generated/api.d.ts
```

## Server bundling

Use esbuild in alpha.

Recommended defaults:

```ts
await build({
  entryPoints: [serverEntry],
  outfile: ".anvil/dist/server/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  plugins: [forbiddenImportPlugin],
});
```

## Client bundling

Use Vite + React for the default `vite-react` client target in alpha.

The client build should consume generated Anvil client metadata through
`@anvil/generated/client`. Local dev should use the Vite dev server with
proxying to the local runtime.

`client.kind` is a client-target selector, not a deployment adapter. Supported
alpha values are `vite-react`, `expo-router`, and `headless`. `expo-router` and
`headless` builds still typecheck source, emit the server bundle, manifest,
generated client metadata, and build metadata, but they do not emit
`.anvil/dist/client/index.html`. Expo Router projects run their native client
with Expo and call the local or deployed Anvil runtime through
`@anvil-cloud/client`.

## Import policy

Forbidden by default in Cell server source:

- `@aws-sdk/*`
- `aws-cdk-lib`
- `sst`
- `cdktf`, `@cdktf/*`
- `pulumi`, `@pulumi/*`
- `fs`
- `node:fs`
- `child_process`
- `node:child_process`
- `process.env` direct access, including straightforward static forms such as
  `process.env`, `process["env"]`, `globalThis.process.env`, aliased
  `process`, and destructured `env` aliases
- native addons

Capability checks currently reject straightforward handler usage, static bracket
notation such as `ctx["db"]`, and destructuring such as `const { db } = ctx` or
`handler: ({ db }) =>`, of:

- `ctx.db` without `capabilities.database`;
- `ctx.files` without `capabilities.files`;
- `ctx.events` without `capabilities.events`;
- `ctx.jobs` without `capabilities.jobs`;
- `ctx.workflows` without `capabilities.workflows`;
- `workflow(...)` without `capabilities.workflows`;
- `service(...)` without `capabilities.services`;
- `ctx.env.get("NAME")` or `ctx.env.require("NAME")` when `NAME` is not
  declared in `capabilities.env` or `capabilities.secrets`;
- aliased or static bracket `ctx.env.get` / `ctx.env.require` calls when the
  requested name is not declared;
- dynamic `ctx.env` methods such as `ctx.env[input.method]("NAME")`;
- computed `ctx.env` method destructuring such as
  `const { [input.method]: readEnv } = ctx.env`;
- dynamic `ctx.env` names when env declarations are static;
- dynamic context capability properties such as `ctx[input.capability]`;
- non-static context destructuring such as `const { ...scoped } = ctx`;
- direct network client imports such as `http`, `https`, `node:net`,
  `undici`, or `axios`;
- global `fetch()`, `globalThis.fetch()`, or static fetch aliases without
  `capabilities.outboundFetch`;
- `fetch()` targets that are not static absolute `http` or `https` URL literals;
- `fetch()` hosts outside `capabilities.outboundFetch.allow`;
- `job({ schedule })` without `capabilities.scheduledJobs`.

When a previous `.anvil/dist/manifest.json` exists, the build pipeline also
compares the new manifest against that local baseline and fails before writing
new artifacts for obviously risky changes:

- `capabilities.files.publicRead` changing from `false` or absent to `true`;
- removing a schema table;
- removing a schema field;
- changing a schema field type.

This is a local Guard check, not a remote migration engine. It catches
high-signal mistakes during build while deployment adapters and remote
inspection grow the richer history needed for approved migrations.

Preferred replacements:

| Unsafe operation  | Anvil replacement |
| ----------------- | ----------------- |
| AWS SDK S3        | `ctx.files`       |
| AWS SDK DynamoDB  | `ctx.db`          |
| `process.env`     | `ctx.env`         |
| `fs` file storage | `ctx.files`       |
| background task   | `ctx.jobs`        |
| event publish     | `ctx.events`      |

## Manifest extraction

The app definition must be declarative enough that the builder can extract manifest data without calling user handlers.

The builder may import the bundled module in analysis mode and inspect the default export.

Rules:

- no network calls at module import time;
- no dynamic schema based on runtime state;
- no top-level data access;
- no environment reads outside explicit env declarations.

## Diagnostic shape

```ts
export type BuilderDiagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
  column?: number;
  hint?: string;
};
```

Example JSON output:

```json
{
  "ok": false,
  "phase": "import-policy",
  "diagnostics": [
    {
      "code": "CAPABILITY_NOT_DECLARED",
      "severity": "error",
      "message": "ctx.files requires capabilities.files to be declared.",
      "file": "src/cell.server.ts",
      "line": 12,
      "column": 23,
      "hint": "Declare capabilities.files before using ctx.files. ctx.files is capability-scoped Cell code."
    }
  ],
  "errors": [
    {
      "code": "CAPABILITY_NOT_DECLARED",
      "severity": "error",
      "message": "ctx.files requires capabilities.files to be declared.",
      "file": "src/cell.server.ts",
      "line": 12,
      "column": 23,
      "hint": "Declare capabilities.files before using ctx.files. ctx.files is capability-scoped Cell code."
    }
  ]
}
```

Destructive manifest-change diagnostics use the same shape:

```json
{
  "code": "DESTRUCTIVE_SCHEMA_CHANGE",
  "severity": "error",
  "message": "Schema field 'notes.body' was removed compared with the previous build.",
  "hint": "Add an explicit migration plan before removing Cell-owned data fields."
}
```

`errors` is kept as a compatibility alias. New automation should read
`diagnostics`.

## Generated client metadata

The builder should generate a stable metadata object for client code:

```ts
export const api = {
  queries: {
    listNotes: { kind: "query", name: "listNotes" },
  },
  mutations: {
    createNote: { kind: "mutation", name: "createNote" },
  },
  meta: {
    schemaVersion: "0.1",
    queries: ["listNotes"],
    mutations: ["createNote"],
  },
} as const;
```

`@anvil-cloud/client` uses the route metadata to call the runtime. Tooling such
as `anvil-cloud doctor --json` uses `api.meta` as the stable operation summary
when checking generated client freshness against the built manifest.

Generated metadata also exports empty `QueryTypes` and `MutationTypes`
interfaces. Cell code may augment those interfaces from source files such as
`src/anvil-api.d.ts`:

```ts
declare module "@anvil/generated/client" {
  interface QueryTypes {
    listNotes: {
      input: unknown;
      result: Note[];
    };
  }
}
```

The generated runtime object stays plain metadata, while `createApiClient` and
`createAnvilHooks` can infer input and result types from the augmented route
maps. That keeps the runtime contract provider-neutral and avoids making the
builder pretend it can recover TypeScript handler generics at runtime.

## Build metadata

```json
{
  "buildId": "build_abc123",
  "createdAt": "2026-06-07T10:30:00.000Z",
  "builderVersion": "0.0.0",
  "nodeVersion": "20.11.0",
  "gitCommit": "abc123"
}
```

## Future work

- Remote build support.
- Build caching.
- SBOM generation.
- Dependency risk scoring via Anvil Registry.
- Source provenance and signed artefacts.
