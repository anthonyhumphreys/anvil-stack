# @anvil-cloud/cli

CLI package for Anvil Cloud.

The CLI binary should be `anvil`.

## Alpha workspace usage

Packages are private while the alpha contract settles. From a checkout, build
the workspace and run the CLI through the root script:

```bash
cd anvil-cloud
pnpm install --ignore-scripts
pnpm build
pnpm anvil --help
pnpm anvil new notes
```

Inside an example Cell, use the built entrypoint directly:

```bash
node ../../packages/cli/dist/index.js check --json
```

The public install path will become the default once package publishing is
enabled. Until then, the command contract is stable; the distribution packaging
is the bit still wearing an alpha badge.

Initial commands:

- `anvil new <name>`
- `anvil dev`
- `anvil check`
- `anvil build`
- `anvil inspect`
- `anvil logs`
- `anvil db list`
- `anvil db dump <table>`
- `anvil deploy --preview`

Every automation-oriented command must support `--json`.

See `docs/specs/cli.md` for the command contract.
