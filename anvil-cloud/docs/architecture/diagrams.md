# Anvil Cloud Diagrams

These diagrams explain the current Anvil Cloud alpha architecture at the level
most useful for contributors, agents, and reviewers. They show the product
contract first: Cells declare intent, Builder and Guard turn that intent into
inspectable artifacts, Runtime executes through host adapters, and deployment
adapters map the same contract onto provider resources.

Editable draw.io sources live in [`../diagrams`](../diagrams/). They can be
opened in diagrams.net or from Anvil Desktop's diagram view.

## System Map

```mermaid
flowchart LR
  Developer["Developer or coding agent"]
  Cell["Anvil Cell project<br/>server DSL, React client, anvil.json"]
  Builder["Anvil Builder<br/>typecheck, bundle, manifest"]
  Guard["Anvil Guard<br/>imports, capabilities, policy"]
  Artifacts[".anvil artifacts<br/>server bundle, client assets, manifest, generated client"]
  Local["Anvil Local<br/>runtime server, Vite client, local adapters"]
  Lens["Anvil Lens<br/>manifest, logs, db, requests"]
  Adapter["Deployment adapter contract<br/>plan, deploy, remove"]
  AWS["AWS preview adapter<br/>Lambda, API Gateway, S3, DynamoDB, CloudWatch"]
  Remote["Remote inspect and logs<br/>stable JSON for humans and agents"]

  Developer -->|"authors"| Cell
  Cell -->|"compiled by"| Builder
  Cell -->|"checked by"| Guard
  Builder -->|"writes"| Artifacts
  Guard -->|"blocks unsafe code before output"| Artifacts
  Artifacts -->|"run locally"| Local
  Local -->|"feeds"| Lens
  Artifacts -->|"provider-neutral graph"| Adapter
  Adapter -->|"realizes capabilities"| AWS
  AWS -->|"reports"| Remote

  classDef actor fill:#0f172a,stroke:#38bdf8,color:#e5e7eb,stroke-width:2px;
  classDef cell fill:#1e293b,stroke:#a78bfa,color:#f8fafc,stroke-width:2px;
  classDef build fill:#18202f,stroke:#60a5fa,color:#f8fafc;
  classDef guard fill:#311c24,stroke:#fb7185,color:#ffe4e6;
  classDef run fill:#102a24,stroke:#34d399,color:#ecfdf5;
  classDef deploy fill:#2a2414,stroke:#fbbf24,color:#fffbeb;

  class Developer actor;
  class Cell cell;
  class Builder,Artifacts build;
  class Guard guard;
  class Local,Lens run;
  class Adapter,AWS,Remote deploy;
```

Use this when explaining the platform in one picture. The key point: AWS is an
adapter behind Anvil concepts, not the Cell authoring surface.

Draw.io source: [`anvil-cloud-system-map.drawio`](../diagrams/anvil-cloud-system-map.drawio)

## Local Development Loop

```mermaid
flowchart LR
  Source["Cell source<br/>src/cell.server.ts, src/client/*"]
  Dev["anvil-cloud dev"]
  Guard["Guard checks<br/>capability and import policy"]
  Server["Local runtime server<br/>http://localhost:8787"]
  Client["Vite client server<br/>http://localhost:5173"]
  State[".anvil/local<br/>SQLite, auth, files, jobs, logs"]
  Lens["/_anvil/lens and inspect API"]
  Agent["Agent mode<br/>JSONL lifecycle events"]

  Source --> Dev
  Dev --> Guard
  Guard --> Server
  Guard --> Client
  Server --> State
  Server --> Lens
  Server --> Agent
  Client -->|"proxies /_anvil and /api"| Server
  Source -->|"hot rebuild"| Dev

  classDef source fill:#1e293b,stroke:#a78bfa,color:#f8fafc;
  classDef process fill:#18202f,stroke:#60a5fa,color:#f8fafc;
  classDef local fill:#102a24,stroke:#34d399,color:#ecfdf5;
  classDef data fill:#292524,stroke:#fbbf24,color:#fffbeb;

  class Source source;
  class Dev,Guard,Server,Client process;
  class Lens,Agent local;
  class State data;
```

Local development proves the Cell model without requiring AWS credentials,
Docker, or raw provider resources. That lack of setup is intentional: local
should be boring enough to trust.

## Runtime Request Path

```mermaid
sequenceDiagram
  participant Browser as Client or caller
  participant Adapter as Local or AWS adapter
  participant Runtime as Anvil Runtime
  participant Handler as Cell handler
  participant Host as RuntimeHost
  participant Store as db/files/env/auth/logs/jobs

  Browser->>Adapter: HTTP, job, or workflow trigger
  Adapter->>Runtime: RuntimeRequest
  Runtime->>Runtime: validate input and auth
  Runtime->>Host: create RuntimeContext
  Host->>Store: provide scoped adapters
  Runtime->>Handler: execute with ctx
  Handler->>Host: use declared capabilities
  Host->>Store: read/write through adapter
  Handler-->>Runtime: result or error
  Runtime-->>Adapter: RuntimeResponse
  Adapter-->>Browser: environment response
```

Every trigger becomes a `RuntimeRequest` before user code runs. That keeps local
dev, tests, Lambda, jobs, and future adapters on the same execution path instead
of growing one-off handler plumbing that quietly diverges.

Draw.io source: [`anvil-cloud-runtime-request-flow.drawio`](../diagrams/anvil-cloud-runtime-request-flow.drawio)

## Build And Deploy Pipeline

