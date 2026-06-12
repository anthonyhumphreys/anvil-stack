---
title: Contributing
navTitle: Contributing
description: How to contribute to Anvil Desktop, Anvil Registry, Anvil Node Base, and Anvil Cloud.
product: Project
section: Notes
order: 895
---

# Contributing

Anvil lives in the [`anvil-stack`](https://github.com/anthonyhumphreys/anvil-stack) monorepo. Contributions should land in the project directory that owns the surface being changed.

## Project boundaries

| Change belongs in | When you are changing |
| --- | --- |
| `anvil-app/` | Electron main process, renderer UI, SQLite schema, mobile companion, Raycast, video, prompts. |
| `anvil-registry/` | Gateway routing, worker analysis, policy engine, CLI commands, Admin UI, Node Base helpers. |
| `anvil-cloud/` | Cell DSL, runtime host, builder, local server, client SDK, CLI commands, AWS adapter. |
| `anvil-website/` | Public docs, landing copy, site navigation, project comparison data. |

## Shared principles

Across all projects:

- Keep changes scoped to one concern.
- Add or update tests for the behaviour you change.
- Update documentation in the same change.
- Describe alpha features by their current behavior, limits, and verification path.
- Do not hide sharp edges.

## Anvil Desktop contributions

See `anvil-app/CONTRIBUTING.md` for the full guide. Key points:

- Feature changes span `src/shared`, `src/main`, `src/preload`, and `src/renderer`.
- Add IPC handlers that validate, delegate, and translate results.
- Keep business logic in services, not in IPC files.
- Increment `SCHEMA_VERSION` and add a migration for schema changes.
- Run `pnpm test`, `pnpm lint`, and `pnpm build` before opening a PR.

## Anvil Registry contributions

See `anvil-registry/CONTRIBUTING.md` and `anvil-registry/AGENTS.md` for the full guide. Key points:

- Read the relevant spec before changing behaviour.
- Deterministic policy is the enforcement authority.
- LLM review adds context; it does not allow packages.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- Update public docs in `anvil-website/` (same repo) for user-facing changes.

## Anvil Cloud contributions

See `anvil-cloud/AGENTS.md` and `anvil-cloud/docs/contributing/development.md`. Key points:

- Prioritise runtime contract and app DSL first.
- Prove local runtime before adding cloud infrastructure.
- Keep core contracts provider-neutral.
- Every CLI command should support `--json`.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## Documentation contributions

Documentation lives in `anvil-website/content/docs`. To add or edit docs:

1. Add a Markdown file with frontmatter.
2. Use concrete commands, architecture, and honest alpha notes.
3. Group docs by product folder.
4. Run `pnpm build` and `pnpm typecheck` in `anvil-website`.

## Commit style

Use Conventional Commits:

```txt
feat(terminal): add zsh detection
fix(gateway): handle scoped package metadata encoding
docs: clarify policy reason codes
test(worker): add name-squatting check for hyphen variants
```

## Code of conduct

Be precise, be honest, and do not optimise for theatre over substance.

## Read next

- [Open source posture](/docs/project/open-source)
- [Monorepo map](/docs/project/repositories)
