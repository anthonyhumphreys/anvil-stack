# Anvil CLI

Umbrella dispatcher for Anvil product CLIs.

Use product-specific CLIs directly when scripting:

```bash
npm install --global @anvilstack/cloud-cli
npm install --global @anvilstack/registry-cli

anvil-cloud check --json
anvil-registry scan package-lock.json --queue-analysis
```

The umbrella package exposes the `anvil` binary for interactive use:

```bash
npm install --global @anvilstack/cli

anvil cloud check --json
anvil registry scan package-lock.json --queue-analysis
```

`@anvilstack/cli` does not bundle the product CLIs. Install the product CLI you
want to dispatch to. This keeps the wrapper small and avoids making every user
download Cloud deployment dependencies when they only want Registry policy
checks. Software can have boundaries. As a treat.

For the Registry CLI migration, legacy Registry commands such as `anvil scan`
and `anvil explain` still dispatch to `anvil-registry` with a deprecation
warning. Prefer `anvil registry scan` or the direct `anvil-registry` binary.
