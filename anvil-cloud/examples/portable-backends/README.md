# Portable backends reference Cell

This Cell shows a small catalogue import using only Anvil Runtime APIs. It
stores source files privately, commits a quota change, batch record, and outbox
message together, then processes each import with a receipt keyed by the stable
job id. A scheduled job publishes pending outbox entries. Malformed source data
leaves a failed batch record for inspection.

Run the local acceptance slice from `anvil-cloud/`:

```bash
pnpm --filter portable-backends typecheck
pnpm --filter portable-backends check
pnpm --filter portable-backends build
pnpm verify:application-backends
```

The verifier builds the Cell and starts the real Anvil Local server with a
temporary JSON database and file directory. It races two authenticated imports
from one quota snapshot, checks that the losing conditional commit leaves no
batch or outbox row, reads a private source as its owner, triggers scheduled
outbox dispatch, restarts the local server, delivers the persisted job twice
with the same logical id, and checks a poison batch's retained failure state.
It removes the temporary state directory and prints a JSON evidence record.

This is local acceptance evidence. The local job store is a JSON queue snapshot,
not an AWS SQS or Cloudflare Queues consumer. The verifier calls the Cell job
handler directly with the stored logical id because the local `/_anvil/jobs/run`
route generates a fresh request id. It does not prove provider delivery,
dead-letter handling, cloud backup restore, migration rollback, or deployment.
Use the AWS SDK tests and the Cloudflare local-binding tests for their adapter
contracts, then follow the live rehearsal requirements in
[`application-backends.md`](../../docs/architecture/application-backends.md).
