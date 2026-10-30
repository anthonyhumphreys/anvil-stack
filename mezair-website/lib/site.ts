import {
  Boxes,
  Cloud,
  Code2,
  Cpu,
  Factory,
  GitBranch,
  Compass,
  LockKeyhole,
  Network,
  PackageCheck,
  Route,
  Terminal,
  Workflow
} from "lucide-react";

const repoTree = "https://github.com/anthonyhumphreys/mezair-stack/tree/main";

export const githubRepositoryUrl = "https://github.com/anthonyhumphreys/mezair-stack";
export const docsSourceUrl = `${githubRepositoryUrl}/blob/main/mezair-website/content/docs`;
export const repositoryUrl = "/docs/project/repositories";

export const desktopRepositoryUrl = process.env.NEXT_PUBLIC_MEZAIR_APP_REPO_URL || `${repoTree}/mezair-app`;
export const registryRepositoryUrl =
  process.env.NEXT_PUBLIC_MEZAIR_REGISTRY_REPO_URL || `${repoTree}/mezair-registry`;
export const cloudRepositoryUrl = process.env.NEXT_PUBLIC_MEZAIR_CLOUD_REPO_URL || `${repoTree}/mezair-cloud`;

export const releasesUrl = "https://github.com/anthonyhumphreys/mezair-stack/releases/latest";

export const latestDesktopDmgUrl =
  "https://github.com/anthonyhumphreys/mezair-stack/releases/latest/download/Mezair-latest-arm64.dmg";

/** Shared beta wording for LAN-first Mesh and user-definable software factories. */
export const featureBeta = {
  endDate: "30 November 2026",
  endDateIso: "2026-11-30",
  label: "Beta through 30 November 2026"
} as const;

/** Agent providers Mezair Desktop can drive today (mezair-app/src/shared/agent-providers.ts). */
export const desktopProviders = ["Codex", "Cursor", "Devin", "OpenAI", "Azure OpenAI", "LLMGateway"] as const;

export type ProductId = "desktop" | "sync" | "registry" | "node-base" | "cloud";

export type Product = {
  id: ProductId;
  title: string;
  shortTitle: string;
  repoName: string;
  /** One line a newcomer understands without context. */
  tagline: string;
  description: string;
  /** What this project is responsible for, so the boundaries stay clear. */
  boundary: string;
  /** Honest, one-sentence state of the project today. */
  status: string;
  statusLabel: string;
  icon: typeof Terminal;
  href: string;
  startHref: string;
  startLabel: string;
  repoHref: string;
  command: string;
  points: string[];
  links: Array<{ label: string; href: string }>;
};

export const desktop: Product = {
  id: "desktop",
  title: "Mezair Desktop",
  shortTitle: "Desktop",
  repoName: "mezair-app/",
  tagline: "A desktop app for running coding agents on your own repos.",
  description:
    "Mezair Desktop gives each repo a workspace where you plan with an agent, watch it work, and review every change before you keep it. The app runs locally and connects to Codex, Cursor, Devin, OpenAI, Azure OpenAI or LLMGateway with your own provider account. No Mezair account is needed for local use.",
  boundary:
    "Runs your local workflow: repositories, agent sessions, terminals, reviews and the notes you hand on with finished work.",
  status: `In active development. Builds for macOS (Apple silicon), Windows and Linux ship from GitHub releases. User-definable software factories are in beta through ${featureBeta.endDate}.`,
  statusLabel: "In development",
  icon: Terminal,
  href: "/docs/desktop",
  startHref: "/docs/desktop/installation",
  startLabel: "Install Mezair Desktop",
  repoHref: desktopRepositoryUrl,
  command: "pnpm dev",
  points: [
    "Run Codex, Cursor, Devin, OpenAI, Azure OpenAI or LLMGateway against a real checkout",
    "Review diffs, test runs and security findings before you accept a change",
    "Threads and terminals keep running while you switch workspaces",
    "Work items, automations and multi-agent workflows with a human sign-off",
    `User-definable software factories (beta through ${featureBeta.endDate}): take labelled GitHub issues to verified, confirmed merges under a policy you activate`,
    "Notifications take you to the exact thread that is waiting for you",
    "Companion controls for iPhone, Apple Watch, Raycast and the menu bar"
  ],
  links: [
    { label: "Install", href: "/docs/desktop/installation" },
    { label: "Agent workflows", href: "/docs/desktop/agent-workflows" },
    { label: "Software factories", href: "/docs/desktop/software-factories" },
    { label: "Architecture", href: "/docs/desktop/architecture" }
  ]
};

