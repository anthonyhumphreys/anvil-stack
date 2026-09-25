# Hosted sync rollback and restore

Use the environment target wrapper for backend changes. A Worker rollback
restores an earlier code/config version; it does not roll back D1, R2, WorkOS
or Stripe. D1 migrations are forward-only for the application. Keep processing
Stripe webhooks throughout an incident so the subscription mirror can
converge.

Start at the monorepo root, select `staging` or `production` explicitly, and
keep this shell open so the variables below remain set. Confirm the target
names, account and base URL against the Cloudflare dashboard before running a
provider command. Use a disposable staging account for the rehearsal.

## Before a change

Use the selected target's generated config and record the current Worker
version, applied D1 migrations, D1 storage version, and a point-in-time
bookmark. Store exports in encrypted operator storage; never commit them or
leave them in `.wrangler/`.

```sh
cd anvil-app
export HOSTED_ENV=staging # Set to production only for an approved incident/change.
TARGETS=cloud/backend/.wrangler/hosted-targets.json
export WORKER_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].workerName' "$TARGETS")"
export DATABASE_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].databaseName' "$TARGETS")"
export MESH_ORIGIN="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].baseUrl' "$TARGETS")"
export CONFIG="$PWD/cloud/backend/.wrangler/mesh/$WORKER_NAME/wrangler.jsonc"
export BACKUP_DIR="$(mktemp -d)"
chmod 700 "$BACKUP_DIR"
umask 077

pnpm --dir cloud/backend exec wrangler deployments list --name "$WORKER_NAME" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 info "$DATABASE_NAME" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 migrations list "$DATABASE_NAME" --remote --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 time-travel info "$DATABASE_NAME" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 export "$DATABASE_NAME" --remote \
  --output "$BACKUP_DIR/$DATABASE_NAME.sql" --config "$CONFIG"
shasum -a 256 "$BACKUP_DIR/$DATABASE_NAME.sql"
```

`d1 info` must report `version: production` for D1 Time Travel support. The
available Time Travel history is limited to the retention of the account's
Cloudflare plan. The SQL export is a separately stored recovery copy; protect
it as billing data. Record the bookmark and export checksum in the change or
incident record, never any secret values. If the selected plan, credential, or
retention does not permit a rehearsal, record the restore gate as **blocked**;
do not infer a successful restore from an export alone.

## Roll back Worker code

1. Disable new checkout immediately by setting the selected Worker's
   `HOSTED_CHECKOUT_ENABLED` variable to `false` in Cloudflare Dashboard, then
   publish and record the new version. Keep Stripe secrets and the webhook
   endpoint configured. For a staging rehearsal, also set the value in
   `cloud/backend/.wrangler/mesh/<worker-name>/vars.json` and use the wrapper:

   ```sh
   pnpm --dir cloud/backend hosted:deploy -- --environment staging plan --json
   pnpm --dir cloud/backend hosted:deploy -- --environment staging apply --test-deployment --json
   ```

   Do not use a wrapper apply to change this production variable during the
   incident: it deploys the current checkout before you have rolled code back.
   After rollback, inspect the deployed variable. If rollback restored
   checkout, set it to `false` in Cloudflare Dashboard again, publish, record
   the version, and sync the generated `vars.json` so the next planned deploy
   keeps checkout disabled. Do not remove `STRIPE_WEBHOOK_SECRET`.

2. Compare the previously deployed code's hosted-billing queries with the
   remote applied migration list captured above. Every applied migration stays
   applied. Confirm the candidate rollback code can run with every applied
   table and column before switching versions. Do not attempt to reverse a
   migration.

