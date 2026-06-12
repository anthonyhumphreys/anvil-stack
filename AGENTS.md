# anvil-stack monorepo

Four independent project workspaces: `anvil-app/`, `anvil-cloud/`, `anvil-registry/`, `anvil-website/`. Each has its own lockfile, tooling, and `AGENTS.md`; read the project-level file before working in it. Run `pnpm install` inside the project directory, never at the repo root.

## Git conventions

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`).
- Commit normally; do NOT amend or force-push to keep a single commit.
- Do NOT add Co-Authored-By trailers or any AI attribution to commit messages.

## CI

Workflows in `.github/workflows/` are path-filtered per project. Tag schemes: `app-v*` (desktop macOS release), `cli-v*` (npm publish of @anvilstack/cli via trusted publishing), `registry-v*` and `node-base-v*` (GHCR images).