export const sync: Product = {
  id: "sync",
  title: "Mezair Sync & Mesh",
  shortTitle: "Sync & Mesh",
  repoName: "mezair-app/ + mezair-cloud/",
  tagline: "Encrypted sync and remote jobs across your machines.",
  description:
    "Sync carries your workspaces, templates, custom agents and settings between machines, encrypted on the device before anything leaves it. Mesh lets one machine send work to another, and you can move a running session to a different machine when you get up from your desk.",
  boundary:
    "Handles your account, paired devices, encrypted sync, jobs sent between your machines, share links and session handoff.",
  status: `Beta through ${featureBeta.endDate}, including LAN-first Mesh routing. It runs on backends you deploy yourself, and Mezair hosting is invite-only during the beta. Paid hosted plans are not on sale yet.`,
  statusLabel: "Beta",
  icon: Network,
  href: "/docs/sync",
  startHref: "/docs/sync/overview",
  startLabel: "Read how Sync works",
  repoHref: githubRepositoryUrl,
  command: "mezair-cloud mesh apply",
  points: [
    "Workspaces stay local until you turn Sync on for them",
    "Synced workspace contents are encrypted on your device; the server never has the key",
    "Workspace Sync excludes repository files, credentials and chat transcripts",
    "Send a job to another machine; it runs there at the exact commit you pinned",
    `LAN-first Mesh (beta through ${featureBeta.endDate}): the host's LAN address first, then other private routes, HTTPS and managed ingress`,
    "Move a session to another machine with its progress encrypted in transit",
    "Share links decrypt in the recipient's browser"
  ],
  links: [
    { label: "Encryption and keys", href: "/docs/sync/encryption" },
    { label: "Mesh jobs", href: "/docs/sync/mesh-jobs" },
    { label: "LAN-first routes", href: "/docs/sync/lan-first-routes" },
    { label: "Run your own backend", href: "/docs/sync/self-deploy" },
    { label: "Status and limits", href: "/docs/sync/status-and-limits" }
  ]
};

export const registry: Product = {
  id: "registry",
  title: "Mezair Registry",
  shortTitle: "Registry",
  repoName: "mezair-registry/",
  tagline: "An npm gateway that checks packages before they reach you.",
  description:
    "Mezair Registry sits between npm and your developers or CI. It applies your policy to every package, analyses new versions, caches what it allows and records why it decided.",
  boundary:
    "Decides which npm packages get in: policy, analysis, caching and a record of every override.",
  status: "Alpha. Good for local trials, security reviews and early CI experiments.",
  statusLabel: "Alpha",
  icon: PackageCheck,
  href: "/docs/registry",
  startHref: "/docs/registry/quickstart",
  startLabel: "Run it locally",
  repoHref: registryRepositoryUrl,
  command: "npm config set registry http://localhost:4873",
  points: [
    "Works with npm, pnpm and Yarn as a drop-in registry URL",
    "Policy decides; optional LLM review only explains the evidence",
    "Quarantine, block and audited overrides, with reasons attached",
    "Admin UI, CLI, Docker Compose and an SST deployment"
  ],
  links: [
    { label: "Quickstart", href: "/docs/registry/quickstart" },
    { label: "Policy", href: "/docs/registry/policy" },
    { label: "Rollout guide", href: "/docs/registry/rollout-guide" }
  ]
};

export const nodeBase: Product = {
  id: "node-base",
  title: "Mezair Node Base",
  shortTitle: "Node Base",
  repoName: "mezair-registry/devcontainer-base/",
  tagline: "A Node container for installing code you don't trust yet.",
  description:
    "A Node 22 devcontainer image for unfamiliar repos. Safe mode installs with lifecycle scripts switched off. Observed mode lets them run and writes down what they did.",
  boundary: "Runs installs for repos you haven't vetted, and reports what happened.",
  status: "Ships inside the Mezair Registry repo as a companion tool.",
  statusLabel: "Companion tool",
  icon: Boxes,
  href: "/docs/node-base",
  startHref: "/docs/node-base/safe-mode",
  startLabel: "Try safe mode",
  repoHref: registryRepositoryUrl,
  command: "mezair-npm-ci-safe",
  points: [
    "Runs as a non-root user by default",
    "Safe mode: npm ci with lifecycle scripts disabled",
    "Observed mode: records processes, network, files and scripts",
    "Keep reports locally or send them to Mezair Registry"
  ],
  links: [
    { label: "Safe mode", href: "/docs/node-base/safe-mode" },
    { label: "Observed mode", href: "/docs/node-base/observed-mode" },
    { label: "Reports", href: "/docs/node-base/reports" }
  ]
};