3. Roll back to the recorded known-good Worker version. Get its exact version
   ID from the output of `wrangler deployments list`; do not use an unreviewed
   version chosen by recency alone:

   ```sh
   pnpm --dir cloud/backend exec wrangler rollback '<known-good-version-id>' \
     --name "$WORKER_NAME" --config "$CONFIG" \
     --message 'Rollback <incident-reference>'
   ```

   Cloudflare creates a new deployment from that version. Bindings and D1 data
   remain as-is. Stop if rollback is rejected because a Durable Object
   migration or binding changed: do not delete or recreate resources to force
   it. Use a forward code fix that is compatible with the current bindings
   and D1 schema. See [Cloudflare rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

   For a staging rehearsal, inspect the deployed config after rollback and
   confirm checkout is still disabled. If it is enabled, turn it off and
   publish through the staging wrapper again; use the known-good source
   checkout for that follow-up deployment.

4. Verify the descriptor, signed account/billing/entitlement routes, webhook
   deliveries, and webhook backlog. Confirm checkout is disabled and existing
   subscriptions still resolve. Follow [reconciliation.md](reconciliation.md)
   to repair drift; never hand-edit subscription rows.

## Restore D1 data

Restore only for confirmed database corruption or accidental destructive
data changes, after a named incident owner identifies the recovery point. A
Time Travel restore overwrites the selected D1 database in place and cancels
in-flight queries. First practice both export import and point-in-time restore
against a dedicated disposable D1 database in the staging account. Do not use
the shared staging database or production for the drill.

For the rehearsal, explicitly switch the still-open shell back to staging and
create a fresh protected export directory. Do not run this section with a
production `CONFIG`:

```sh
export HOSTED_ENV=staging
export WORKER_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].workerName' "$TARGETS")"
export DATABASE_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].databaseName' "$TARGETS")"
export MESH_ORIGIN="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].baseUrl' "$TARGETS")"
export CONFIG="$PWD/cloud/backend/.wrangler/mesh/$WORKER_NAME/wrangler.jsonc"
export BACKUP_DIR="$(mktemp -d)"
chmod 700 "$BACKUP_DIR"
umask 077
```

Confirm the values identify the staging Worker and staging Cloudflare account
in the manifest/dashboard. For the drill, create two temporary D1 databases
with unique `drill` names, then use this staging config to select the account:

```sh
TEST_SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)"
export DRILL_DB="anvil-hosted-rollback-drill-$TEST_SUFFIX"
export RESTORE_DB="anvil-hosted-rollback-restore-$TEST_SUFFIX"
pnpm --dir cloud/backend exec wrangler d1 create "$DRILL_DB" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 create "$RESTORE_DB" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 execute "$DRILL_DB" --remote --config "$CONFIG" \
  --command "CREATE TABLE rollback_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO rollback_probe VALUES ('drill-1', 'before');"
pnpm --dir cloud/backend exec wrangler d1 export "$DRILL_DB" --remote \
  --output "$BACKUP_DIR/rollback-drill.sql" --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 execute "$RESTORE_DB" --remote --config "$CONFIG" \
  --file "$BACKUP_DIR/rollback-drill.sql"
pnpm --dir cloud/backend exec wrangler d1 execute "$RESTORE_DB" --remote --config "$CONFIG" \
  --command "SELECT id, value FROM rollback_probe WHERE id = 'drill-1';"
pnpm --dir cloud/backend exec wrangler d1 time-travel info "$DRILL_DB" --config "$CONFIG"
```

Record the restore database query result. To prove Time Travel, take the
bookmark immediately before a second synthetic write, perform the write, then
restore the **drill database only** to that bookmark:

```sh
pnpm --dir cloud/backend exec wrangler d1 execute "$DRILL_DB" --remote --config "$CONFIG" \
  --command "INSERT INTO rollback_probe VALUES ('drill-2', 'after-bookmark');"
pnpm --dir cloud/backend exec wrangler d1 time-travel restore "$DRILL_DB" --bookmark '<recorded-bookmark>' \
  --config "$CONFIG"
pnpm --dir cloud/backend exec wrangler d1 execute "$DRILL_DB" --remote --config "$CONFIG" \
  --command "SELECT id, value FROM rollback_probe ORDER BY id;"
```

The final query must contain `drill-1` and not `drill-2`. Keep the returned
pre-restore bookmark so the drill can be undone if needed. After recording the
result, delete both disposable databases only after confirming the names and
IDs in the Cloudflare dashboard. Never delete a production or shared staging
database as cleanup.

For a real incident, pause writes only if required to prevent further
corruption, export the current damaged state first, and get a second operator
to confirm the database name, ID, timestamp/bookmark, and expected data-loss
window. If you ran the drill above in this shell, first switch its variables
back to production and create a fresh protected directory for the incident
export:

```sh
export HOSTED_ENV=production
export WORKER_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].workerName' "$TARGETS")"
export DATABASE_NAME="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].databaseName' "$TARGETS")"
export MESH_ORIGIN="$(jq -er --arg env "$HOSTED_ENV" '.environments[$env].baseUrl' "$TARGETS")"
export CONFIG="$PWD/cloud/backend/.wrangler/mesh/$WORKER_NAME/wrangler.jsonc"
export BACKUP_DIR="$(mktemp -d)"
chmod 700 "$BACKUP_DIR"
umask 077
```

Export current damaged state, record its checksum, and set the previously
reviewed bookmark. Only after the second operator confirms the account,
database and expected data-loss window, run the restore command:

```sh
pnpm --dir cloud/backend exec wrangler d1 export "$DATABASE_NAME" --remote \
  --output "$BACKUP_DIR/${DATABASE_NAME}-pre-restore.sql" --config "$CONFIG"
shasum -a 256 "$BACKUP_DIR/${DATABASE_NAME}-pre-restore.sql"
export RESTORE_BOOKMARK='<recorded-pre-incident-bookmark>'
pnpm --dir cloud/backend exec wrangler d1 time-travel restore "$DATABASE_NAME" \
  --bookmark "$RESTORE_BOOKMARK" --config "$CONFIG"
```

Record the command result's previous bookmark; it is the recovery point for
undoing the restore. Reapply only migrations required by the restored schema,
then deploy code compatible with that schema. Do not restore just to undo a
forward migration: use code that tolerates the current schema instead.

## Enforcement switch

`HOSTED_BILLING_ENFORCEMENT=false` allows restricted and unknown accounts to
mutate hosted data. It is a last-resort containment lever only when the
enforcement path itself is causing the outage. The guarded wrapper rejects a
config with this flag off; if it is essential, use the Cloudflare Worker
dashboard to set the variable, publish the resulting deployment, and record
the version and incident approval. Restore `'true'` through the normal
manifest/wrapper path as soon as the enforcement fault is fixed. Run
`pnpm --dir cloud/backend verify:hosted-config` as the repository-config
check, then inspect the deployed variable in Cloudflare and confirm its value
is literally `'true'`; the local validator cannot inspect a deployed Worker.

## Recovery checks

- `curl -fsS "$MESH_ORIGIN/.well-known/anvil-backend"` returns the expected
  descriptor for the selected target.
- A disposable signed-in test account can read billing and entitlement state.
- Stripe test/live dashboard deliveries match the selected target and return
  2xx; webhook backlog and failed-event counts return to baseline.
- Hosted checkout remains disabled until the incident owner re-enables it.
- The incident record includes Worker version IDs, applied migrations,
  bookmark/export checksum, restore or rollback command results, and the
  operator who verified recovery.
