# Anvil CLI

Umbrella dispatcher for Anvil product CLIs. Use this as the normal Anvil
command-line entrypoint:

```bash
npm install --global @anvilstack/cli
npm install --global @anvilstack/cloud-cli
npm install --global @anvilstack/registry-cli

anvil cloud check --json
anvil registry scan package-lock.json --queue-analysis
```

The umbrella package exposes the `anvil` binary, but it does not bundle the
product CLIs. Install the product CLI you want to dispatch to. This keeps the
wrapper small and avoids making every user download Cloud deployment
dependencies when they only want Registry policy checks. Software can have
boundaries. As a treat.

The product-specific binaries still exist:

```bash
anvil-cloud check --json
anvil-registry scan package-lock.json --queue-analysis
```

Use direct binaries when testing a product package directly, debugging wrapper
dispatch, or writing package-specific CI. For general docs and everyday usage,
prefer the product namespace under `anvil`.

For the Registry CLI migration, legacy Registry commands such as `anvil scan`
and `anvil explain` still dispatch to `anvil-registry` with a deprecation
warning. Prefer `anvil registry scan`.
