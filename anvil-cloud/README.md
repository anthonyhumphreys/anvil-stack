# Anvil Cloud

Agent-ready apps through portable runtime capabilities, without giving agents cloud primitives.

Anvil Cloud is an experimental TypeScript application platform for building small, secure, inspectable applications that can run locally and deploy through provider adapters. AWS is the first planned deployment adapter, not the application contract.

The project is inspired by emerging agent-native development platforms and by the practical need for safer cloud abstractions. The goal is not to expose a cloud provider more conveniently; the goal is to provide a smaller application model that agents and developers can understand, build, inspect, and operate reliably.

## Status

This repository currently contains the v0 implementation specification and supporting architecture documents. Implementation should begin with local runtime and compiler primitives before any deployment adapter support.

## Product thesis

Agents should be able to build useful cloud-backed apps without needing direct access to identity policy, networking, gateways, databases, object stores, log sinks, schedulers, or other provider primitives.

Instead, agents author an **Anvil Cell**: a small TypeScript app unit containing server functions, UI, schema, jobs, files, endpoints, and declared capabilities.

Anvil then provides:

- a constrained TypeScript app contract;
- a local runtime with database, auth, files, jobs, logs, and inspector support;
- a compiler/bundler that emits server bundle, client bundle, and manifest;
- deployment adapters that map platform concepts onto provider-managed services, with AWS planned first;
- policy and inspection surfaces designed for both humans and coding agents.

## Naming

- **Anvil Cloud**: overall platform.
- **Anvil Cell**: deployable app unit.
- **Anvil Runtime**: local/cloud execution layer.
- **Anvil Builder**: compiler and bundler.
- **Anvil Local**: local development runtime.
- **Anvil Guard**: policy and capability checks.
- **Anvil Lens**: inspection, logs, traces, and explainability.
- **Anvil Registry**: related secure package registry/proxy project.

## Repository structure

```txt
.
├── AGENTS.md
├── docs/
│   ├── architecture/
│   ├── contributing/
│   ├── product/
│   └── specs/
├── packages/
│   ├── aws/
│   ├── builder/
│   ├── cli/
│   ├── client/
│   ├── local/
│   └── runtime/
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## First implementation milestone

Build a local-only vertical slice:

```sh
anvil new notes
cd notes
anvil dev
anvil check --json
anvil inspect --local --json
```

The first working version should support:

- object-based app DSL;
- query and mutation execution;
- local auth emulator;
- SQLite-backed local database adapter;
- Vite-powered client development;
- structured local logs;
- generated manifest;
- JSON CLI output for agents.

Deployment adapters come after the local app model is proven. AWS is the first planned adapter.

## License

License is not selected yet. Keep the repository private until the open-source license and contribution policy are agreed.
