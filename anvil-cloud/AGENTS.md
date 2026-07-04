# AGENTS.md

This repository is intended to be worked on by human developers and coding agents. Treat these instructions as the operating contract for safe, useful changes.

## Project intent

Anvil Cloud is an agent-ready, portable TypeScript application platform. It gives developers and agents a small application model and hides provider-specific infrastructure behind typed runtime capabilities and deployment adapters.

The goal is to make apps that are:

- easy to build locally;
- easy to inspect from the CLI;
- safe by default;
- capability-scoped;
- deployable through provider adapters without exposing raw cloud primitives to app authors.

## Current phase

The project is in alpha implementation phase.

Prioritise work in this order:

1. runtime contract and app DSL;
2. local runtime;
3. compiler/bundler and manifest extraction;
4. CLI commands with `--json` support;
5. local inspector;
6. deployment adapter contract;
7. AWS preview adapter;
8. policy/capability enforcement.

Do not start with cloud infrastructure. Prove the local app model and adapter contract first.

## Naming rules

Use these product names consistently:

- Anvil Cloud: platform.
- Anvil Cell: deployable app unit.
- Anvil Runtime: execution layer.
- Anvil Builder: compiler/bundler.
- Anvil Local: local runtime.
- Anvil Guard: policy/capability checks.
- Anvil Lens: inspection/debugging.

Avoid using `forge` in package names, docs, commands, or product concepts.

## Documentation tone

This repository may become open source. Keep docs professional, precise, and original.

It is fine to say the project is inspired by agent-native development platforms. Do not frame the project as a clone or copy of any specific product.

## Technical principles

### Agents need small worlds

Prefer constrained, typed platform primitives over general-purpose cloud escape hatches.

Good:

```ts
ctx.db.notes.insert(...)
ctx.files.put(...)
ctx.env.require("OPENAI_API_KEY")
ctx.log.info("Created note", { noteId })
```

Avoid:

```ts
new DynamoDBClient(...)
new S3Client(...)
process.env.OPENAI_API_KEY
```

### Local and deployed runtimes must share the same contract

User app code should not need to know whether it is running locally or through a deployment adapter. Runtime adapters should provide environment-specific implementations.

### JSON output is a first-class interface

Every CLI command intended for automation must support `--json` and return stable shapes with clear error codes.

### Capabilities before resources

Apps declare capabilities. The platform maps capabilities to local or adapter-provided resources.

Example:

```ts
capabilities: {
  database: true,
  files: { publicRead: false },
  outboundFetch: { allow: ["api.openai.com"] }
}
```

### No direct provider access in Cell code

Cell code should not import cloud provider SDKs directly. Add platform capabilities instead.

### Effect is platform-internal only

Anvil Cloud uses [Effect](https://effect.website) inside orchestration internals: the workflow executor, the guarded agent runtime, the AWS preview provisioner/destroyer and remote reader, and the CLI deploy flow. Effect is never part of the Cell authoring contract; Cell code uses ordinary async TypeScript and the Anvil Runtime APIs.

When writing or changing Effect code, follow the established boundary contract:

- Keep public APIs Promise-based. Run effects with `Effect.runPromiseExit` at the boundary and rethrow both typed failures and defects as their original values (`Cause.squash`), so callers keep pre-Effect error shapes.
- Type the error channel with the surface's expected failure class (`RuntimeError`, `AwsPreviewProvisioningError`, `AwsPreviewDestroyError`, `AwsRemoteReaderError`). Do not use `unknown` error channels or identity catch functions. Unexpected errors are defects (`Effect.die`), not widened failures.
- Use `Schedule` for retries and polling instead of manual loops with `setTimeout`.
- Bound concurrency in `Effect.all` when the input size is not fixed.
- See `docs/architecture/deployment-adapters.md` (Effect usage) and `PATCH.md` at the repo root for the full contract and verification commands.

## Expected repo structure

```txt
packages/runtime   # app DSL and runtime-server core
packages/client    # browser client and hooks
packages/builder   # compiler, bundler, manifest extraction
packages/local     # local adapters and dev server
packages/aws       # first deployment adapter, implemented after the adapter contract
packages/cli       # anvil CLI
```

## Before changing code

1. Read `docs/specs/alpha-implementation-spec.md`.
2. Read the relevant architecture document under `docs/architecture/`.
3. Keep changes scoped to the current milestone.
4. Prefer adding tests or typed examples for runtime behaviour.

## Before opening a PR

Run, or implement if not yet available:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

For CLI/runtime changes, include example `--json` output in docs or tests.

## Hard constraints

- Do not add production deployment before local runtime and the deployment adapter contract exist.
- Do not expose raw container, Kubernetes, or Docker authoring to Cell authors. Long-running work goes through the `service` primitive (supervised handlers, executed locally in alpha); container-backed execution such as ECS/Fargate is a future deployment adapter concern, never a Cell-level API.
- Do not expose raw AWS SDK usage to Cell authors.
- Do not implement multiple production cloud adapters during alpha.
- Keep core runtime, builder, manifest, and CLI contracts provider-neutral so future adapters do not require Cell code changes.
- Do not optimise for enterprise networking until the basic Cell model works.
- Do not introduce brand/product language that could conflict with existing developer platforms.

## Useful first tasks

- Implement `app`, `query`, `mutation`, `endpoint`, and `table` DSL primitives.
- Implement `handleRuntimeRequest` in runtime core.
- Implement in-memory database adapter for tests.
- Implement local Hono/Fastify runtime server.
- Implement manifest extraction from a declarative app definition.
- Implement `anvil-cloud check --json` with at least one forbidden-import diagnostic.
