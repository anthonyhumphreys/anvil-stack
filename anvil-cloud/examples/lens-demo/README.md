# Lens demo

Small Anvil Cell for exercising the local runtime and Anvil Lens.

```bash
cd anvil-cloud/examples/lens-demo
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js dev
```

Open Lens at:

```txt
http://localhost:8787/_anvil/lens
```

Useful demo actions once the server is running:

```bash
node ../../packages/cli/dist/index.js workflows run onboardUser --input '{"userId":"local_demo"}' --json
node ../../packages/cli/dist/index.js services list --json
```
