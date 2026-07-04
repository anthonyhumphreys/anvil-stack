# anvil-stack monorepo

Four independent project workspaces: `anvil-app/`, `anvil-cloud/`, `anvil-registry/`, `anvil-website/`. Each has its own lockfile, tooling, and `AGENTS.md`; read the project-level file before working in it. Run `pnpm install` inside the project directory, never at the repo root.

`PATCH.md` at the repo root is the authoritative intent guide for deliberate, owned deltas (currently the Effect orchestration internals in `anvil-cloud`). Review the relevant entry before merging or reworking code in an owned area, and update it in the same change when owned behavior changes.

## Git conventions

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`).
- Commit normally; do NOT amend or force-push to keep a single commit.
- Do NOT add Co-Authored-By trailers or any AI attribution to commit messages.

## CI

Workflows in `.github/workflows/` are path-filtered per project. Tag schemes: `app-v*` (desktop macOS release), `cloud-cli-v*`, `registry-cli-v*`, `cli-v*` (thin npm wrapper), `registry-v*`, and `node-base-v*` (GHCR images).
