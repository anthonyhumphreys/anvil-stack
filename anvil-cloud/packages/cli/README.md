# @anvilstack/cloud-cli

CLI package for Anvil Cloud.

The CLI binary is `anvil-cloud`.

This is the only public Anvil Cloud npm package during alpha. Runtime, client,
builder, local, auth, control-plane, and AWS workspace packages are private
implementation details until their external API contracts are deliberately
stabilized.

## Install

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli
anvil cloud check --json
```

The umbrella `anvil` command is the intended user-facing entrypoint. It
dispatches to the installed Cloud product CLI.

Use the direct binary when testing this package itself or debugging wrapper
dispatch:

```bash
anvil-cloud check --json
```

## Workspace usage

From a checkout, build the workspace and run the CLI through the root script:

```bash
cd anvil-cloud
pnpm install --ignore-scripts
pnpm build
pnpm anvil-cloud --help
pnpm anvil-cloud new notes
```

Inside an example Cell, use the built entrypoint directly:

```bash
node ../../packages/cli/dist/index.js check --json
```

Initial commands:

- `anvil-cloud new <name>`
- `anvil-cloud dev`
- `anvil-cloud check`
- `anvil-cloud review`
- `anvil-cloud build`
- `anvil-cloud agents discover`
- `anvil-cloud agents guardian`
- `anvil-cloud inspect`
- `anvil-cloud logs`
- `anvil-cloud usage --preview`
- `anvil-cloud db list`
- `anvil-cloud db dump <table>`
- `anvil-cloud deploy --preview [--name branch]`
- `anvil-cloud rollback --preview --dry-run`
- `anvil-cloud destroy --preview --app <name> [--name branch] --yes`

Every automation-oriented command must support `--json`.

See `docs/specs/cli.md` for the command contract.
