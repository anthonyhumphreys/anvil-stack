# Mezair CLI

Umbrella dispatcher for Mezair product CLIs. Use this as the normal Mezair
command-line entrypoint:

```bash
npm install --global @mezairstack/cli
npm install --global @mezairstack/cloud-cli
npm install --global @mezairstack/registry-cli

mezair cloud check --json
mezair registry scan package-lock.json --queue-analysis
```

The umbrella package exposes the `mezair` binary, but it does not bundle the
product CLIs. Install the product CLI you want to dispatch to. This keeps the
wrapper small and avoids making every user download Cloud deployment
dependencies when they only want Registry policy checks. Software can have
boundaries. As a treat.

The product-specific binaries still exist:

```bash
mezair-cloud check --json
mezair-registry scan package-lock.json --queue-analysis
```

Use direct binaries when testing a product package directly, debugging wrapper
dispatch, or writing package-specific CI. For general docs and everyday usage,
prefer the product namespace under `mezair`.

For the Registry CLI migration, legacy Registry commands such as `mezair scan`
and `mezair explain` still dispatch to `mezair-registry` with a deprecation
warning. Prefer `mezair registry scan`.
