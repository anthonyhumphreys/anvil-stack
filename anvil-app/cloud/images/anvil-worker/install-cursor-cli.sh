#!/bin/sh
set -eu

version=${CURSOR_CLI_VERSION:-2026.09.10-fd3934a}
target_arch=${TARGETARCH:-}
case "$target_arch" in
  arm64) arch=arm64 ;;
  amd64) arch=x64 ;;
  *)
    echo "unsupported Cursor image architecture: ${target_arch:-unset} (expected arm64 or amd64)" >&2
    exit 1
    ;;
esac

url="https://downloads.cursor.com/lab/${version}/linux/${arch}/agent-cli-package.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --connect-timeout 20 --max-time 300 -fsSL "$url" -o "$tmp/cursor-agent.tar.gz"
mkdir -p /opt/cursor-agent
tar --strip-components=1 -xzf "$tmp/cursor-agent.tar.gz" -C /opt/cursor-agent
test -x /opt/cursor-agent/cursor-agent
ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

actual=$(cursor-agent --version)
if [ "$actual" != "$version" ]; then
  echo "Cursor CLI version mismatch: expected $version, got $actual" >&2
  exit 1
fi
cursor-agent acp --help >/dev/null
echo "Installed Cursor CLI $actual ($target_arch); ACP help smoke check passed"
