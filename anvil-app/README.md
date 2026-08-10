# Anvil

Developer mission control. A cross-platform desktop application that brings AI-powered workflows to your entire development lifecycle — from understanding codebases and onboarding new team members to running security audits, code reviews, and business analysis.

Anvil is the brain; your coding agents are the hands.

## Features

- **Repository Intelligence** — connect local repos or clone from GitHub/Azure DevOps, then index them for architecture diagrams, module summaries, and language breakdowns
- **AI Chat**: converse with specialised personas for coding, design, analysis, and IT service management, each scoped with relevant context and guidance
- **Onboarding** — auto-generate `AGENTS.md`, `devcontainer.json`, and environment setup guides for any repo
- **Work Items** — unified interface for Azure DevOps, Linear, and Jira — list, filter, plan, and estimate without leaving the app
- **Security Audits** — LLM-driven vulnerability analysis with OWASP/CWE mapping, finding severity levels, and one-click work-item creation
- **Code Review** — quick-glance or senior-developer-depth reviews across commits, branches, or full codebases
- **Business Analysis** — spike feasibility studies linked to work items, with branch management and drift detection
- **Documentation** — Confluence integration with staleness detection and AI-generated updates
- **Diagrams** — draw.io integration with AI-powered generation and an embedded editor
- **Terminal** — built-in xterm.js terminal with PTY support and powerline font rendering
- **Workspaces** — group repos, configure integrations per workspace, and export to VS Code
- **Governance** — document and board management for governance oversight
- **Optional Cloud Workbench** — connect to an authenticated Anvil Cloud execution plane, upload committed read-only snapshots, request Codex/Cursor subscription auth without model API keys, and inspect remote evidence and approvals

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 33 |
| UI | React 19, Tailwind CSS 4, React Router 6 |
| Language | TypeScript 5.9 (strict mode) |
| Database | SQLite via better-sqlite3 (WAL mode) |
| LLM | Azure AI Foundry / OpenAI |
| Terminal | xterm.js 6 + node-pty |
| Diagrams | Mermaid, draw.io |
| Git | simple-git |
| Build | electron-vite 5, Vite 7 |
| Packaging | electron-builder (dmg, nsis, AppImage, deb) |
| Testing | Vitest 4 |
| Linting | ESLint 10, Prettier 3 |

## Prerequisites

- **Node.js** 20 LTS or later
- **pnpm** 10 (`corepack enable` or `npm install -g pnpm`)
- A C/C++ toolchain for native module compilation:
  - **macOS** — Xcode Command Line Tools (`xcode-select --install`)
  - **Windows** — Visual Studio Build Tools with the "Desktop development with C++" workload
  - **Linux** — `build-essential`, `python3`, `libsecret-1-dev`
- **Git** 2.30+

### Optional

- A [Nerd Font](https://www.nerdfonts.com/) installed (e.g. MesloLGS NF, Hack Nerd Font) for powerline glyph rendering in the terminal
- An Azure AI Foundry or OpenAI API key for AI features
- Subscription-backed Cloud execution needs a compatible worker image that implements the selected provider's interactive login; model API keys are not required by that execution contract
- Azure DevOps PAT / Linear API key / Jira API token for work-item integration
- Confluence PAT for documentation features

## Getting Started

```bash
# Clone the monorepo
git clone https://github.com/anthonyhumphreys/anvil-stack.git
cd anvil-stack/anvil-app

# Install dependencies (also rebuilds native modules via postinstall)
pnpm install

# Start in development mode with hot reload
pnpm dev
```

On first launch the app walks you through connector setup — LLM provider, work-item tracker, and repo connections.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Electron in dev mode with hot reload |
| `pnpm build` | Production build |
| `pnpm preview` | Preview the production build |
| `pnpm test` | Run tests once (Vitest) |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm lint` | Lint with ESLint |
| `pnpm format` | Format with Prettier |

## Building for Distribution

```bash
pnpm run dist:mac:arm64
```

Output lands in `dist/`. Targets by platform:

- **macOS** — `.dmg` + `.zip`
- **Windows** — NSIS installer + portable `.exe`
- **Linux** — `.AppImage` + `.deb`

## Architecture

Anvil follows the standard Electron multi-process model:

```
┌─────────────────────────────────────────────────┐
│                  Main Process                    │
│  (Node.js — file system, APIs, database, PTY)   │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ IPC      │  │ Services  │  │ SQLite (WAL) │  │
│  │ Handlers │──│ (37+)     │──│ 25+ tables   │  │
│  └────┬─────┘  └───────────┘  └──────────────┘  │
│       │ contextBridge                            │
├───────┼─────────────────────────────────────────-┤
│       │        Renderer Process                  │
│  ┌────▼─────────────────────────────────────┐    │
│  │  React SPA                               │    │
│  │  Routes · Contexts · Components · Hooks  │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

- **Main process** — IPC handlers in `src/main/ipc/` delegate to services in `src/main/services/`. All database access, file I/O, LLM calls, and PTY management happen here.
- **Preload** — `src/preload/index.ts` exposes a typed `window.anvil` API via Electron's `contextBridge`. The renderer never has direct Node access.
- **Renderer** — a React SPA in `src/renderer/` with feature-scoped component directories, React contexts for shared state, and Tailwind for styling.
- **Shared** — `src/shared/` contains TypeScript types and the IPC API definition, used by both processes.

### Key directories

```
src/
├── main/
│   ├── ipc/          # IPC handler registration (one file per feature)
│   ├── services/     # Business logic (LLM, git, indexing, integrations)
│   ├── db/           # SQLite schema, migrations, connection
│   └── utils/        # Helpers and prompt templates
├── preload/          # Electron contextBridge (secure IPC surface)
├── renderer/
│   ├── components/   # Feature-scoped UI (repos, chat, security, etc.)
│   ├── contexts/     # React context providers
│   ├── hooks/        # Custom hooks
│   ├── stores/       # State management
│   └── styles/       # Global CSS and Tailwind config
├── shared/           # Types and IPC API definitions
└── prompts/          # LLM prompt templates and persona definitions
```

## Configuration

All user configuration (API keys, endpoints, tokens) is managed through the in-app Settings view. Credentials are encrypted before being stored in the local SQLite database. No `.env` file is required.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on setting up a development environment, code style, commit conventions, and the pull request process.

## License

[MIT](../LICENSE)
