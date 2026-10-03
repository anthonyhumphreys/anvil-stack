#!/bin/sh
# Copies the built daemon bundle into this Docker build context.
# Run `pnpm build:daemon` in anvil-app first.
set -eu
cd "$(dirname "$0")"
APP_ROOT="$(cd ../../.. && pwd)"
BUNDLE="$APP_ROOT/dist-daemon/anvil-daemon.mjs"
if [ ! -f "$BUNDLE" ]; then
  echo "missing $BUNDLE — run 'pnpm build:daemon' in $APP_ROOT first" >&2
  exit 1
fi
cp "$BUNDLE" ./anvil-daemon.mjs
echo "staged $BUNDLE"
