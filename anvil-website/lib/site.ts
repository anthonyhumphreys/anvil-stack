import {
  BadgeCheck,
  Boxes,
  Braces,
  ClipboardCheck,
  Cloud,
  Code2,
  Command,
  FileSearch,
  GitBranch,
  GitPullRequestArrow,
  Hammer,
  LockKeyhole,
  MessageSquareText,
  Network,
  PackageCheck,
  Route,
  Terminal,
  Workflow
} from "lucide-react";

export const cloudRepositoryUrl =
  process.env.NEXT_PUBLIC_ANVIL_CLOUD_REPO_URL ||
  "https://github.com/anthonyhumphreys/anvil-stack/tree/main/anvil-cloud";

export const desktopRepositoryUrl =
  process.env.NEXT_PUBLIC_ANVIL_APP_REPO_URL ||
  "https://github.com/anthonyhumphreys/anvil-stack/tree/main/anvil-app";

export const registryRepositoryUrl =
  process.env.NEXT_PUBLIC_ANVIL_REGISTRY_REPO_URL ||
  "https://github.com/anthonyhumphreys/anvil-stack/tree/main/anvil-registry";

export const repositoryUrl = "/docs/project/repositories";

export const navItems = [
  { label: "Products", href: "/#products" },
  { label: "Docs", href: "/docs" },
  { label: "Cloud", href: "/docs/cloud/overview" },
  { label: "Registry", href: "/docs/registry/quickstart" },
  { label: "Desktop", href: "/docs/desktop/overview" },
  { label: "OSS", href: "/docs/project/open-source" }
];

