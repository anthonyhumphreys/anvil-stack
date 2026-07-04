# Anvil Stack

Monorepo for the Anvil projects. Each project is an independent workspace with its own lockfile, tooling, and docs.

| Project | Description |
| --- | --- |
| [`anvil-app/`](anvil-app/) | Anvil Desktop — Electron app for repo-aware developer workflows, plus the Expo mobile companion (`mobile/`), Remotion video project (`video/`), and Raycast extension (`raycast/`). |
| [`anvil-cloud/`](anvil-cloud/) | Anvil Cloud — agent-ready, portable TypeScript application platform with typed runtime capabilities and deployment adapters. |
| [`anvil-registry/`](anvil-registry/) | Anvil Registry — npm registry gateway with package risk analysis and deterministic dependency policy, plus the Anvil Node Base hardened devcontainer image. |
| [`anvil-website/`](anvil-website/) | Public website and documentation for all Anvil projects (Next.js, deployed to Vercel). |

## Working in this repo

Each project manages its own dependencies. Run `pnpm install` inside the project directory you are working on. See each project's `README.md` and `AGENTS.md` for build, test, and contribution details.

## CI / distribution

GitHub Actions workflows live in `.github/workflows/` and are path-filtered per project:

- **anvil-app** — lint/test/build CI; macOS arm64 release builds on tags.
- **anvil-cloud** — lint/typecheck/test/build CI.
- **anvil-registry** — CI plus container images published to GitHub Container Registry (`ghcr.io/anthonyhumphreys/...`).
- **anvil-website** — build/typecheck CI; deployed via the Vercel git integration.
- **npm** — `@anvilstack/cloud-cli`, `@anvilstack/registry-cli`, and the thin `@anvilstack/cli` wrapper publish from release tags.

## License

[MIT](LICENSE)