export const cloud: Product = {
  id: "cloud",
  title: "Mezair Cloud",
  shortTitle: "Cloud",
  repoName: "mezair-cloud/",
  tagline: "Build an app backend in TypeScript, then choose where it runs.",
  description:
    "Define your app's data, API routes, background jobs and permissions in TypeScript. Run it locally without a cloud account, then review the resources it needs before deploying. Mezair calls each app a Cell. AWS deployment is in preview.",
  boundary:
    "Provides the backend tools for your own apps. It is separate from Desktop and the optional hosted Sync service.",
  status:
    "Alpha. The runtime, CLI and AWS preview work today. Hosted Mezair Cloud Agents isn't available yet.",
  statusLabel: "Alpha",
  icon: Cloud,
  href: "/docs/cloud",
  startHref: "/docs/cloud/quickstart",
  startLabel: "Follow the quickstart",
  repoHref: cloudRepositoryUrl,
  command: "mezair-cloud check --json",
  points: [
    "Read and update app data, expose API routes, and run background work",
    "Give agents explicit permissions and choose which actions need approval",
    "Test sign-in and access rules locally before connecting a hosted identity provider",
    "Inspect your app's configuration, logs and data in the local Lens dashboard",
    "Deploy plans you can read before anything is created"
  ],
  links: [
    { label: "Quickstart", href: "/docs/cloud/quickstart" },
    { label: "Cell contract", href: "/docs/cloud/cell-contract" },
    { label: "Agents", href: "/docs/cloud/agents" },
    { label: "AWS preview", href: "/docs/cloud/aws-preview" }
  ]
};

/** Everything in the stack, in the order a newcomer meets it. */
export const products: Product[] = [desktop, sync, registry, nodeBase, cloud];
/** The independent tools beside Desktop. */
export const companionProducts: Product[] = [registry, nodeBase, cloud];
export const productById = new Map(products.map((product) => [product.id, product]));

export const accountNavItems = [
  { label: "Overview", href: "/account" },
  { label: "Workspace", href: "/account/workspace" },
  { label: "Dashboard", href: "/account/dashboard" },
  { label: "Billing", href: "/account/billing" },
  { label: "Organisation", href: "/account/organizations" },
  { label: "Devices", href: "/account/devices" },
  { label: "Security", href: "/account/security" },
  { label: "Data", href: "/account/data" }
];

/** Where Sync & Mesh can keep your encrypted state. */
export const syncBackends = [
  {
    name: "Just this machine",
    body: "No workspace data goes to a Sync backend. No Mezair account needed. This is where every workspace starts.",
    cost: "Free"
  },
  {
    name: "Mezair-hosted",
    body: "We run the backend and keep it updated. Invite-only beta now; request access and redeem an invitation code. The Sync and Team plans are not on sale yet.",
    cost: "From £6 a month"
  },
  {
    name: "Your Cloudflare account",
    body: "Deploy the official backend with one command: mezair-cloud mesh apply.",
    cost: "Free, plus your Cloudflare bill"
  },
  {
    name: "Any compatible server",
    body: "Point Mezair at your own implementation. A conformance suite checks Sync today.",
    cost: "You run it"
  }
];

/** Temporary environments a Desktop workflow can ask for. */
export const agentEnvironments = [
  {
    provider: "AWS Lambda MicroVM",
    detail: "An isolated workspace in the AWS account you connect.",
    status: "Works today",
    href: "/docs/cloud/aws-preview"
  },
  {
    provider: "Cloudflare Sandbox",
    detail: "A sandbox provisioner you deploy to your Cloudflare account.",
    status: "Works today",
    href: "/docs/cloud/agent-sandboxes"
  },
  {
    provider: "Vercel Sandbox",
    detail: "Short-lived sandboxes in the Vercel account you connect.",
    status: "Works today",
    href: "/docs/cloud/agent-sandboxes"
  },
  {
    provider: "Mezair Cloud Agents",
    detail: "Machines we run for you, billed by use.",
    status: "Later",
    href: "/pricing#hosted-compute"
  }
] as const;

export type Plan = {
  id: "desktop" | "sync" | "team" | "self-host";
  name: string;
  price: string;
  cadence: string;
  annual?: string;
  summary: string;
  features: string[];
  cta: { label: string; href: string };
  /** An honest caveat shown under the features. */
  note?: string;
  featured?: boolean;
};

/**
 * Proposed paid pricing alongside the invite-only Sync & Mesh beta. These plans
 * are not on sale yet. Update the pricing page note if they change.
 */