export const productLines = [
  {
    title: "Anvil Desktop",
    repoName: "anvil-app",
    eyebrow: "Local delivery workspace",
    description:
      "An Electron app for repo-aware agent delivery work. It keeps repositories, work items, chat sessions, Git state, reviews, security checks, terminals, docs, diagrams, and handover evidence in one local workspace.",
    boundary: "Owns local delivery orchestration and evidence capture.",
    status: "Active desktop app with main, preload, shared IPC, and React renderer surfaces.",
    icon: Terminal,
    image: "/anvil-app-homepage.png",
    imageAlt: "Anvil Desktop showing repository navigation and an agent chat workspace.",
    href: "/docs/desktop/overview",
    repoHref: desktopRepositoryUrl,
    command: "pnpm dev",
    points: [
      "Local Electron shell with SQLite persistence and typed IPC boundaries",
      "Codex and LLM workflows grounded in checked-out repositories",
      "Work item, review, security, documentation, diagram, and terminal surfaces",
      "Mobile, Raycast, watch, widget, and menu bar companion controls"
    ],
    links: [
      { label: "Architecture", href: "/docs/desktop/architecture" },
      { label: "Agent workflows", href: "/docs/desktop/agent-workflows" },
      { label: "Operating guide", href: "/docs/desktop/operating-guide" }
    ]
  },
  {
    title: "Anvil Registry",
    repoName: "anvil-registry",
    eyebrow: "npm policy gateway",
    description:
      "A TypeScript registry gateway that proxies npm metadata and tarballs, evaluates deterministic policy, queues package analysis, caches artefacts, and records decisions before installs reach developers or CI.",
    boundary: "Owns dependency ingress, policy decisions, analysis, cache identity, and override audit.",
    status: "Rough alpha for local trials, security review, early CI experiments, and contribution work.",
    icon: PackageCheck,
    image: "/hero-anvil.png",
    imageAlt: "Anvil Registry concept showing package artefacts passing through policy checks.",
    href: "/docs/registry/introduction",
    repoHref: registryRepositoryUrl,
    command: "npm config set registry http://localhost:4873",
    points: [
      "npm-compatible Fastify gateway for metadata, tarballs, audit, and scoped upstreams",
      "Worker-backed static analysis, provenance signals, and optional LLM review context",
      "Postgres, object storage, queue adapters, Admin UI, CLI, Docker Compose, and SST",
      "Explicit audited overrides, quarantine/block decisions, and developer explain output"
    ],
    links: [
      { label: "Architecture", href: "/docs/registry/architecture" },
      { label: "Policy", href: "/docs/registry/policy" },
      { label: "Rollout guide", href: "/docs/registry/rollout-guide" }
    ]
  },
  {
    title: "Anvil Cloud",
    repoName: "anvil-cloud",
    eyebrow: "Inspectable app runtime",
    description:
      "A local-first TypeScript platform for Anvil Cells: small deployable app units with explicit capabilities, shared runtime request contracts, generated manifests, local inspection, and adapter-driven deployment.",
    boundary: "Owns the Cell contract, runtime, builder, local server, generated client, CLI, and deployment adapter boundary.",
    status: "v0 implementation exists across runtime, builder, local, client, CLI, and AWS preview packages.",
    icon: Cloud,
    image: "/hero-anvil.png",
    imageAlt: "Anvil Cloud concept showing runtime, manifest, and adapter boundaries.",
    href: "/docs/cloud/overview",
    repoHref: cloudRepositoryUrl,
    command: "anvil check --json",
    points: [
      "Object-based Cell DSL for app, schema, query, mutation, endpoint, and job definitions",
      "Shared RuntimeRequest and RuntimeHost model for local, tests, and adapters",
      "Builder pipeline for import policy, typecheck, bundle, manifest, and generated client output",
      "Local runtime plus AWS preview adapter with CloudFormation synthesis and optional provisioning"
    ],
    links: [
      { label: "Cell contract", href: "/docs/cloud/cell-contract" },
      { label: "Builder and Guard", href: "/docs/cloud/builder-and-guard" },
      { label: "AWS preview", href: "/docs/cloud/aws-preview" }
    ]
  },
  {
    title: "Anvil Node Base",
    repoName: "anvil-registry/devcontainer-base",
    eyebrow: "Hardened Node image",
    description:
      "A Node 22 devcontainer base image for safer installs. Safe mode disables lifecycle scripts; observed mode runs them deliberately while writing inspectable reports.",
    boundary: "Owns the install execution harness for unfamiliar Node repositories.",
    status: "Part of the Anvil Registry repo and documented as a companion safety surface.",
    icon: Boxes,
    image: "/site-concept.png",
    imageAlt: "Anvil Node Base concept for safer dependency installs in a container.",
    href: "/docs/node-base/overview",
    repoHref: registryRepositoryUrl,
    command: "anvil-npm-ci-safe",
    points: [
      "Non-root container default for local and CI install checks",
      "Safe mode runs npm ci with lifecycle scripts disabled",
      "Observed mode records process, network, filesystem, and lifecycle evidence",
      "Reports can stay local or be submitted back to Anvil Registry"
    ],
    links: [
      { label: "Safe mode", href: "/docs/node-base/safe-mode" },
      { label: "Observed mode", href: "/docs/node-base/observed-mode" },
      { label: "Reports", href: "/docs/node-base/reports" }
    ]
  }
];

export const productCards = productLines;

export const repoComparison = [
  {
    repo: "anvil-app",
    product: "Anvil Desktop",
    owns: "Local developer workflow orchestration",
    firstFiles: "src/main, src/preload, src/shared, src/renderer",
    usefulWhen: "A change needs repo context, review evidence, work item context, or local companion controls."
  },
  {
    repo: "anvil-registry",
    product: "Anvil Registry and Node Base",
    owns: "npm dependency ingress and install execution safety",
    firstFiles: "apps/gateway, apps/worker, apps/admin, apps/cli, packages, devcontainer-base",
    usefulWhen: "Installs need policy, caching, analysis, quarantine, overrides, reports, or safer container execution."
  },
  {
    repo: "anvil-cloud",
    product: "Anvil Cloud",
    owns: "Cell runtime contracts and adapter deployment",
    firstFiles: "packages/runtime, packages/builder, packages/local, packages/client, packages/cli, packages/aws",
    usefulWhen: "A small app should be authorable locally, inspectable by agents, and deployable through an adapter boundary."
  }
];

