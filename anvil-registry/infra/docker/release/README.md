# Anvil Registry release bundle

This bundle runs the published Anvil Registry images with durable local storage. It is intended for a trusted LAN, a NAS, or a small operator-managed Docker host. Anvil Registry remains alpha software; pilot it with non-critical repositories before making it an organisation-wide dependency.

## Requirements

- Docker Engine 26 or later.
- Docker Compose 2.26 or later.
- Linux AMD64 or ARM64.
- A stable hostname or IP address reachable by npm and pnpm clients.
- HTTPS through a reverse proxy if traffic crosses an untrusted network.

## Install

1. Copy `.env.example` to `.env`.
2. Set `PUBLIC_BASE_URL` to the exact URL clients will use.
3. Generate unique values for `ANVIL_ADMIN_TOKEN`, `POSTGRES_PASSWORD`, and `MINIO_ROOT_PASSWORD`.
4. Set `ANVIL_DATA_DIR` to a directory included in the host backup policy.
5. Start the stack:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

6. Check readiness:

   ```bash
   curl "${PUBLIC_BASE_URL}/-/health"
   curl "${PUBLIC_BASE_URL}/-/ready"
   ```

`PUBLIC_BASE_URL` is not display-only configuration. Registry metadata rewrites package tarball URLs to it. A value of `localhost` will break installs from another machine.

## Configure npm and pnpm

Add a project-level `.npmrc` to a pilot repository:

```ini
registry=http://your-nas.example:4873/
```

Both npm and pnpm read this setting. Remove the file to return that project to its previous registry. Check scoped registry overrides with `npm config list`; scopes routed directly to another registry bypass Anvil unless that upstream is configured in `UPSTREAM_NPM_REGISTRIES_JSON`.

The Registry CLI is optional for installs. For operator checks:

```bash
npm install --global @anvilstack/registry-cli
ANVIL_REGISTRY_URL=http://your-nas.example:4873 anvil-registry doctor
```

## Pilot before enforcing

The example starts in `development` mode. Warm representative lockfiles and inspect decisions before switching `RUNTIME_MODE` to `ci` or `production`:

```bash
ANVIL_REGISTRY_URL=http://your-nas.example:4873 \
ANVIL_ADMIN_TOKEN=your-token \
  anvil-registry warm pnpm-lock.yaml
```

Production mode blocks packages that require analysis but do not yet have a report. That is useful after seeding and rather surprising before it.

## Optional Codex CLI review

The release includes an opt-in Compose override that runs Codex CLI only inside the worker. It mounts one host credential file read-only; gateway and Admin never receive the mount.

1. Sign in with Codex CLI on the Docker host and restrict the credential file:

   ```bash
   chmod 700 "$HOME/.codex"
   chmod 600 "$HOME/.codex/auth.json"
   ```

2. Set the absolute host path in `.env`:

   ```dotenv
   CODEX_AUTH_FILE=/home/your-user/.codex/auth.json
   LLM_REVIEW_MODEL=
   LLM_REVIEW_RUN_ON_QUARANTINE=true
   ```

3. Apply the base bundle plus the Codex override:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.codex.yml config
   docker compose -f docker-compose.yml -f docker-compose.codex.yml pull
   docker compose -f docker-compose.yml -f docker-compose.codex.yml up -d
   ```

4. Queue a deliberate first review:

   ```bash
   ANVIL_REGISTRY_URL=http://your-nas.example:4873 \
   ANVIL_ADMIN_TOKEN=your-token \
     anvil-registry llm-review is-number@7.0.0 --requested-by operator --priority high
   ```

The worker launches Codex ephemerally with user configuration and repository rules ignored, shell and code-execution tools disabled, a read-only sandbox, schema-constrained output, and a scrubbed environment that omits Registry service secrets. It sends collected package evidence to the Codex account, so private packages remain excluded unless `LLM_REVIEW_INCLUDE_PRIVATE_PACKAGES=true` is explicitly approved.

Mount only `auth.json`, not the whole `.codex` directory. The file grants use of the signed-in Codex account; keep the NAS and worker image within the same trusted boundary as that credential. The model review adds context only and cannot approve a package or override deterministic policy.

## Upgrade

1. Back up `ANVIL_DATA_DIR`.
2. Set `ANVIL_REGISTRY_VERSION` to the new immutable `registry-v*` tag.
3. Pull and apply the release:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps
   ```

The one-shot `migrate` service applies database migrations before gateway and worker startup.

## Backup and restore

Stop the stack before a filesystem-level backup so Postgres and MinIO are consistent:

```bash
docker compose down
tar -C "$(dirname "$ANVIL_DATA_DIR")" -czf anvil-registry-data.tgz "$(basename "$ANVIL_DATA_DIR")"
docker compose up -d
```

Restore only to the same or a compatible Registry release. Keep the `.env` file in a secret store separate from the data archive.

## Network boundary

Only gateway and Admin publish host ports. Postgres, Redis, and MinIO remain inside the Compose network. Set `ANVIL_BIND_ADDRESS=127.0.0.1` when a reverse proxy on the host terminates HTTPS; use `0.0.0.0` only for a trusted LAN. Do not expose the alpha stack directly to the public internet.