export const plans: Plan[] = [
  {
    id: "desktop",
    name: "Desktop",
    price: "Free",
    cadence: "forever",
    summary: "The whole app, on your machine.",
    features: [
      "Codex, Cursor, Devin, OpenAI, Azure OpenAI and LLMGateway agents",
      "Review every change before you keep it",
      "Terminals, editor, work items and automations",
      "Repos and chat history stored locally",
      "Open source under the MIT licence"
    ],
    cta: { label: "Download for Mac", href: latestDesktopDmgUrl }
  },
  {
    id: "sync",
    name: "Sync",
    price: "£6",
    cadence: "a month",
    annual: "or £60 a year",
    summary: "Encrypted sync and Mesh jobs across your machines.",
    features: [
      "Everything in Desktop",
      "Encrypted sync of workspaces, templates, agents and settings",
      "Send jobs to your other machines with Mesh",
      "Hand a running session to another machine",
      "Encrypted share links, with 10 GB of storage",
      "Up to 5 devices"
    ],
    cta: { label: "Request beta access", href: "/waitlist" },
    featured: true
  },
  {
    id: "team",
    name: "Team",
    price: "£12",
    cadence: "per member a month",
    annual: "or £120 per member a year",
    summary: "Shared setups for people who work together.",
    features: [
      "Everything in Sync, for each member",
      "Share workspace templates and custom agents across your team",
      "Add and remove members, and see their devices",
      "One invoice for the organisation",
      "Up to 10 devices and 25 GB of share storage per member"
    ],
    note: "Minimum 5 members. Team sharing and device administration are planned features.",
    cta: { label: "Request beta access", href: "/waitlist" }
  },
  {
    id: "self-host",
    name: "Self-hosted",
    price: "Free",
    cadence: "you pay your host",
    summary: "Run the Sync & Mesh backend yourself.",
    features: [
      "The same open-source backend we run",
      "Deploys to your Cloudflare account with one command",
      "Your Sync data stays on the server you choose",
      "Community support on GitHub"
    ],
    cta: { label: "Read the self-host guide", href: "/docs/sync/self-deploy" }
  }
];

export const pricingFaqs = [
  {
    q: "Is Mezair Desktop really free?",
    a: "Yes. The app is open source and free to use for anything, with no account. You only pay if you want your work to follow you between machines through our hosted Sync."
  },
  {
    q: "When do the paid plans start?",
    a: "Paid signup opens after the invite-only beta. Request beta access; invited testers receive a code for time-limited access without a payment method. Self-hosting needs no Mezair subscription."
  },
  {
    q: "Why charge for Sync?",
    a: "Running encrypted sync, job routing and share storage costs money every month. Charging for the hosted service keeps the desktop app free and keeps the project going."
  },
  {
    q: "Do you see my code or chats?",
    a: "No. Workspace Sync excludes repository files, credentials and chat transcripts. What does sync is encrypted on your device with a key the server never has."
  },
  {
    q: "What about model and cloud costs?",
    a: "You bring your own accounts. OpenAI, Azure, AWS, Cloudflare and the rest bill you directly; Mezair doesn't add a margin."
  },
  {
    q: "Can I leave?",
    a: "Yes. You can export your synced settings and workspace definitions, move to your own backend, or delete your account. Exports are encrypted, so keep your account recovery key to restore them. Your repos and local chat history stay on your machines."
  }
];

/** The docs a newcomer is most likely to need first. */
export const docsHighlights = [
  {
    label: "Start here",
    href: "/docs/overview",
    icon: Compass,
    description: "What each part of Mezair does and which one you need."
  },
  {
    label: "Install Mezair Desktop",
    href: "/docs/desktop/installation",
    icon: Terminal,
    description: "Download the app, open it the first time, and connect an agent."
  },
  {
    label: "Agent workflows",
    href: "/docs/desktop/agent-workflows",
    icon: Workflow,
    description: "Plan, build, review and hand off work with an agent."
  },
  {
    label: "User-definable software factories",
    href: "/docs/desktop/software-factories",
    icon: Factory,
    description: `GitHub issue to verified, confirmed merge under a policy you activate. Beta through ${featureBeta.endDate}.`
  },
  {
    label: "How Sync keeps your data private",
    href: "/docs/sync/encryption",
    icon: LockKeyhole,
    description: "What gets encrypted, where the key lives and what the server can see."
  },
  {
    label: "Mesh jobs",
    href: "/docs/sync/mesh-jobs",
    icon: Cpu,
    description: "Run a job on another machine using the same saved version of your code."
  },
  {
    label: "LAN-first Mesh routes",
    href: "/docs/sync/lan-first-routes",
    icon: Network,
    description: `How Mesh prefers the host's LAN address and switches routes safely. Beta through ${featureBeta.endDate}.`
  },
  {
    label: "Run your own backend",
    href: "/docs/sync/self-deploy",
    icon: Route,
    description: "Deploy Sync & Mesh to your Cloudflare account with one command."
  },
  {
    label: "Desktop architecture",
    href: "/docs/desktop/architecture",
    icon: Code2,
    description: "How the Electron app is put together, for contributors."
  },
  {
    label: "Monorepo map",
    href: "/docs/project/repositories",
    icon: GitBranch,
    description: "Which folder owns what, and where to start reading."
  }
];
