#!/bin/sh
set -eu

CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.154.0}"
npm install --global "@openai/codex@${CODEX_CLI_VERSION}" --no-audit --no-fund

CODEX_INSTALLED_VERSION="$(codex --version)"
case "$CODEX_INSTALLED_VERSION" in
  *"${CODEX_CLI_VERSION}"*) ;;
  *)
    echo "Codex version mismatch: expected ${CODEX_CLI_VERSION}, got ${CODEX_INSTALLED_VERSION}" >&2
    exit 1
    ;;
esac
echo "Installed ${CODEX_INSTALLED_VERSION}"
