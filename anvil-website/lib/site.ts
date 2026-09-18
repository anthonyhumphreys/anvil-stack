import {
  BadgeCheck,
  Boxes,
  Braces,
  ClipboardCheck,
  Cloud,
  Code2,
  Command,
  Cpu,
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

export const githubRepositoryUrl = "https://github.com/anthonyhumphreys/anvil-stack";

export const latestDesktopDmgUrl =
  "https://github.com/anthonyhumphreys/anvil-stack/releases/latest/download/Anvil-latest-arm64.dmg";

export const navItems = [
  { label: "Products", href: "/#products" },
  { label: "Docs", href: "/docs" },
  { label: "Sync", href: "/sync" },
  { label: "Pricing", href: "/pricing" }
];

// Sync & Mesh is a capability layer, not a fifth product: it is how the
// Anvil tools you already run stay in step across every machine you own.
export const syncLayer = {
  title: "Sync & Mesh",
  tagline: "The account layer that keeps your machines in step.",
  description:
    "Workspace definitions, templates, agents, and settings replicate between your devices as sealed envelopes — encrypted on your device, relayed as ciphertext, opened only where you paired it. Enrolled machines can also pick up jobs and hand running sessions to each other. The backend is a relay you choose, not a computer you rent.",
  docsHref: "/docs/sync/overview",
  detailHref: "/sync"
};

export const syncMoves = [
  {
    title: "Sealed on your device",
    body: "Every synced entity is encrypted with AES-256-GCM under a versioned account key before it leaves the outbox. The key lives on your devices — the backend never sees it.",
    proof: "sealed · aes-256-gcm"
  },
  {
    title: "Relayed, never read",
    body: "The backend journals ciphertext and coordinates delivery. It sees ids, types, revisions, sizes, and timing — the shape of your sync, never the content.",
    proof: "shape, not content"
  },
  {
    title: "Resumed anywhere",
    body: "Paired machines claim mesh jobs and accept session handoffs. A run that starts on your laptop can resume on your workstation from a sealed checkpoint.",
    proof: "checkpoint · handoff"
  }
];

export const syncModes = [
  {
    mode: "Local only",
    body: "Nothing leaves the device. Any remembered backend stays paused, not forgotten.",
    cost: "Free — the default"
  },
  {
    mode: "Anvil-hosted",
    body: "The operated backend: sign in once, pair devices, done. Preview is free through 31 October 2026.",
    cost: "Free in preview"
  },
  {
    mode: "Your Cloudflare",
    body: "Deploy the open-source backend to your own Workers account with anvil-cloud mesh apply.",
    cost: "Your infra bill"
  },
  {
    mode: "Compatible backend",
    body: "Point at any URL implementing the frozen Sync v1 contract — proven with the shipped conformance suite.",
    cost: "Free — it is yours"
  }
];

export const hostedUpsell = {
  title: "Anvil-hosted, if you would rather not run it",
  body: "The same Sync v1 backend, operated for you: WorkOS sign-in, device management and billing on the web, artifact storage in R2, and someone else paged at 3am. Free through the preview ending 31 October 2026; paid enforcement starts 1 November 2026. Self-host stays free forever — that is the point of the contract being open.",
  cta: "See hosted sync",
  href: "/sync"
};

// The docs landing for /docs/sync — Sync & Mesh is a capability layer, so it
// stays out of productLines (the product grids) but needs the same model.
export const syncDocsProduct = {
  id: "sync",
  title: "Anvil Sync & Mesh",
  repoName: "anvil-app/ + anvil-cloud/",
  eyebrow: "Account layer",
  description:
    "The account layer that keeps the Anvil tools you already run in step across every machine you own. Entities replicate as sealed envelopes, enrolled devices claim mesh jobs, and running sessions hand off between machines — through a backend you choose.",
  boundary:
    "Owns account identity, device enrollment, sealed entity replication, mesh job coordination, artifact shares, and session handoff.",
  status:
    "Alpha: implemented end to end and rehearsed on real deployments; hosted provisioning is still finishing, so Anvil-hosted renders disabled in this desktop build.",
  icon: Network,
  href: "/docs/sync/overview",
  repoHref: githubRepositoryUrl,
  command: "anvil-cloud mesh apply",
  points: [
    "End-to-end encrypted sync of workspaces, templates, agents, and approved settings",
    "X25519 device identities enrolled through single-use pair codes",
    "Mesh jobs claimed by your own machines — compute and credentials never leave them",
    "Session handoff moves a run between devices through sealed checkpoints",
    "Artifact share links decrypt in the browser; the key lives in the URL fragment",
    "Four backends: local-only, Anvil-hosted, your Cloudflare, or any conformant server"
  ],
  links: [
    { label: "Encryption and keys", href: "/docs/sync/encryption" },
    { label: "Mesh jobs", href: "/docs/sync/mesh-jobs" },
    { label: "Self-deploy", href: "/docs/sync/self-deploy" },
    { label: "Status and limits", href: "/docs/sync/status-and-limits" }
  ]
};

export const accountNavItems = [
  { label: "Overview", href: "/account" },
  { label: "Billing", href: "/account/billing" },
  { label: "Devices", href: "/account/devices" },
  { label: "Security", href: "/account/security" },
  { label: "Data", href: "/account/data" }
];

export const productLines = [
  {
    id: "desktop",
    title: "Anvil Desktop",
    repoName: "anvil-app/",
    eyebrow: "Local agent workspace",
    description:
      "A chat-first Electron app for running agent workflows on your own repos. It keeps conversations, repositories, work items, Git state, reviews, terminals, and handover evidence together while active work continues across workspace switches.",
    boundary: "Owns local workflow orchestration and evidence capture.",
    status: "Active desktop app with main, preload, shared IPC, and React renderer surfaces.",
    icon: Terminal,
    image: "/anvil-app-homepage.png",
    imageAlt: "Anvil Desktop showing repository navigation and an agent chat workspace.",
    href: "/docs/desktop/overview",
    repoHref: desktopRepositoryUrl,
    downloadHref: latestDesktopDmgUrl,
    downloadLabel: "macOS Apple Silicon DMG",
    command: "pnpm dev",
    points: [
      "Local Electron shell with SQLite persistence and typed IPC boundaries",
      "Chat-first workspace with focused navigation, thread history, and cross-workspace activity indicators",
      "Cross-provider workflow teams with bounded delegation, persisted handoffs, and human decisions",
      "Change review binds acceptance to source snapshots, criteria, screenshots, and replay traces",
      "Dojo analytics and coaching connect agent activity to evidence-linked prompt and skill recommendations",
      "Optional Apple Foundation Models routing for short on-device helper prompts",
      "Workspace terminals reattach with buffered output while the desktop process is running",
      "Desktop notifications open the exact thread waiting for approval or input, or ready after completion",
      "Mobile, Raycast, watch, widget, and menu bar companion controls"
    ],
    links: [
      { label: "Architecture", href: "/docs/desktop/architecture" },
      { label: "Workflow teams", href: "/docs/desktop/workflow-graphs" },
      { label: "Operating guide", href: "/docs/desktop/operating-guide" }
    ]
  },
  {
    id: "registry",
    title: "Anvil Registry",
    repoName: "anvil-registry/",
    eyebrow: "npm policy gateway",
    description:
      "A TypeScript registry gateway that proxies npm metadata and tarballs, evaluates deterministic policy, queues package analysis, caches artefacts, and records decisions before installs reach developers or CI.",
    boundary: "Owns dependency ingress, policy decisions, analysis, cache identity, and override audit.",
    status: "Alpha for local trials, security review, early CI experiments, and contribution work.",
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
    id: "cloud",
    title: "Anvil Cloud",
    repoName: "anvil-cloud/",
    eyebrow: "Portable app runtime",
    description:
      "A local-first TypeScript platform for Anvil Cells and contract-first Agents: small runtime units with explicit capabilities, generated manifests, local inspection, approval gates, and adapter-driven deployment.",
    boundary:
      "Owns the Cell contract, Agent contract, runtime, auth, builder, local server, Lens, generated client, CLI, and deployment adapter boundary.",
    status:
      "Alpha implementation spans runtime, agents, auth, workflows, services, Lens, builder, local, client, CLI, and AWS preview packages.",
    icon: Cloud,
    image: "/hero-anvil.png",
    imageAlt: "Anvil Cloud concept showing runtime, manifest, and adapter boundaries.",
    href: "/docs/cloud/overview",
    repoHref: cloudRepositoryUrl,
    command: "anvil-cloud check --json",
    points: [
      "Cell DSL for queries, mutations, endpoints, jobs, durable workflows, supervised services, and mounted agents",
      "Contract-first Anvil Agents with capabilities, approvals, provider-neutral manifests, local stub inference, and AWS Bedrock provider support",
      "Agent Sandbox contract and AWS Lambda MicroVM provider for sandbox-required, sessionful agent workspaces",
      "Real auth: declarative per-handler access control, a local IdP signing real JWTs, OIDC providers by config",
      "Builder pipeline for import policy, typecheck, bundle, manifest, generated client output, and agent validation",
      "Anvil Lens local management UI plus an AWS preview adapter with CloudFormation synthesis"
    ],
    links: [
      { label: "Cell contract", href: "/docs/cloud/cell-contract" },
      { label: "Agents", href: "/docs/cloud/agents" },
      { label: "Agent Sandboxes", href: "/docs/cloud/agent-sandboxes" },
      { label: "Auth", href: "/docs/cloud/auth" },
      { label: "Workflows", href: "/docs/cloud/workflows" }
    ]
  },
  {
    id: "node-base",
    title: "Anvil Node Base",
    repoName: "anvil-registry/devcontainer-base/",
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
    repo: "anvil-app/",
    product: "Anvil Desktop",
    owns: "Local developer workflow orchestration",
    firstFiles: "src/main, src/preload, src/shared, src/renderer",
    usefulWhen: "A change needs repo context, review evidence, work item context, or local companion controls."
  },
  {
    repo: "anvil-registry/",
    product: "Anvil Registry and Node Base",
    owns: "npm dependency ingress and install execution safety",
    firstFiles: "apps/gateway, apps/worker, apps/admin, apps/cli, packages, devcontainer-base",
    usefulWhen: "Installs need policy, caching, analysis, quarantine, overrides, reports, or safer container execution."
  },
  {
    repo: "anvil-registry/devcontainer-base/",
    product: "Anvil Node Base",
    owns: "Safer Node dependency installation",
    firstFiles: "Dockerfile, scripts, README.md",
    usefulWhen: "An unknown repo needs npm installs with lifecycle scripts disabled or observed inside a container."
  },
  {
    repo: "anvil-cloud/",
    product: "Anvil Cloud",
    owns: "Cell runtime contracts and adapter deployment",
    firstFiles: "packages/runtime, packages/builder, packages/local, packages/client, packages/cli, packages/aws",
    usefulWhen:
      "A small app or capability-bound agent should be authorable locally, inspectable before deployment, and deployable through an adapter boundary."
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
      "Cloud Cells and Agents use constrained contracts. Provider SDKs and infrastructure authoring belong in adapters, not app code.",
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
  { title: "Run the conversation", body: "Plan, implement, investigate, review, or hand over in the chat-first workspace with repository context attached." },
  { title: "Verify the change", body: "Use Git, tests, code review, security review, dependency checks, CI, docs, and diagrams where risk calls for it." },
  { title: "Follow active work", body: "Switch workspaces without losing running chat or terminal activity, then return through the activity centre or a desktop notification." },
  { title: "Leave evidence", body: "Ship with findings, checks, unresolved risk, and handover notes a teammate can use without archaeology." }
];

export const registryWorkflow = [
  { title: "Route installs", body: "Point npm-compatible clients or CI at the gateway." },
  { title: "Analyze packages", body: "Cache metadata and tarballs, queue static analysis, and evaluate policy against immutable identities." },
  { title: "Review decisions", body: "Inspect allow, warn, quarantine, block, LLM context, and override history with the reason attached." },
  { title: "Harden unknown repos", body: "Use Node Base safe or observed mode when install execution needs a container with receipts." }
];

export const cloudWorkflow = [
  {
    title: "Define a Cell or Agent",
    body: "Use app, query, mutation, endpoint, job, table, and defineAgent definitions with declared capabilities."
  },
  {
    title: "Run locally",
    body: "Start Anvil Local, then inspect manifest, agents, auth, logs, and local database state before deployment."
  },
  {
    title: "Validate and build",
    body: "Run import policy, typecheck, bundle, manifest extraction, agent validation, and generated client output through the builder."
  },
  {
    title: "Preview through adapters",
    body: "Use AWS preview to synthesize a plan and CloudFormation template, and provision only when the required environment is configured."
  }
];

export const docsProductGuides = [
  {
    product: "Anvil Desktop",
    repoName: "anvil-app/",
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
    repoName: "anvil-registry/",
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
    repoName: "anvil-cloud/",
    icon: Cloud,
    href: "/docs/cloud/overview",
    description:
      "Cell contract, Anvil Agents, Agent Sandboxes, auth, durable workflows, supervised services, local runtime, Anvil Lens, builder, Guard checks, CLI, generated client, AWS preview adapter, and alpha limits.",
    links: [
      { label: "Quickstart", href: "/docs/cloud/quickstart" },
      { label: "Agents", href: "/docs/cloud/agents" },
      { label: "Agent Sandboxes", href: "/docs/cloud/agent-sandboxes" },
      { label: "Auth", href: "/docs/cloud/auth" },
      { label: "Workflows", href: "/docs/cloud/workflows" }
    ]
  },
  {
    product: "Anvil Node Base",
    repoName: "anvil-registry/devcontainer-base/",
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
    description: "Choose Desktop, Sync & Mesh, Registry, Node Base, or Cloud from the project and workflow you actually need."
  },
  {
    label: "Sync & Mesh overview",
    href: "/docs/sync/overview",
    icon: Network,
    description: "Sealed sync across devices, mesh jobs on your own machines, and a backend you choose."
  },
  {
    label: "Encryption and keys",
    href: "/docs/sync/encryption",
    icon: LockKeyhole,
    description: "How entities seal under a versioned account key, how devices share it, and what the server sees."
  },
  {
    label: "Monorepo map",
    href: "/docs/project/repositories",
    icon: GitBranch,
    description: "See which project directory owns which product surface, where to look first, and how the pieces fit together."
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
    label: "Mesh jobs",
    href: "/docs/sync/mesh-jobs",
    icon: Cpu,
    description: "Dispatch work to your own enrolled machines with pinned manifests and streamed attempts."
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
    icon: ClipboardCheck,
    description: "Read how metadata, provenance, static findings, popularity, analysis, and overrides shape decisions."
  },
  {
    label: "Cloud Cell contract",
    href: "/docs/cloud/cell-contract",
    icon: Braces,
    description: "Understand app, schema, query, mutation, endpoint, job, capability, and generated manifest shapes."
  },
  {
    label: "Self-deploy the backend",
    href: "/docs/sync/self-deploy",
    icon: Route,
    description: "Run the Sync v1 backend on your own Cloudflare account with anvil-cloud mesh plan and apply."
  },
  {
    label: "Open source posture",
    href: "/docs/project/open-source",
    icon: GitPullRequestArrow,
    description: "The scope boundaries, alpha notes, and anti-vendor-sludge position behind the project."
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
    command: "$ anvil-registry explain left-pad@1.3.0",
    output: ["Decision: allow", "Policy: default@2026-05", "Provenance: verified", "Signals: no high-confidence findings", "Cache identity: sha512-Qw8...Yjm"]
  },
  {
    label: "Cloud",
    command: "$ anvil-cloud check --json",
    output: ["Config: valid", "Import policy: pass", "Typecheck: pass", "Agent manifests: valid", "Build-ready: true"]
  },
  {
    label: "Node Base",
    command: "$ anvil-npm-ci-observed",
    output: ["Scripts enabled under observation", "Lifecycle report written", "Network access recorded", "Strict mode: pass"]
  }
];

export type IconType = typeof Hammer;
