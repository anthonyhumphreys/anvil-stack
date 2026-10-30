#!/bin/sh
# Copies the built daemon bundle into this Docker build context.
# Run `pnpm build:daemon` in mezair-app first.
set -eu
cd "$(dirname "$0")"
APP_ROOT="$(cd ../../.. && pwd)"
BUNDLE="$APP_ROOT/dist-daemon/mezair-daemon.mjs"
if [ ! -f "$BUNDLE" ]; then
  echo "missing $BUNDLE — run 'pnpm build:daemon' in $APP_ROOT first" >&2
  exit 1
fi
cp "$BUNDLE" ./mezair-daemon.mjs
echo "staged $BUNDLE"
