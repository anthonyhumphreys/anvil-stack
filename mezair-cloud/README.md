# Mezair Cloud

Agent-ready apps through portable runtime capabilities, without giving agents cloud primitives.

Mezair Cloud is an alpha TypeScript application platform for building small, secure, inspectable applications that can run locally and deploy through provider adapters. AWS is the first planned deployment adapter, not the application contract.

The project is inspired by emerging agent-native development platforms and by the practical need for safer cloud abstractions. The goal is not to expose a cloud provider more conveniently; the goal is to provide a smaller application model that agents and developers can understand, build, inspect, and operate reliably.

## Status

This repository contains the alpha implementation, supporting architecture documents, local runtime, builder, CLI, Lens, auth, workflow, service, and AWS preview adapter work.

## Product thesis

Agents should be able to build useful cloud-backed apps without needing direct access to identity policy, networking, gateways, databases, object stores, log sinks, schedulers, or other provider primitives.

Instead, agents author an **Mezair Cell**: a small TypeScript app unit containing server functions, UI, schema, jobs, files, endpoints, and declared capabilities.

Mezair then provides:

- a constrained TypeScript app contract;
- a local runtime with database, auth, files, jobs, logs, and inspector support;
- a compiler/bundler that emits server bundle, client bundle, and manifest;
- deployment adapters that map platform concepts onto provider-managed services, with AWS planned first;
- policy and inspection surfaces designed for both humans and coding agents.

## Naming

- **Mezair Cloud**: overall platform.
- **Mezair Cell**: deployable app unit.
- **Mezair Runtime**: local/cloud execution layer.
- **Mezair Builder**: compiler and bundler.
- **Mezair Local**: local development runtime.
- **Mezair Guard**: policy and capability checks.
- **Mezair Lens**: inspection, logs, traces, and explainability.
- **Mezair Registry**: related secure package registry/proxy project.

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

Architecture diagrams:

- Mermaid overview: [`docs/architecture/diagrams.md`](docs/architecture/diagrams.md)
- Editable draw.io sources: [`docs/diagrams/`](docs/diagrams/)

## Alpha path

Build a local-only vertical slice:

```sh
mezair-cloud new notes
cd notes
mezair-cloud dev
mezair-cloud check --json
mezair-cloud inspect --local --json
```

The alpha supports or is building toward:

- object-based app DSL;
- query and mutation execution;
- local auth emulator;
- SQLite-backed local database adapter;
- Vite-powered client development;
- structured local logs;
- generated manifest;
- JSON CLI output for agents.

Deployment adapters build on the local app model. AWS is the first adapter.

## License

MIT. See the root `LICENSE`.
