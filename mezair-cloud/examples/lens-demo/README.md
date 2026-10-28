# Lens demo

Small Mezair Cell for exercising the local runtime and Mezair Lens.

```bash
cd mezair-cloud/examples/lens-demo
node ../../packages/cli/dist/index.js check --json
node ../../packages/cli/dist/index.js dev
```

Open Lens at:

```txt
http://localhost:8787/_mezair/lens
```

Useful demo actions once the server is running:

```bash
node ../../packages/cli/dist/index.js workflows run onboardUser --input '{"userId":"local_demo"}' --json
node ../../packages/cli/dist/index.js services list --json
```
