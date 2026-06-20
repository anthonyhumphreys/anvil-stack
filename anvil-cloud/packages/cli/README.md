# @anvilstack/cloud-cli

CLI package for Anvil Cloud.

The CLI binary is `anvil-cloud`.

## Install

```bash
npm install --global @anvilstack/cloud-cli
```

or run through the umbrella wrapper:

```bash
npm install --global @anvilstack/cli
anvil cloud check --json
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
- `anvil-cloud build`
- `anvil-cloud inspect`
- `anvil-cloud logs`
- `anvil-cloud db list`
- `anvil-cloud db dump <table>`
- `anvil-cloud deploy --preview`

Every automation-oriented command must support `--json`.

See `docs/specs/cli.md` for the command contract.