export const proofPoints = [
  {
    title: "Local facts first",
    description:
      "Desktop workflows start from local checkouts, branch state, typed IPC boundaries, SQLite state, Git, PTYs, and explicit connector configuration.",
    icon: LockKeyhole
  },
  {
    title: "Policy beats theatre",
    description:
      "Registry decisions come from deterministic package metadata, static findings, provenance, popularity, overrides, and cached immutable identities.",
    icon: ClipboardCheck
  },
  {
    title: "Runtime contracts stay small",
    description:
      "Cloud Cells use a constrained app contract. Provider SDKs and infrastructure authoring belong in adapters, not app code.",
    icon: Braces
  },
  {
    title: "Agents help, they do not govern",
    description:
      "Codex and LLM workflows can plan, implement, review, and explain. The authority still comes from repo evidence, deterministic gates, and human review.",
    icon: MessageSquareText
  },
  {
    title: "Docs are part of the product",
    description:
      "The public site is markdown-first so architecture, setup, limits, and status can be reviewed in Git with the code.",
    icon: BadgeCheck
  }
];

export const desktopWorkflow = [
  { title: "Index repos", body: "Start with local checkouts, module summaries, branch state, and architecture context." },
  { title: "Run the session", body: "Plan, implement, investigate, review, or hand over with workspace context attached." },
  { title: "Verify the change", body: "Use Git, tests, code review, security review, dependency checks, CI, docs, and diagrams where risk calls for it." },
  { title: "Leave evidence", body: "Ship with findings, checks, unresolved risk, and handover notes a teammate can use without archaeology." }
];

export const registryWorkflow = [
  { title: "Route installs", body: "Point npm-compatible clients or CI at the gateway." },
  { title: "Analyze packages", body: "Cache metadata and tarballs, queue static analysis, and evaluate policy against immutable identities." },
  { title: "Review decisions", body: "Inspect allow, warn, quarantine, block, LLM context, and override history with the reason attached." },
  { title: "Harden unknown repos", body: "Use Node Base safe or observed mode when install execution needs a container with receipts." }
];

export const cloudWorkflow = [
  { title: "Define a Cell", body: "Use app, query, mutation, endpoint, job, and table definitions with declared capabilities." },
  {
    title: "Run locally",
    body: "Start Anvil Local, then inspect manifest, auth, logs, and local database state before deployment."
  },
  { title: "Validate and build", body: "Run import policy, typecheck, bundle, manifest extraction, and generated client output through the builder." },
  {
    title: "Preview through adapters",
    body: "Use AWS preview to synthesize a plan and CloudFormation template, and provision only when the required environment is configured."
  }
];

export const docsProductGuides = [
  {
    product: "Anvil Desktop",
    repoName: "anvil-app",
    icon: Terminal,
    href: "/docs/desktop/overview",
    description:
      "Architecture, setup, agent sessions, work items, review, security, integrations, persistence, companion controls, and release notes.",
    links: [
      { label: "Overview", href: "/docs/desktop/overview" },
      { label: "Architecture", href: "/docs/desktop/architecture" },
      { label: "Agent workflows", href: "/docs/desktop/agent-workflows" },
      { label: "Security and review", href: "/docs/desktop/security-and-review" }
    ]
  },
  {
    product: "Anvil Registry",
    repoName: "anvil-registry",
    icon: PackageCheck,
    href: "/docs/registry/introduction",
    description:
      "Gateway architecture, local stack, package decisions, policy configuration, CLI, Admin API, LLM review, CI, deployment, and alpha limits.",
    links: [
      { label: "Introduction", href: "/docs/registry/introduction" },
      { label: "Quickstart", href: "/docs/registry/quickstart" },
      { label: "Architecture", href: "/docs/registry/architecture" },
      { label: "Rollout guide", href: "/docs/registry/rollout-guide" }
    ]
  },
  {
    product: "Anvil Cloud",
    repoName: "anvil-cloud",
    icon: Cloud,
    href: "/docs/cloud/overview",
    description:
      "Cell contract, RuntimeRequest model, RuntimeHost boundary, local runtime, builder, Guard checks, CLI, generated client, AWS preview adapter, and v0 limits.",
    links: [
      { label: "Overview", href: "/docs/cloud/overview" },
      { label: "Cell contract", href: "/docs/cloud/cell-contract" },
      { label: "Local runtime", href: "/docs/cloud/local-runtime" },
      { label: "AWS preview", href: "/docs/cloud/aws-preview" }
    ]
  },
  {
    product: "Anvil Node Base",
    repoName: "anvil-registry/devcontainer-base",
    icon: Boxes,
    href: "/docs/node-base/overview",
    description:
      "Safe installs, observed lifecycle-script execution, reports, strict gates, and how Node Base feeds evidence back to Anvil Registry.",
    links: [
      { label: "Overview", href: "/docs/node-base/overview" },
      { label: "Safe mode", href: "/docs/node-base/safe-mode" },
      { label: "Observed mode", href: "/docs/node-base/observed-mode" },
      { label: "Reports", href: "/docs/node-base/reports" }
    ]
  }
];

