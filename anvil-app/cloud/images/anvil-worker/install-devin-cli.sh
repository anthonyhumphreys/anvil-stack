#!/usr/bin/env bash
set -euo pipefail

version=${DEVIN_CLI_VERSION:-3000.11.3}
export PATH="$HOME/.local/bin:$PATH"
case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:aarch64|Linux:arm64) ;;
  *)
    echo "unsupported Devin CLI image architecture: $(uname -s)/$(uname -m)" >&2
    exit 1
    ;;
esac

installer=$(mktemp)
trap 'rm -f "$installer" "$installer.patched"' EXIT
url="https://static.devin.ai/cli/${version}/setup.sh"
curl --connect-timeout 20 --max-time 60 -fsSL "$url" -o "$installer"

# Cognition's versioned installer validates and installs the pinned bundle,
# then unconditionally launches its interactive login/setup wizard. Strip only
# that final invocation, after checking the installer still has the expected
# exact tail and download commands. The CLI itself is checked below without
# starting an authenticated session.
setup_line='"$VERSION_DIR/bin/$COMPILED_BIN_NAME" setup'
manifest_line='MANIFEST=$(curl -sSf "$MANIFEST_URL" || true)'
bundle_line='  if ! curl -f --progress-bar "$BUNDLE_URL" -o "$BUNDLE_FILE"; then'
grep -Fqx "$setup_line" <(tail -n 1 "$installer") || {
  echo "unexpected Devin installer tail; refusing to run interactive setup" >&2
  exit 1
}
grep -Fqx "$manifest_line" "$installer" || {
  echo "unexpected Devin manifest download command" >&2
  exit 1
}
grep -Fqx "$bundle_line" "$installer" || {
  echo "unexpected Devin bundle download command" >&2
  exit 1
}
sed \
  -e 's@^MANIFEST=$(curl -sSf "$MANIFEST_URL" || true)$@MANIFEST=$(curl --connect-timeout 20 --max-time 60 -sSf "$MANIFEST_URL" || true)@' \
  -e 's@^  if ! curl -f --progress-bar "$BUNDLE_URL" -o "$BUNDLE_FILE"; then$@  if ! curl --connect-timeout 20 --max-time 300 -f --progress-bar "$BUNDLE_URL" -o "$BUNDLE_FILE"; then@' \
  -e '/^"\$VERSION_DIR\/bin\/\$COMPILED_BIN_NAME" setup$/d' \
  "$installer" > "$installer.patched"
bash "$installer.patched"
ln -sf "$HOME/.local/bin/devin" /usr/local/bin/devin

actual=$(devin --version)
case "$actual" in
  *"$version"*) ;;
  *)
    echo "Devin CLI version mismatch: expected $version, got $actual" >&2
    exit 1
    ;;
esac
devin acp --help >/dev/null
echo "Installed Devin CLI $version ($(uname -m)); ACP help smoke check passed"
