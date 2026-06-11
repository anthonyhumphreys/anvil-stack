#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

usage() {
  cat <<'EOF'
Build, sign, and notarize Anvil for macOS Apple Silicon.

Usage:
  pnpm run dist:mac:arm64:anvil:notarized
  bash scripts/build-macos-arm64-anvil-notarized.sh

Required host tools:
  macOS on Apple Silicon, Xcode command line tools, notarytool, stapler.

Signing environment:
  CSC_LINK + CSC_KEY_PASSWORD
    Developer ID Application certificate as a path, URL, or base64 .p12, plus its password.
  or CSC_NAME
    Name/hash of an installed Developer ID Application identity in the keychain.

Notarization environment, choose exactly one:
  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
    APPLE_API_KEY must be a path to the App Store Connect .p8 key.
  APPLE_API_KEY_BASE64 + APPLE_API_KEY_ID + APPLE_API_ISSUER
    Convenience form for CI secrets; this script writes the key to a temporary .p8 file.
  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
    Apple ID auth with an app-specific password.
  APPLE_KEYCHAIN_PROFILE
    Profile previously stored with `xcrun notarytool store-credentials`.
    APPLE_KEYCHAIN is optional.

Optional:
  SKIP_PNPM_INSTALL=1
    Skip pnpm install even when node_modules is missing.
  ALLOW_NON_ARM64_HOST=1
    Allow running from a non-arm64 macOS host while still producing arm64 artifacts.
  ALLOW_SIGNING_AUTO_DISCOVERY=1
    Allow electron-builder to discover a Developer ID Application identity implicitly.
  DEBUG=electron-builder,electron-notarize*
    More verbose signing/notarization output.
EOF
}

fail() {
  echo "[anvil-notarized] ERROR: $*" >&2
  exit 1
}

info() {
  echo "[anvil-notarized] $*"
}

env_present() {
  [[ -n "${!1:-}" ]]
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_env_group() {
  local group_name="$1"
  shift

  local missing=()
  for name in "$@"; do
    if ! env_present "${name}"; then
      missing+=("${name}")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "${group_name} is incomplete. Missing: ${missing[*]}"
  fi
}

count_completed_notary_methods() {
  local completed=0

  if env_present APPLE_API_KEY || env_present APPLE_API_KEY_BASE64 || env_present APPLE_API_KEY_ID || env_present APPLE_API_ISSUER; then
    require_env_group "App Store Connect API key notarization" APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
    completed=$((completed + 1))
  fi

  if env_present APPLE_ID || env_present APPLE_APP_SPECIFIC_PASSWORD || env_present APPLE_TEAM_ID; then
    require_env_group "Apple ID notarization" APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
    completed=$((completed + 1))
  fi

  if env_present APPLE_KEYCHAIN_PROFILE; then
    completed=$((completed + 1))
  fi

  echo "${completed}"
}

prepare_api_key_from_base64() {
  if env_present APPLE_API_KEY || ! env_present APPLE_API_KEY_BASE64; then
    return
  fi

  local key_file
  key_file="$(mktemp "${TMPDIR:-/tmp}/anvil-notary-key.XXXXXX.p8")"
  printf '%s' "${APPLE_API_KEY_BASE64}" | base64 --decode >"${key_file}"
  chmod 600 "${key_file}"
  export APPLE_API_KEY="${key_file}"
  TEMP_APPLE_API_KEY="${key_file}"
}

cleanup() {
  if [[ -n "${TEMP_APPLE_API_KEY:-}" ]]; then
    rm -f "${TEMP_APPLE_API_KEY}"
  fi
}
trap cleanup EXIT

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS signing and notarization must run on macOS."
if [[ "$(uname -m)" != "arm64" && "${ALLOW_NON_ARM64_HOST:-0}" != "1" ]]; then
  fail "This script targets Apple Silicon and expects an arm64 host. Set ALLOW_NON_ARM64_HOST=1 to override."
fi

require_command node
require_command pnpm
require_command xcrun
xcrun --find notarytool >/dev/null || fail "Xcode notarytool is not available. Install/select Xcode 13 or newer."
xcrun --find stapler >/dev/null || fail "Xcode stapler is not available. Install/select Xcode command line tools."

prepare_api_key_from_base64

if env_present APPLE_API_KEY && [[ ! -f "${APPLE_API_KEY}" ]]; then
  fail "APPLE_API_KEY must point to an existing .p8 file."
fi

if env_present CSC_LINK; then
  require_env_group "Developer ID certificate signing" CSC_LINK CSC_KEY_PASSWORD
elif env_present CSC_NAME; then
  :
elif [[ "${ALLOW_SIGNING_AUTO_DISCOVERY:-0}" != "1" ]]; then
  fail "Set CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME. Use ALLOW_SIGNING_AUTO_DISCOVERY=1 only when the intended Developer ID identity is already installed."
fi

if [[ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" == "false" ]]; then
  fail "CSC_IDENTITY_AUTO_DISCOVERY=false disables the signing path needed for notarization. Unset it or set it to true."
fi
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-true}"

notary_method_count="$(count_completed_notary_methods)"
if [[ "${notary_method_count}" -eq 0 ]]; then
  fail "No notarization credentials were provided. Run with --help for the supported environment variables."
fi
if [[ "${notary_method_count}" -gt 1 ]]; then
  fail "Multiple notarization credential strategies are configured. Use exactly one to avoid signing for one team and notarizing with another. Very on-brand, but no."
fi

export ANVIL_BUILD_BRAND="anvil"
export ANVIL_BRAND="anvil"

if [[ ! -d node_modules && "${SKIP_PNPM_INSTALL:-0}" != "1" ]]; then
  info "node_modules is missing; running pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

info "building signed and notarized Anvil macOS arm64 artifacts"
node scripts/dist.mjs \
  --mac dmg zip \
  --arm64 \
  --publish never \
  --brand=anvil \
  -c.forceCodeSigning=true \
  -c.mac.forceCodeSigning=true \
  -c.mac.type=distribution \
  -c.mac.notarize=true

app_path="dist/mac-arm64/Anvil.app"
[[ -d "${app_path}" ]] || fail "Expected notarized app was not found at ${app_path}."

info "validating notarization ticket"
xcrun stapler validate "${app_path}"

info "available artifacts"
find dist -maxdepth 1 -type f \( -name '*arm64*.dmg' -o -name '*arm64*.zip' \) -print
