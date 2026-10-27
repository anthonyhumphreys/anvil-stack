# Mezair Stack

Monorepo for the Mezair projects. Each project is an independent workspace with its own lockfile, tooling, and docs.

| Project                                | Description                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`mezair-app/`](mezair-app/)           | Mezair Desktop — Electron app for repo-aware developer workflows, plus the Expo mobile companion (`mobile/`), Remotion video project (`video/`), and Raycast extension (`raycast/`). |
| [`mezair-cloud/`](mezair-cloud/)       | Mezair Cloud — agent-ready, portable TypeScript application platform with typed runtime capabilities and deployment adapters.                                                        |
| [`mezair-registry/`](mezair-registry/) | Mezair Registry — npm registry gateway with package risk analysis and deterministic dependency policy, plus the Mezair Node Base hardened devcontainer image.                        |
| [`mezair-website/`](mezair-website/)   | Public website and documentation for all Mezair projects (Next.js, deployed to Vercel).                                                                                              |

## Working in this repo

Each project manages its own dependencies. Run `pnpm install` inside the project directory you are working on. See each project's `README.md` and `AGENTS.md` for build, test, and contribution details.

## CI / distribution

GitHub Actions workflows live in `.github/workflows/` and are path-filtered per project:

- **mezair-app** — lint/test/build CI; macOS arm64 tag releases are unsigned by default.
  The workflow offers a signed/notarized dispatch when Apple credentials are configured.
  Auto-updates remain disabled.
- **mezair-cloud** — lint/typecheck/test/build CI.
- **mezair-registry** — CI plus container images published to GitHub Container Registry (`ghcr.io/anthonyhumphreys/...`).
- **mezair-website** — build/typecheck CI; deployed via the Vercel git integration.
- **npm** — `@mezairstack/cloud-cli`, `@mezairstack/registry-cli`, and the thin `@mezairstack/cli` wrapper publish from release tags.

## License

[MIT](LICENSE)

## Desktop CLI preparation

Before installing Desktop dependencies, build its locally bundled CLIs:

```sh
node .github/scripts/prepare-desktop-clis.mjs
```

Run `pnpm install` inside `mezair-app` after the helper succeeds. The projects
retain independent lockfiles. See the [identity cutover guide](docs/mezair-identity-cutover.md) for profile, protocol and release prerequisites.
