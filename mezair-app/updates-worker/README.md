# Mezair Desktop update service

This Worker serves macOS update metadata and signed update archives from a private R2 bucket. Manual installer downloads remain on GitHub Releases.

## Public routes

| Route                                           | R2 key                                      | Cache policy                                      |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| `/v1/macos/arm64/feed.json`                     | `macos/arm64/feed.json`                     | 60 seconds in clients, 5 minutes at shared caches |
| `/v1/macos/arm64/releases/<version>/<asset>`    | `macos/arm64/releases/<version>/<asset>`    | One year, immutable                               |

All other R2 keys remain private. `GET` streams object bodies, preserves conditional requests, and supports byte ranges. `HEAD` returns object metadata without reading the body.

## Rate limits

- Update feed: 120 requests per minute per source IP.
- ZIP assets: 30 requests per minute per source IP.

These limits are deliberately above normal use. Mezair checks once after startup and then every four hours. The higher feed limit avoids blocking teams behind one NAT address, while the asset limit stops simple download loops without breaking normal range requests.

## Deploy

From `mezair-app/`:

```bash
pnpm --dir updates-worker run types:check
pnpm --dir updates-worker run typecheck
pnpm --dir updates-worker run test
pnpm --dir updates-worker run dry-run
pnpm --dir updates-worker run deploy
```

The manual `Mezair Desktop Updates Cloudflare` GitHub workflow creates the `mezair-desktop-releases` bucket when needed and deploys the Worker. Configure these repository secrets first:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_DEPLOY_API_TOKEN`, scoped to deploy this Worker and create or bind the release bucket
- `CLOUDFLARE_R2_ACCESS_KEY_ID` and `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, generated from a bucket-scoped R2 read/write token

The Worker and R2 routes are deployable, but update publication is not wired into the app release workflow. That workflow currently forces `MEZAIR_UPDATE_ORIGIN` to an empty value and publishes GitHub Release assets only. Setting the repository variable does not enable in-app updates. Keep automatic updates off until a release path generates signed update metadata, uploads the immutable ZIP, verifies it, and updates the feed only after the asset is available.

Keep the R2 development URL disabled. A `workers.dev` origin is suitable for testing the Worker routes. A custom domain can replace it once a Mezair domain is managed by the same Cloudflare account.