```mermaid
flowchart LR
  Check["anvil-cloud check<br/>JSON diagnostics"]
  Build["anvil-cloud build<br/>typecheck and bundle"]
  Manifest["Manifest and Cell graph<br/>provider-neutral"]
  Plan["anvil-cloud plan<br/>adapter diff"]
  Approval["Capability change review<br/>risky changes require approval"]
  Upload["Upload artifacts<br/>server bundle and client assets"]
  Provision["Provision adapter resources<br/>AWS preview today"]
  Inspect["inspect, logs, Lens<br/>runtime evidence"]

  Check --> Build
  Build --> Manifest
  Manifest --> Plan
  Plan --> Approval
  Approval --> Upload
  Upload --> Provision
  Provision --> Inspect
  Inspect -->|"feedback into source"| Check

  Guard["Anvil Guard"]
  Guard -.->|"fails unsafe imports, env access, undeclared capabilities"| Check
  Guard -.->|"blocks unsafe artifact output"| Build

  classDef command fill:#18202f,stroke:#60a5fa,color:#f8fafc;
  classDef artifact fill:#1e293b,stroke:#a78bfa,color:#f8fafc;
  classDef risk fill:#311c24,stroke:#fb7185,color:#ffe4e6;
  classDef deploy fill:#2a2414,stroke:#fbbf24,color:#fffbeb;
  classDef observe fill:#102a24,stroke:#34d399,color:#ecfdf5;

  class Check,Build,Plan command;
  class Manifest artifact;
  class Guard,Approval risk;
  class Upload,Provision deploy;
  class Inspect observe;
```

This is the delivery loop. The adapter receives a Cell graph and artifacts; Cell
authors never write Pulumi, AWS SDK calls, Terraform resources, CDK stacks, or
container definitions.

Draw.io source: [`anvil-cloud-build-deploy-pipeline.drawio`](../diagrams/anvil-cloud-build-deploy-pipeline.drawio)

## Capability Enforcement

```mermaid
flowchart TB
  Declared["Declared capabilities<br/>database, files, env, jobs, workflows, services, outboundFetch"]
  Source["Cell source<br/>handlers, endpoints, jobs, workflows, services"]
  Static["Static checks<br/>forbidden imports, process.env, fetch allow-list"]
  Usage["Runtime capability usage<br/>ctx.db, ctx.files, ctx.env, ctx.jobs"]
  Manifest["Manifest<br/>declared app shape"]
  AdapterPolicy["Adapter policy<br/>least-privilege IAM/resources"]
  RuntimeGate["Runtime context gates<br/>scoped clients only"]
  Deny["Stable diagnostics<br/>CAPABILITY_NOT_DECLARED, OUTBOUND_FETCH_NOT_ALLOWED"]

  Declared --> Static
  Source --> Static
  Source --> Usage
  Static -->|"passes"| Manifest
  Static -->|"fails"| Deny
  Usage --> RuntimeGate
  Manifest --> AdapterPolicy
  Declared --> AdapterPolicy
  RuntimeGate -->|"undeclared use fails closed"| Deny

  classDef contract fill:#1e293b,stroke:#a78bfa,color:#f8fafc;
  classDef guard fill:#311c24,stroke:#fb7185,color:#ffe4e6;
  classDef output fill:#102a24,stroke:#34d399,color:#ecfdf5;
  classDef deny fill:#450a0a,stroke:#f87171,color:#fee2e2;

  class Declared,Source contract;
  class Static,Usage,RuntimeGate guard;
  class Manifest,AdapterPolicy output;
  class Deny deny;
```

Capabilities are the contract. Guard catches obvious unsafe behavior before
build output, adapters translate capabilities into provider policy, and Runtime
keeps handlers behind `ctx` instead of raw platform APIs.

## Adapter Mapping

```mermaid
flowchart LR
  Graph["AnvilCellGraph<br/>routes, functions, tables, secrets, jobs, workflows, services"]
  Local["Local adapter<br/>Hono/Fastify-style runtime, SQLite, local auth, NDJSON logs"]
  AWS["AWS preview adapter<br/>Lambda, API Gateway, DynamoDB, S3, CloudWatch"]
  Future["Future adapters<br/>same Cell graph, different engine"]
  Lens["Inspection<br/>manifest, logs, status, tables, recent errors"]

  Graph -->|"dev"| Local
  Graph -->|"preview deploy"| AWS
  Graph -.->|"later"| Future
  Local --> Lens
  AWS --> Lens
  Future -.-> Lens

  AWSJobs["AWS background mappings<br/>SQS jobs, EventBridge schedules, Step Functions design"]
  Services["Services<br/>local supervised runner; cloud container mapping is future work"]

  AWS --> AWSJobs
  Graph --> Services

  classDef graphNode fill:#1e293b,stroke:#a78bfa,color:#f8fafc;
  classDef local fill:#102a24,stroke:#34d399,color:#ecfdf5;
  classDef aws fill:#2a2414,stroke:#fbbf24,color:#fffbeb;
  classDef future fill:#27272a,stroke:#a1a1aa,color:#f4f4f5,stroke-dasharray: 6 4;
  classDef inspect fill:#18202f,stroke:#60a5fa,color:#f8fafc;

  class Graph graphNode;
  class Local local;
  class AWS,AWSJobs aws;
  class Future,Services future;
  class Lens inspect;
```

The graph is deliberately provider-neutral. Pulumi is currently an AWS adapter
implementation detail, not something Cell authors touch.
