---
title: CI usage
navTitle: CI usage
description: Use Anvil Registry and Anvil Node Base in pull requests, main branch gates, and dependency review workflows.
product: Anvil Registry
section: Operations
order: 12
---

# CI usage

Anvil Registry and Anvil Node Base work best when CI catches dependency risk before a pull request merges.

## Pull request flow

Recommended pull request checks:

1. Start or connect to Anvil Registry.
2. Configure npm-compatible clients to use the gateway.
3. Run dependency install with scripts disabled.
4. Ask Anvil Registry to explain changed package versions.
5. Run Anvil Node Base safe mode.
6. Upload `.anvil/reports` as CI artifacts.
7. Use observed mode only for packages that need lifecycle scripts.

## Example GitHub Actions job

```yaml
name: Dependency review

on:
  pull_request:

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: corepack enable

      - run: npm install --global @anvilstack/registry-cli

      - name: Install through Anvil Registry
        run: |
          npm config set registry "${ANVIL_REGISTRY_URL}"
          npm ci --ignore-scripts
        env:
          ANVIL_REGISTRY_URL: https://npm.example.com

      - name: Explain lockfile changes
        run: anvil-registry scan package-lock.json --queue-analysis
        env:
          ANVIL_REGISTRY_URL: https://npm.example.com
          ANVIL_ADMIN_TOKEN: ${{ secrets.ANVIL_ADMIN_TOKEN }}

      - name: Run Node Base safe mode
        run: |
          docker run --rm \
            -v "$PWD:/workspace" \
            -w /workspace \
            ghcr.io/anthonyhumphreys/anvil-stack/anvil-node-base:22 \
            anvil-npm-ci-safe

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: anvil-reports
          path: .anvil/reports
```

Adapt this to your container strategy. If your job already runs inside Anvil Node Base, call the helper scripts directly. If not, run the image with the repository mounted as shown above.

The CLI needs `ANVIL_REGISTRY_URL` for gateway calls and `ANVIL_ADMIN_TOKEN` for queueing analysis or other protected operations. See [CLI](/docs/registry/cli) for installation and command usage.

## Main branch gate

Main branch checks should be stricter:

```bash
ANVIL_STRICT=true \
ANVIL_STRICT_RISK_LEVEL=high \
ANVIL_STRICT_LIFECYCLE_MODE=risk \
  anvil-npm-ci-safe
```

Use Anvil Registry policy mode to block or quarantine package versions that have not been reviewed.

## Observed mode in CI

Observed mode can be noisy, so run it deliberately:

- Only for packages that require lifecycle scripts.
- Only for changed dependency sets.
- In a job with restricted credentials.
- With reports uploaded even on failure.

Avoid giving install scripts broad cloud credentials. If a dependency install needs production secrets, the build has already taken a wrong turn and started humming ominously.

## Report review

A useful CI artifact set includes:

- Anvil Registry explain output.
- Node Base lifecycle report.
- Node Base IOC report.
- npm, pnpm, or yarn install logs.
- Any override request or approval metadata.

Reviewers should be able to answer: what changed, what executed, what connected to the network, what policy decided, and who approved the exception.
