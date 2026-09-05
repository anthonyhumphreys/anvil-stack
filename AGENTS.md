# anvil-stack monorepo

Four independent project workspaces: `anvil-app/`, `anvil-cloud/`, `anvil-registry/`, `anvil-website/`. Each has its own lockfile, tooling, and `AGENTS.md`; read the project-level file before working in it. Run `pnpm install` inside the project directory, never at the repo root.

`PATCH.md` at the repo root is the authoritative intent guide for deliberate, owned deltas (currently the Effect orchestration internals in `anvil-cloud`). Review the relevant entry before merging or reworking code in an owned area, and update it in the same change when owned behavior changes.

## Interpreting approval and intent

- Treat affirmative responses to a proposed plan, such as "sounds like a solid plan", "looks good", or "makes sense", as authorization to execute that plan. Do not treat them as feedback only or wait for a separate "go ahead".
- Approval of a plan moves the task from planning into implementation, even when the original request was "no changes, just a plan", unless the user explicitly keeps the work planning-only.
- Carry the full approved scope forward. An added request such as "get rid of X too" supplements the plan; it does not replace or narrow it unless the user says so.
- State your interpretation briefly and proceed with the authorized work. Ask only when a material ambiguity or an action requiring separate authorization remains; approval does not expand the plan's scope.

## Git conventions

- Use Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`).
- Commit normally; do NOT amend or force-push to keep a single commit.
- Do NOT add Co-Authored-By trailers or any AI attribution to commit messages.

## CI

Workflows in `.github/workflows/` are path-filtered per project. Tag schemes: `app-v*` (desktop macOS release), `cloud-cli-v*`, `registry-cli-v*`, `cli-v*` (thin npm wrapper), `registry-v*`, and `node-base-v*` (GHCR images).