export const docsHighlights = [
  {
    label: "Start here",
    href: "/docs/overview",
    icon: Hammer,
    description: "Choose Desktop, Registry, Node Base, or Cloud from the repo and workflow you actually need."
  },
  {
    label: "Repository map",
    href: "/docs/project/repositories",
    icon: GitBranch,
    description: "See which repo owns which product surface, where to look first, and how the projects fit together."
  },
  {
    label: "Desktop architecture",
    href: "/docs/desktop/architecture",
    icon: Code2,
    description: "Follow the Electron main, preload, shared IPC, renderer, SQLite, and service-layer boundaries."
  },
  {
    label: "Desktop agent workflows",
    href: "/docs/desktop/agent-workflows",
    icon: Workflow,
    description: "Run planning, implementation, review, security, documentation, BA, and handover sessions with evidence."
  },
  {
    label: "Registry quickstart",
    href: "/docs/registry/quickstart",
    icon: Command,
    description: "Run the gateway locally, route package manager traffic through it, and inspect package decisions."
  },
  {
    label: "Registry policy",
    href: "/docs/registry/policy",
    icon: Network,
    description: "Read how metadata, provenance, static findings, popularity, analysis, and overrides shape decisions."
  },
  {
    label: "Cloud Cell contract",
    href: "/docs/cloud/cell-contract",
    icon: Braces,
    description: "Understand app, schema, query, mutation, endpoint, job, capability, and generated manifest shapes."
  },
  {
    label: "Cloud CLI",
    href: "/docs/cloud/cli-reference",
    icon: Route,
    description: "Use anvil new, dev, check, build, inspect, logs, db, and deploy preview with stable JSON output."
  },
  {
    label: "Node Base reports",
    href: "/docs/node-base/reports",
    icon: FileSearch,
    description: "Inspect safe and observed install reports, submit them to the registry, and wire them into CI gates."
  },
  {
    label: "Open source posture",
    href: "/docs/project/open-source",
    icon: GitPullRequestArrow,
    description: "The scope boundaries, alpha notes, and anti-vendor-sludge position behind the project."
  },
  {
    label: "Contributing",
    href: "/docs/project/contributing",
    icon: GitPullRequestArrow,
    description: "Development setup, commit style, and review expectations across the Anvil repo family."
  }
];

export const codeTabs = [
  {
    label: "Desktop",
    command: "$ pnpm dev",
    output: ["Electron app starts", "Repositories index locally", "Agent sessions keep workspace context", "Review and handover evidence stays inspectable"]
  },
  {
    label: "Registry",
    command: "$ anvil explain left-pad@1.3.0",
    output: ["Decision: allow", "Policy: default@2026-05", "Provenance: verified", "Signals: no high-confidence findings", "Cache identity: sha512-Qw8...Yjm"]
  },
  {
    label: "Cloud",
    command: "$ anvil check --json",
    output: ["Config: valid", "Import policy: pass", "Typecheck: pass", "Manifest extraction: pass", "Build-ready: true"]
  },
  {
    label: "Node Base",
    command: "$ anvil-npm-ci-observed",
    output: ["Scripts enabled under observation", "Lifecycle report written", "Network access recorded", "Strict mode: pass"]
  }
];

export type IconType = typeof Hammer;
