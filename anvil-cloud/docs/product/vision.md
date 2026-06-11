# Product Vision

## One-line pitch

Anvil Cloud lets developers and agents build small cloud-backed apps through a safe, inspectable TypeScript runtime and provider adapters instead of direct cloud infrastructure.

## Problem

Coding agents can now produce useful application code quickly, but they struggle with cloud infrastructure because the surface area is too large and too stateful.

A typical cloud app requires decisions about IAM, networking, storage, logs, queues, deployment, auth, environment variables, domains, and observability. These are hard enough for humans and often unsafe for autonomous code generation.

The result is either:

- agents generate incomplete local prototypes; or
- agents are given too much cloud power and create insecure, fragile infrastructure.

## Thesis

Agents need smaller, safer worlds.

Instead of exposing provider infrastructure directly, Anvil Cloud provides an application-level contract:

- schema;
- queries;
- mutations;
- endpoints;
- jobs;
- files;
- auth;
- logs;
- declared capabilities.

Anvil maps that contract to local adapters and deployment adapters. AWS is the first planned deployment adapter.

## Target user

### Primary

Developers who use coding agents to build internal tools, prototypes, dashboards, workflow apps, and small AI-powered utilities.

### Secondary

Teams that want agent-assisted development but need guardrails, auditability, and cloud safety.

## Product principles

### Local first

A Cell should run locally without cloud provider credentials.

### Agent operable

Everything important should be inspectable from the CLI with stable JSON output.

### Capability scoped

Cells declare what they need. The platform grants only those capabilities.

### Server authoritative

Data access, auth, and validation belong in server handlers.

### Portable core, boring adapters

The runtime, builder, manifest, and CLI contracts should remain provider-neutral. Deployment adapters should use reliable managed services before adding more complex infrastructure.

### Professional open-source tone

Docs should be clear, original, and implementation-focused. The project may be inspired by the broader agent-native platform space, but it should stand on its own.

## v0 product boundary

Anvil Cloud v0 is not a general-purpose cloud provider. It is a constrained app platform for small Cells.

Good v0 use cases:

- CRUD tools;
- dashboards;
- webhook receivers;
- scheduled data refreshers;
- small authenticated portals;
- AI-assisted workflows;
- internal admin tools.

Poor v0 use cases:

- high-volume realtime apps;
- arbitrary container workloads;
- custom VPC networking;
- long-running compute;
- complex enterprise IAM;
- multi-region systems;
- low-level cloud infrastructure management.

## Success criteria

The v0 is successful when a coding agent can:

1. create a Cell;
2. add schema, query, mutation, and UI;
3. run it locally;
4. inspect logs and database state;
5. fix errors using structured diagnostics;
6. build deployable artefacts;
7. deploy a preview through the first provider adapter without touching provider primitives directly.
