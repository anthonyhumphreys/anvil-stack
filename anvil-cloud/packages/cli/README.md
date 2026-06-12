# @anvil-cloud/cli

CLI package for Anvil Cloud.

The CLI binary should be `anvil`.

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
